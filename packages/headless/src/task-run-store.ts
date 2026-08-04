import type { DatabaseSync } from 'node:sqlite';
import type { ExecutionLogCursor } from '@maka/core/execution-evidence';
import { acquireOperationalStateDatabase, type OperationalStateDatabaseLease } from '@maka/storage';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  type StorageRootLease,
} from '@maka/storage/root-authority';
import { chainWrite } from '@maka/storage/write-queue';
import type { TaskEvent } from './task-contracts.js';
import { taskRunLocator } from './task-run-identity.js';
import { projectTaskRun, type TaskRunProjection } from './task-run-projection.js';

export interface TaskRunReader {
  listTaskRunIds(): Promise<string[]>;
  readEventRecords(taskRunId: string): Promise<TaskEventLedgerEntry[]>;
  readEvents(taskRunId: string): Promise<TaskEvent[]>;
  project(taskRunId: string): Promise<TaskRunProjection>;
}

export interface TaskRunWriter extends TaskRunReader {
  appendEvent(taskRunId: string, event: TaskEvent): Promise<void>;
}

export interface TaskEventLedgerEntry {
  event: TaskEvent;
  cursor: ExecutionLogCursor;
}

export function createInMemoryTaskRunStore(
  initialEvents: readonly TaskEvent[] = [],
): TaskRunWriter {
  return new InMemoryTaskRunStore(initialEvents);
}

export async function openHeadlessTaskRunReader(
  lease: StorageRootLease<'headless', 'read'>,
): Promise<TaskRunReader> {
  await assertStorageRootLease(lease, 'headless', 'read');
  return taskRunReaderFacade(new SqliteTaskRunStore(lease.canonicalPath), (operation) =>
    runWithStorageRootLease(lease, 'headless', 'read', operation),
  );
}

export async function openHeadlessTaskRunWriter(
  lease: StorageRootLease<'headless', 'write'>,
): Promise<TaskRunWriter> {
  await assertStorageRootLease(lease, 'headless', 'write');
  return taskRunWriterFacade(new SqliteTaskRunStore(lease.canonicalPath), (operation) =>
    runWithStorageRootLease(lease, 'headless', 'write', operation),
  );
}

type RunTaskRunOperation = <T>(operation: () => Promise<T>) => Promise<T>;

function taskRunReaderFacade(store: SqliteTaskRunStore, run: RunTaskRunOperation): TaskRunReader {
  return Object.freeze(taskRunReaderMethods(store, run));
}

function taskRunReaderMethods(store: SqliteTaskRunStore, run: RunTaskRunOperation): TaskRunReader {
  return {
    listTaskRunIds: () => run(() => store.listTaskRunIds()),
    readEventRecords: (taskRunId) => run(() => store.readEventRecords(taskRunId)),
    readEvents: (taskRunId) => run(() => store.readEvents(taskRunId)),
    project: (taskRunId) => run(() => store.project(taskRunId)),
  };
}

function taskRunWriterFacade(store: SqliteTaskRunStore, run: RunTaskRunOperation): TaskRunWriter {
  return Object.freeze({
    ...taskRunReaderMethods(store, run),
    appendEvent: (taskRunId: string, event: TaskEvent) =>
      run(() => store.appendEvent(taskRunId, event)),
  });
}

class InMemoryTaskRunStore implements TaskRunWriter {
  private readonly events = new Map<string, TaskEvent[]>();
  private readonly queues = new Map<string, Promise<void>>();

  constructor(initialEvents: readonly TaskEvent[]) {
    for (const event of initialEvents) {
      const events = this.events.get(event.taskRunId) ?? [];
      events.push(event);
      this.events.set(event.taskRunId, events);
    }
  }

  async appendEvent(taskRunId: string, event: TaskEvent): Promise<void> {
    assertTaskRunEventIdentity(taskRunId, event);
    await chainWrite(this.queues, taskRunId, async () => {
      const events = this.events.get(taskRunId) ?? [];
      events.push(event);
      this.events.set(taskRunId, events);
    });
  }

  async listTaskRunIds(): Promise<string[]> {
    return [...this.events.keys()].sort();
  }

  async readEvents(taskRunId: string): Promise<TaskEvent[]> {
    return (await this.readEventRecords(taskRunId)).map((record) => record.event);
  }

  async readEventRecords(taskRunId: string): Promise<TaskEventLedgerEntry[]> {
    return (this.events.get(taskRunId) ?? []).map((event, sequence) => ({
      event,
      cursor: taskEventCursor(taskRunId, sequence, event.id),
    }));
  }

  async project(taskRunId: string): Promise<TaskRunProjection> {
    return projectTaskRun(await this.readEvents(taskRunId), taskRunId);
  }
}

class SqliteTaskRunStore implements TaskRunWriter {
  constructor(private readonly storageRoot: string) {}

  async appendEvent(taskRunId: string, event: TaskEvent): Promise<void> {
    assertTaskRunEventIdentity(taskRunId, event);
    this.withDatabase((lease) =>
      lease.transaction('write', () => {
        const row = lease.database
          .prepare(`
            SELECT COALESCE(MAX(sequence), -1) AS lastSequence
            FROM headless_task_run_events
            WHERE task_run_id = ?
          `)
          .get(taskRunId) as { lastSequence?: unknown };
        if (
          typeof row.lastSequence !== 'number' ||
          !Number.isSafeInteger(row.lastSequence) ||
          row.lastSequence < -1
        ) {
          throw new Error(`Invalid TaskRun sequence for ${taskRunId}`);
        }
        lease.database
          .prepare(`
            INSERT INTO headless_task_run_events(
              task_run_id, sequence, event_id, record_json
            ) VALUES (?, ?, ?, ?)
          `)
          .run(taskRunId, row.lastSequence + 1, event.id, JSON.stringify(event));
      }),
    );
  }

  async listTaskRunIds(): Promise<string[]> {
    return this.withDatabase((lease) =>
      (
        lease.database
          .prepare(`
            SELECT DISTINCT task_run_id AS taskRunId
            FROM headless_task_run_events
            ORDER BY task_run_id
          `)
          .all() as Array<{ taskRunId: string }>
      ).map((row) => row.taskRunId),
    );
  }

  async readEvents(taskRunId: string): Promise<TaskEvent[]> {
    return (await this.readEventRecords(taskRunId)).map((record) => record.event);
  }

  async readEventRecords(taskRunId: string): Promise<TaskEventLedgerEntry[]> {
    taskRunLocator(taskRunId);
    return this.withDatabase((lease) =>
      readTaskRunRows(lease.database, taskRunId).map((row) => {
        const event = decodeTaskEvent(row.recordJson, taskRunId);
        if (event.id !== row.eventId) {
          throw new Error(`TaskRun ${taskRunId} event identity does not match SQLite metadata`);
        }
        return {
          event,
          cursor: taskEventCursor(taskRunId, row.sequence, event.id),
        };
      }),
    );
  }

  async project(taskRunId: string): Promise<TaskRunProjection> {
    return projectTaskRun(await this.readEvents(taskRunId), taskRunId);
  }

  private withDatabase<T>(operation: (lease: OperationalStateDatabaseLease) => T): T {
    const lease = acquireOperationalStateDatabase(this.storageRoot);
    try {
      return operation(lease);
    } finally {
      lease.close();
    }
  }
}

interface TaskRunEventRow {
  sequence: number;
  eventId: string;
  recordJson: string;
}

function readTaskRunRows(database: DatabaseSync, taskRunId: string): TaskRunEventRow[] {
  return database
    .prepare(`
      SELECT sequence, event_id AS eventId, record_json AS recordJson
      FROM headless_task_run_events
      WHERE task_run_id = ?
      ORDER BY sequence
    `)
    .all(taskRunId) as unknown as TaskRunEventRow[];
}

function decodeTaskEvent(recordJson: string, taskRunId: string): TaskEvent {
  const event = JSON.parse(recordJson) as TaskEvent;
  assertTaskRunEventIdentity(taskRunId, event);
  return event;
}

function assertTaskRunEventIdentity(taskRunId: string, event: TaskEvent): void {
  taskRunLocator(taskRunId);
  if (event.taskRunId !== taskRunId) {
    throw new Error(`taskRunId mismatch: append target ${taskRunId}, event ${event.taskRunId}`);
  }
}

function taskEventCursor(taskRunId: string, sequence: number, eventId: string): ExecutionLogCursor {
  return { ledger: 'task_event', streamId: taskRunId, sequence, eventId };
}
