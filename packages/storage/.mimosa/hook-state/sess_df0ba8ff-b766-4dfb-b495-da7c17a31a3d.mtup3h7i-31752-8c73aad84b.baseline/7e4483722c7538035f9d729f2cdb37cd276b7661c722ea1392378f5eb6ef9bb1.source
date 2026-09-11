/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import {
  compareScheduledTasksForList,
  computeNextFireAt,
  decodePersistedScheduledTask,
  isScheduledTaskDue,
  nextScheduledTaskStateAfterFire,
  normalizeCreateScheduledTaskInput,
  normalizeUpdateScheduledTaskInput,
  pauseScheduledTask,
  resumeScheduledTask,
  SCHEDULED_TASK_RUN_MESSAGE_MAX_CHARS,
  type ScheduledTask,
  type ScheduledTaskRun,
  type ScheduledTaskSchedule,
} from '@maka/core/scheduled-task';
import { markPersisted } from '@maka/core/persisted-value';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';
import {
  assertStorageRootLease,
  runWithStorageRootLease,
  StorageRootAuthorityError,
  type StorageRootLease,
} from './root-authority.js';

const writerBrand: unique symbol = Symbol('InteractiveScheduledTaskStoreWriter');
const writers = new WeakSet<object>();
const writerByLease = new WeakMap<object, InteractiveScheduledTaskStoreWriter>();
const writerOpeningByLease = new WeakMap<object, Promise<InteractiveScheduledTaskStoreWriter>>();

export type ScheduledTaskStoreErrorCode = 'invalid_input' | 'not_found' | 'operation_conflict';

export class ScheduledTaskStoreError extends Error {
  constructor(
    readonly code: ScheduledTaskStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ScheduledTaskStoreError';
  }
}

interface ScheduledTaskStore {
  list(): Promise<ScheduledTask[]>;
  get(id: string): Promise<ScheduledTask | undefined>;
  create(input: unknown, now?: number): Promise<ScheduledTask>;
  update(id: string, patch: unknown, now?: number): Promise<ScheduledTask>;
  pause(id: string, now?: number): Promise<ScheduledTask>;
  resume(id: string, now?: number): Promise<ScheduledTask>;
  snooze(id: string, delayMs: number, now?: number): Promise<ScheduledTask>;
  clearRunHistory(id: string, now?: number): Promise<ScheduledTask>;
  remove(id: string): Promise<void>;
  claimNextDue(now?: number): Promise<ScheduledTaskDueScan>;
  claimNow(id: string, now?: number): Promise<ScheduledTaskFireClaim>;
  listPendingFires(): Promise<ScheduledTaskFireClaim[]>;
  bindFireExecution(
    claimId: string,
    execution: ScheduledTaskFireExecution,
  ): Promise<ScheduledTaskFireClaim>;
  setFireNativeState(
    claimId: string,
    state: ScheduledTaskNativeFireState,
  ): Promise<ScheduledTaskFireClaim>;
  cancelWaitingNativeFire(taskId: string): Promise<boolean>;
  settleFire(
    claimId: string,
    run: Omit<ScheduledTaskRun, 'id'> & { id?: string },
  ): Promise<ScheduledTask>;
  ready(): Promise<void>;
  close(): void;
}

export interface ScheduledTaskFireClaim {
  id: string;
  taskId: string;
  scheduledFor: number;
  claimedAt: number;
  task: ScheduledTask;
  execution?: ScheduledTaskFireExecution;
  nativeState?: ScheduledTaskNativeFireState;
}

export interface ScheduledTaskDueScan {
  readonly claim: ScheduledTaskFireClaim | null;
  readonly expired: readonly ScheduledTask[];
}

export type ScheduledTaskNativeFireState = 'waiting_for_provider' | 'invoking';

export interface ScheduledTaskFireExecution {
  sessionId: string;
  turnId: string;
  runId: string;
  userMessageId: string;
}

export interface InteractiveScheduledTaskStoreWriter extends ScheduledTaskStore {
  readonly kind: 'interactive';
  readonly access: 'write';
  readonly [writerBrand]: true;
}

export function authenticateInteractiveScheduledTaskStoreWriter(
  writer: InteractiveScheduledTaskStoreWriter,
): InteractiveScheduledTaskStoreWriter {
  if (!writers.has(writer)) {
    throw new StorageRootAuthorityError(
      'invalid_lease',
      'Expected an authentic interactive ScheduledTask Store writer',
    );
  }
  return writer;
}

export async function openInteractiveScheduledTaskStoreForWrite(
  lease: StorageRootLease<'interactive', 'write'>,
): Promise<InteractiveScheduledTaskStoreWriter> {
  await assertStorageRootLease(lease, 'interactive', 'write');
  const existing = writerByLease.get(lease);
  if (existing) return existing;
  const opening = writerOpeningByLease.get(lease);
  if (opening) return opening;
  const pending = Promise.resolve().then(async () => {
    let store: ScheduledTaskStore | undefined;
    try {
      store = await runWithStorageRootLease(lease, 'interactive', 'write', async (root) => {
        const opened = new SqliteScheduledTaskStore(root);
        await opened.ready();
        return opened;
      });
      await assertStorageRootLease(lease, 'interactive', 'write');
      const raced = writerByLease.get(lease);
      if (raced) {
        store.close();
        return raced;
      }
      const writer = createWriterFacade(lease, store);
      writers.add(writer);
      writerByLease.set(lease, writer);
      return writer;
    } catch (error) {
      store?.close();
      throw error;
    }
  });
  writerOpeningByLease.set(lease, pending);
  try {
    return await pending;
  } finally {
    if (writerOpeningByLease.get(lease) === pending) writerOpeningByLease.delete(lease);
  }
}

function createWriterFacade(
  lease: StorageRootLease<'interactive', 'write'>,
  store: ScheduledTaskStore,
): InteractiveScheduledTaskStoreWriter {
  let closed = false;
  const run = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(
        new StorageRootAuthorityError('invalid_lease', 'ScheduledTask Store writer is closed'),
      );
    }
    return runWithStorageRootLease(lease, 'interactive', 'write', operation);
  };
  const writer: InteractiveScheduledTaskStoreWriter = {
    kind: 'interactive',
    access: 'write',
    [writerBrand]: true,
    list: () => run(() => store.list()),
    get: (id) => run(() => store.get(id)),
    create: (input, now) => run(() => store.create(input, now)),
    update: (id, patch, now) => run(() => store.update(id, patch, now)),
    pause: (id, now) => run(() => store.pause(id, now)),
    resume: (id, now) => run(() => store.resume(id, now)),
    snooze: (id, delayMs, now) => run(() => store.snooze(id, delayMs, now)),
    clearRunHistory: (id, now) => run(() => store.clearRunHistory(id, now)),
    remove: (id) => run(() => store.remove(id)),
    claimNextDue: (now) => run(() => store.claimNextDue(now)),
    claimNow: (id, now) => run(() => store.claimNow(id, now)),
    listPendingFires: () => run(() => store.listPendingFires()),
    bindFireExecution: (claimId, execution) =>
      run(() => store.bindFireExecution(claimId, execution)),
    setFireNativeState: (claimId, state) => run(() => store.setFireNativeState(claimId, state)),
    cancelWaitingNativeFire: (taskId) => run(() => store.cancelWaitingNativeFire(taskId)),
    settleFire: (claimId, record) => run(() => store.settleFire(claimId, record)),
    ready: () => run(() => store.ready()),
    close: () => {
      if (closed) return;
      closed = true;
      if (writerByLease.get(lease) === writer) writerByLease.delete(lease);
      writers.delete(writer);
      store.close();
    },
  };
  return Object.freeze(writer);
}

class SqliteScheduledTaskStore implements ScheduledTaskStore {
  readonly #lease: OperationalStateDatabaseLease;
  private queue: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(resolve(workspaceRoot));
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  close(): void {
    this.#lease.close();
  }

  async list(): Promise<ScheduledTask[]> {
    return this.readTasks().sort(compareScheduledTasksForList);
  }

  async get(id: string): Promise<ScheduledTask | undefined> {
    return this.readTask(id);
  }

  async create(input: unknown, now = Date.now()): Promise<ScheduledTask> {
    const normalized = normalizeCreateScheduledTaskInput(input, now);
    if (!normalized.ok) throw storeError('invalid_input', normalized.message);
    const value = normalized.value;
    const task: ScheduledTask = {
      id: randomUUID(),
      title: value.title,
      intent: { kind: 'text', body: value.intentBody },
      schedule: value.schedule,
      effect: value.effect,
      status: 'active',
      nextFireAt: value.nextFireAt,
      lastFireAt: null,
      fireCount: 0,
      maxFires: value.maxFires ?? null,
      expiresAt: value.expiresAt ?? null,
      createdBy: value.createdBy,
      createdAt: now,
      updatedAt: now,
      runs: [],
      lastError: null,
    };
    await this.enqueueWrite(() => {
      this.#lease.database
        .prepare(`
          INSERT INTO workflow_scheduled_tasks(task_id, created_at, updated_at, record_json)
          VALUES (?, ?, ?, ?)
        `)
        .run(task.id, task.createdAt, task.updatedAt, JSON.stringify(task));
    });
    return task;
  }

  async update(id: string, patch: unknown, now = Date.now()): Promise<ScheduledTask> {
    const normalized = normalizeUpdateScheduledTaskInput(patch, now);
    if (!normalized.ok) throw storeError('invalid_input', normalized.message);
    return this.updateTask(id, (task) => {
      if (task.status === 'completed' || task.status === 'expired') {
        throw storeError('operation_conflict', 'Cannot update a terminal scheduled task');
      }
      const schedule = normalized.value.schedule ?? task.schedule;
      const nextFireAt = task.status === 'active' ? computeRequiredNext(schedule, now) : null;
      const effect = normalized.value.effect ?? task.effect;
      const intentBody = normalized.value.intentBody ?? task.intent.body;
      const expiresAt = Object.prototype.hasOwnProperty.call(normalized.value, 'expiresAt')
        ? (normalized.value.expiresAt ?? null)
        : task.expiresAt;
      const maxFires = Object.prototype.hasOwnProperty.call(normalized.value, 'maxFires')
        ? (normalized.value.maxFires ?? null)
        : task.maxFires;
      if (effect.kind !== 'notify' && !intentBody.trim()) {
        throw storeError('invalid_input', 'Agent intent body is required');
      }
      if (maxFires !== null && maxFires <= task.fireCount) {
        throw storeError(
          'operation_conflict',
          'maxFires must be greater than the current fireCount',
        );
      }
      if (nextFireAt !== null && expiresAt !== null && nextFireAt >= expiresAt) {
        throw storeError('invalid_input', 'Schedule must fire before expiresAt');
      }
      return {
        ...task,
        ...(normalized.value.title !== undefined ? { title: normalized.value.title } : {}),
        ...(normalized.value.intentBody !== undefined
          ? { intent: { kind: 'text', body: normalized.value.intentBody } }
          : {}),
        schedule,
        effect,
        ...(Object.prototype.hasOwnProperty.call(normalized.value, 'maxFires') ? { maxFires } : {}),
        expiresAt,
        nextFireAt,
        updatedAt: now,
      };
    });
  }

  async pause(id: string, now = Date.now()): Promise<ScheduledTask> {
    return this.updateTask(id, (task) => pauseScheduledTask(task, now));
  }

  async resume(id: string, now = Date.now()): Promise<ScheduledTask> {
    return this.updateTask(id, (task) => {
      const result = resumeScheduledTask(task, now);
      if ('error' in result) throw storeError('operation_conflict', result.error);
      if (
        result.nextFireAt !== null &&
        result.expiresAt !== null &&
        result.nextFireAt >= result.expiresAt
      ) {
        throw storeError('invalid_input', 'Schedule must fire before expiresAt');
      }
      return result;
    });
  }

  async snooze(id: string, delayMs: number, now = Date.now()): Promise<ScheduledTask> {
    if (!Number.isFinite(delayMs) || delayMs <= 0 || delayMs > 7 * 24 * 60 * 60 * 1000) {
      throw storeError(
        'invalid_input',
        'Scheduled task snooze delay must be between 1 ms and 7 days',
      );
    }
    return this.updateTask(id, (task) => {
      if (task.status !== 'active' || task.nextFireAt === null) {
        throw storeError('operation_conflict', 'Only active scheduled tasks can be snoozed');
      }
      const nextFireAt = Math.max(now, task.nextFireAt) + Math.floor(delayMs);
      if (task.expiresAt !== null && nextFireAt >= task.expiresAt) {
        throw storeError('invalid_input', 'Snooze would move the task beyond expiresAt');
      }
      return { ...task, nextFireAt, updatedAt: now };
    });
  }

  async clearRunHistory(id: string, now = Date.now()): Promise<ScheduledTask> {
    return this.updateTask(id, (task) => ({
      ...task,
      runs: [],
      lastError: null,
      updatedAt: now,
    }));
  }

  async remove(id: string): Promise<void> {
    await this.enqueueWrite(() => {
      this.assertNoPendingClaim(id);
      this.requireTask(id);
      this.#lease.database
        .prepare('DELETE FROM workflow_scheduled_tasks WHERE task_id = ?')
        .run(id);
    });
  }

  async claimNextDue(now = Date.now()): Promise<ScheduledTaskDueScan> {
    return this.enqueueWrite(() => {
      // Due discovery still traverses the catalog to return every newly expired
      // task. Only claim keys are needed, and only changed rows are written.
      const claimRows = this.#lease.database
        .prepare('SELECT task_id FROM workflow_scheduled_task_fires')
        .all() as Array<{ task_id: string }>;
      const claimedTaskIds = new Set(claimRows.map((row) => row.task_id));
      const expired: ScheduledTask[] = [];
      const tasks = this.readTasks().map((task) => {
        if (task.status === 'active' && task.expiresAt !== null && now >= task.expiresAt) {
          const next = { ...task, status: 'expired' as const, nextFireAt: null, updatedAt: now };
          expired.push(next);
          this.writeTask(next);
          return next;
        }
        return task;
      });
      const task = tasks
        .filter((entry) => isScheduledTaskDue(entry, now) && !claimedTaskIds.has(entry.id))
        .sort(
          (left, right) => left.nextFireAt! - right.nextFireAt! || left.id.localeCompare(right.id),
        )[0];
      const claim = task ? createClaim(task, task.nextFireAt!, now) : null;
      if (claim) this.insertClaim(claim);
      return { claim, expired };
    });
  }

  async claimNow(id: string, now = Date.now()): Promise<ScheduledTaskFireClaim> {
    return this.enqueueWrite(() => {
      const task = this.requireTask(id);
      this.assertNoPendingClaim(id);
      if (task.status !== 'active') {
        throw storeError('operation_conflict', 'Only active tasks can be triggered now');
      }
      if (task.expiresAt !== null && now >= task.expiresAt) {
        throw storeError('operation_conflict', 'Scheduled task has expired');
      }
      const claim = createClaim(task, now, now);
      this.insertClaim(claim);
      return claim;
    });
  }

  async listPendingFires(): Promise<ScheduledTaskFireClaim[]> {
    const rows = this.#lease.database
      .prepare(`
        SELECT record_json
        FROM workflow_scheduled_task_fires
        ORDER BY claimed_at, claim_id
      `)
      .all() as Array<{ record_json?: unknown }>;
    return rows.map((row, index) => decodeClaimRow(row, `row ${index + 1}`));
  }

  async bindFireExecution(
    claimId: string,
    execution: ScheduledTaskFireExecution,
  ): Promise<ScheduledTaskFireClaim> {
    return this.updateClaim(claimId, (claim) => {
      if (claim.task.effect.kind === 'notify') {
        throw storeError(
          'operation_conflict',
          `Scheduled task fire ${claimId} is not an Agent execution`,
        );
      }
      if (claim.execution) {
        if (!sameExecution(claim.execution, execution)) {
          throw storeError(
            'operation_conflict',
            `Scheduled task fire ${claimId} already has another execution`,
          );
        }
        return claim;
      }
      return { ...claim, execution: { ...execution } };
    });
  }

  async setFireNativeState(
    claimId: string,
    nativeState: ScheduledTaskNativeFireState,
  ): Promise<ScheduledTaskFireClaim> {
    return this.updateClaim(claimId, (claim) => {
      if (claim.task.effect.kind !== 'notify') {
        throw storeError(
          'operation_conflict',
          `Scheduled task fire ${claimId} is not a native effect`,
        );
      }
      if (claim.nativeState === 'invoking' && nativeState !== 'invoking') {
        throw storeError(
          'operation_conflict',
          `Scheduled task fire ${claimId} already crossed delivery admission`,
        );
      }
      return claim.nativeState === nativeState ? claim : { ...claim, nativeState };
    });
  }

  async cancelWaitingNativeFire(taskId: string): Promise<boolean> {
    return this.enqueueWrite(() => {
      const row = this.#lease.database
        .prepare('SELECT record_json FROM workflow_scheduled_task_fires WHERE task_id = ?')
        .get(taskId) as { record_json?: unknown } | undefined;
      if (!row) return false;
      const claim = decodeClaimRow(row, `task ${taskId}`);
      if (claim.nativeState !== 'waiting_for_provider') {
        throw storeError('operation_conflict', 'Scheduled task has a fire in progress');
      }
      this.#lease.database
        .prepare('DELETE FROM workflow_scheduled_task_fires WHERE task_id = ?')
        .run(taskId);
      return true;
    });
  }

  async settleFire(
    claimId: string,
    run: Omit<ScheduledTaskRun, 'id'> & { id?: string },
  ): Promise<ScheduledTask> {
    return this.enqueueWrite(() => {
      const claim = this.readClaim(claimId);
      if (!claim) throw new Error(`No such scheduled task fire claim: ${claimId}`);
      const task = this.readTask(claim.taskId);
      if (!task) throw new Error(`No such scheduled task: claim ${claimId}`);
      const record: ScheduledTaskRun = {
        id: run.id ?? randomUUID(),
        at: run.at,
        outcome: run.outcome,
        message: [...run.message].slice(0, SCHEDULED_TASK_RUN_MESSAGE_MAX_CHARS).join(''),
        ...(run.sessionId ? { sessionId: run.sessionId } : {}),
        ...(run.runId ? { runId: run.runId } : {}),
      };
      const updated = nextScheduledTaskStateAfterFire(task, record);
      this.writeTask(updated);
      this.#lease.database
        .prepare('DELETE FROM workflow_scheduled_task_fires WHERE claim_id = ?')
        .run(claimId);
      return updated;
    });
  }

  private readTasks(): ScheduledTask[] {
    const rows = this.#lease.database
      .prepare(`
        SELECT task_id, record_json
        FROM workflow_scheduled_tasks
        ORDER BY created_at, task_id
      `)
      .all() as Array<{ task_id: string; record_json?: unknown }>;
    return rows.map((row, index) => decodeTaskRow(row, `row ${index + 1}`));
  }

  private readTask(id: string): ScheduledTask | undefined {
    const row = this.#lease.database
      .prepare('SELECT task_id, record_json FROM workflow_scheduled_tasks WHERE task_id = ?')
      .get(id) as { task_id: string; record_json?: unknown } | undefined;
    if (!row) return undefined;
    return decodeTaskRow(row, `task ${id}`);
  }

  private requireTask(id: string): ScheduledTask {
    const task = this.readTask(id);
    if (!task) throw storeError('not_found', `No such scheduled task: ${id}`);
    return task;
  }

  private readClaim(id: string): ScheduledTaskFireClaim | undefined {
    const row = this.#lease.database
      .prepare('SELECT record_json FROM workflow_scheduled_task_fires WHERE claim_id = ?')
      .get(id) as { record_json?: unknown } | undefined;
    if (!row) return undefined;
    const claim = decodeClaimRow(row, `claim ${id}`);
    if (claim.id !== id) throw new Error(`Invalid scheduled task fire claim identity: ${id}`);
    return claim;
  }

  private assertNoPendingClaim(taskId: string): void {
    const pending = this.#lease.database
      .prepare('SELECT 1 FROM workflow_scheduled_task_fires WHERE task_id = ?')
      .get(taskId);
    if (pending) {
      throw storeError('operation_conflict', 'Scheduled task has a fire in progress');
    }
  }

  private updateTask(
    id: string,
    update: (task: ScheduledTask) => ScheduledTask,
  ): Promise<ScheduledTask> {
    return this.enqueueWrite(() => {
      const task = this.requireTask(id);
      this.assertNoPendingClaim(id);
      const updated = update(task);
      if (updated !== task) this.writeTask(updated);
      return updated;
    });
  }

  private updateClaim(
    id: string,
    update: (claim: ScheduledTaskFireClaim) => ScheduledTaskFireClaim,
  ): Promise<ScheduledTaskFireClaim> {
    return this.enqueueWrite(() => {
      const claim = this.readClaim(id);
      if (!claim) throw storeError('not_found', `No such scheduled task fire claim: ${id}`);
      const updated = update(claim);
      if (updated !== claim) {
        this.#lease.database
          .prepare('UPDATE workflow_scheduled_task_fires SET record_json = ? WHERE claim_id = ?')
          .run(JSON.stringify(updated), id);
      }
      return structuredClone(updated);
    });
  }

  private writeTask(task: ScheduledTask): void {
    this.#lease.database
      .prepare(
        'UPDATE workflow_scheduled_tasks SET updated_at = ?, record_json = ? WHERE task_id = ?',
      )
      .run(task.updatedAt, JSON.stringify(task), task.id);
  }

  private insertClaim(claim: ScheduledTaskFireClaim): void {
    this.#lease.database
      .prepare(`
        INSERT INTO workflow_scheduled_task_fires(claim_id, task_id, claimed_at, record_json)
        VALUES (?, ?, ?, ?)
      `)
      .run(claim.id, claim.taskId, claim.claimedAt, JSON.stringify(claim));
  }

  private enqueueWrite<T>(operation: () => T): Promise<T> {
    const run = () => this.#lease.transaction('write', operation);
    const next = this.queue.then(run, run);
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }
}

function decodeTaskRow(
  row: { task_id: string; record_json?: unknown },
  location: string,
): ScheduledTask {
  if (typeof row.record_json !== 'string') {
    throw new Error(`Invalid scheduled task at ${location}`);
  }
  const task = decodePersistedScheduledTask(
    markPersisted<ScheduledTask>(JSON.parse(row.record_json)),
  );
  if (task.id !== row.task_id) throw new Error(`Invalid scheduled task identity: ${row.task_id}`);
  return task;
}

function decodeClaimRow(row: { record_json?: unknown }, location: string): ScheduledTaskFireClaim {
  if (typeof row.record_json !== 'string') {
    throw new Error(`Invalid scheduled task fire claim at ${location}`);
  }
  const claim = JSON.parse(row.record_json) as ScheduledTaskFireClaim;
  return {
    ...claim,
    task: decodePersistedScheduledTask(markPersisted<ScheduledTask>(claim.task)),
  };
}

function computeRequiredNext(schedule: ScheduledTaskSchedule, now: number): number {
  const next = computeNextFireAt(schedule, now);
  if (next === null) {
    throw storeError('invalid_input', 'Schedule has no fire within one year');
  }
  return next;
}

function createClaim(
  task: ScheduledTask,
  scheduledFor: number,
  claimedAt: number,
): ScheduledTaskFireClaim {
  return {
    id: randomUUID(),
    taskId: task.id,
    scheduledFor,
    claimedAt,
    task: structuredClone(task),
  };
}

function storeError(code: ScheduledTaskStoreErrorCode, message: string): ScheduledTaskStoreError {
  return new ScheduledTaskStoreError(code, message);
}

function sameExecution(
  left: ScheduledTaskFireExecution,
  right: ScheduledTaskFireExecution,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.turnId === right.turnId &&
    left.runId === right.runId &&
    left.userMessageId === right.userMessageId
  );
}
