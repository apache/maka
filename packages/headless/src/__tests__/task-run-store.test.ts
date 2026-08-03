import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import {
  createHeadlessRootLease,
  resolveStorageRoot,
  StorageRootAuthorityError,
  tryAcquireInteractiveRootOwner,
  type StorageRootLease,
} from '@maka/storage/root-authority';
import type { TaskEvent } from '../task-contracts.js';
import {
  createInMemoryTaskRunStore,
  openHeadlessTaskRunReader,
  openHeadlessTaskRunWriter,
} from '../task-run-store.js';

const taskRunWriterProcessPath = fileURLToPath(
  new URL('./fixtures/task-run-writer-process.js', import.meta.url),
);

function eventIdFactory(): () => string {
  let i = 0;
  return () => `e-${++i}`;
}

function completedEvents(taskRunId = 'tr-1', taskId = 'task-1', configId = 'cfg-1'): TaskEvent[] {
  const id = eventIdFactory();
  return [
    { type: 'task_run_created', id: id(), taskRunId, ts: 10, taskId, configId },
    {
      type: 'task_run_started',
      id: id(),
      taskRunId,
      ts: 11,
      startedAt: 11,
      sessionId: 's-1',
      agentRunId: 'r-1',
    },
    {
      type: 'task_attempt_started',
      id: id(),
      taskRunId,
      ts: 12,
      attemptId: 'a-1',
      sessionId: 's-1',
      agentRunId: 'r-1',
    },
    {
      type: 'self_check_observed',
      id: id(),
      taskRunId,
      ts: 13,
      observation: { id: 'self-1', taskRunId, attemptId: 'a-1', ts: 13, summary: 'looks solved' },
    },
    {
      type: 'feedback_observed',
      id: id(),
      taskRunId,
      ts: 14,
      observation: {
        id: 'fb-1',
        taskRunId,
        attemptId: 'a-1',
        ts: 14,
        source: 'verifier',
        summary: 'tests passed',
      },
    },
    {
      type: 'autonomous_decision_recorded',
      id: id(),
      taskRunId,
      ts: 15,
      decision: {
        id: 'd-1',
        taskRunId,
        attemptId: 'a-1',
        ts: 15,
        decision: 'stop',
        reason: 'verification passed',
      },
    },
    {
      type: 'verifier_result_recorded',
      id: id(),
      taskRunId,
      ts: 20,
      result: {
        id: 'v-1',
        taskRunId,
        attemptId: 'a-1',
        ts: 20,
        kind: 'command',
        passed: true,
        exitCode: 0,
      },
    },
    {
      type: 'score_result_recorded',
      id: id(),
      taskRunId,
      ts: 21,
      result: {
        id: 'score-1',
        taskRunId,
        attemptId: 'a-1',
        ts: 21,
        passed: true,
        taxonomy: 'passed',
      },
    },
    {
      type: 'task_attempt_completed',
      id: id(),
      taskRunId,
      ts: 22,
      attemptId: 'a-1',
      finishedAt: 22,
      status: 'completed',
    },
    { type: 'task_run_completed', id: id(), taskRunId, ts: 23, finishedAt: 23 },
  ];
}

describe('TaskRunStore', () => {
  test('binds SQLite readers and writers to Headless leases', async () => {
    const base = await mkdtemp(join(tmpdir(), 'maka-task-run-lease-'));
    const headlessRoot = join(base, 'headless');
    const interactiveRoot = join(base, 'interactive');
    try {
      const capability = await resolveStorageRoot({ path: headlessRoot, kind: 'headless' });
      const writer = await openHeadlessTaskRunWriter(createHeadlessRootLease(capability, 'write'));
      const event = completedEvents('leased-run')[0]!;
      await writer.appendEvent('leased-run', event);

      const reader = await openHeadlessTaskRunReader(createHeadlessRootLease(capability, 'read'));
      assert.equal('appendEvent' in reader, false);
      assert.deepEqual(await reader.readEvents('leased-run'), [event]);
      assert.deepEqual(await reader.listTaskRunIds(), ['leased-run']);

      const interactive = await resolveStorageRoot({ path: interactiveRoot, kind: 'interactive' });
      const owner = await tryAcquireInteractiveRootOwner(interactive);
      assert.ok(owner);
      try {
        await assert.rejects(
          () =>
            openHeadlessTaskRunWriter(
              owner.lease as unknown as StorageRootLease<'headless', 'write'>,
            ),
          (error: unknown) =>
            error instanceof StorageRootAuthorityError && error.code === 'invalid_lease',
        );
        await assert.rejects(() => lstat(join(interactiveRoot, 'runtime.sqlite')), {
          code: 'ENOENT',
        });
      } finally {
        await owner.close();
      }
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test('appends and replays events in order', async () => {
    const store = createInMemoryTaskRunStore();
    const events = completedEvents();
    for (const event of events) await store.appendEvent(event.taskRunId, event);

    assert.deepEqual(await store.readEvents('tr-1'), events);
    assert.deepEqual(
      (await store.readEventRecords('tr-1')).slice(0, 2).map((record) => record.cursor),
      [
        { ledger: 'task_event', streamId: 'tr-1', sequence: 0, eventId: 'e-1' },
        { ledger: 'task_event', streamId: 'tr-1', sequence: 1, eventId: 'e-2' },
      ],
    );
  });

  test('serializes concurrent appends for one task run', async () => {
    const store = createInMemoryTaskRunStore();
    const events = completedEvents('tr-concurrent');

    await Promise.all(events.map((event) => store.appendEvent('tr-concurrent', event)));

    assert.deepEqual(await store.readEvents('tr-concurrent'), events);
  });

  test('SQLite store appends and replays events after restart', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'maka-task-run-store-'));
    try {
      const store = await openSqliteTaskRunWriter(storageRoot);
      const events = completedEvents('tr-sqlite');
      for (const event of events) await store.appendEvent(event.taskRunId, event);

      const restarted = await openSqliteTaskRunReader(storageRoot);
      assert.deepEqual(await restarted.readEvents('tr-sqlite'), events);
      assert.equal((await restarted.project('tr-sqlite')).status, 'completed');
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  test('atomically publishes the first ledger across independent writers', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'maka-task-run-store-'));
    try {
      const first = await openSqliteTaskRunWriter(storageRoot);
      const second = await openSqliteTaskRunWriter(storageRoot);
      const taskRunId = 'concurrent-first-write';
      const firstEvent = completedEvents(taskRunId)[0]!;
      const secondEvent: TaskEvent = {
        type: 'task_run_queued',
        id: 'queued-concurrently',
        taskRunId,
        taskId: 'task-1',
        configId: 'cfg-1',
        ts: 11,
      };

      await Promise.all([
        first.appendEvent(taskRunId, firstEvent),
        second.appendEvent(taskRunId, secondEvent),
      ]);

      const reader = await openSqliteTaskRunReader(storageRoot);
      assert.deepEqual(
        (await reader.readEvents(taskRunId)).map((event) => event.id).sort(),
        [firstEvent.id, secondEvent.id].sort(),
      );
      assert.deepEqual(await reader.listTaskRunIds(), [taskRunId]);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  test('serializes appends across independent processes', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'maka-task-run-store-'));
    const children: ChildProcess[] = [];
    try {
      const taskRunId = 'concurrent-process-write';
      const writer = await openSqliteTaskRunWriter(storageRoot);
      await writer.appendEvent(taskRunId, completedEvents(taskRunId)[0]!);

      const events: TaskEvent[] = ['first', 'second'].map((instruction, index) => ({
        type: 'task_run_queued',
        id: `process-${index + 1}`,
        taskRunId,
        taskId: `task-${index + 1}`,
        configId: 'cfg-1',
        ts: index + 2,
        taskDefinition: {
          id: `task-${index + 1}`,
          instruction,
          workspaceDir: '.',
          verification: { command: 'true', protectedPaths: [] },
        },
      }));
      const eventPaths = events.map((_, index) => join(storageRoot, `event-${index + 1}.json`));
      await Promise.all(
        events.map((event, index) => writeFile(eventPaths[index]!, JSON.stringify(event), 'utf8')),
      );

      const writers = eventPaths.map((eventPath) =>
        prepareTaskRunWriterProcess(storageRoot, eventPath),
      );
      children.push(...writers.map((prepared) => prepared.child));
      await Promise.all(writers.map((prepared) => prepared.ready));
      await Promise.all(writers.map((prepared) => prepared.append()));

      const reader = await openSqliteTaskRunReader(storageRoot);
      const replayed = await reader.readEvents(taskRunId);
      assert.deepEqual(
        replayed
          .slice(1)
          .map((event) => ({
            id: event.id,
            instruction:
              event.type === 'task_run_queued' ? event.taskDefinition?.instruction : undefined,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        events.map((event) => ({
          id: event.id,
          instruction:
            event.type === 'task_run_queued' ? event.taskDefinition?.instruction : undefined,
        })),
      );
      assert.deepEqual(await reader.listTaskRunIds(), [taskRunId]);
    } finally {
      await Promise.all(children.map(terminateChildProcess));
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  test('keeps distinct task run identities separate', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'maka-task-run-store-'));
    try {
      const store = await openSqliteTaskRunWriter(storageRoot);
      const first = completedEvents('run/a', 'slash-task', 'slash-config')[0]!;
      const second = completedEvents('run?a', 'question-task', 'question-config')[0]!;
      await store.appendEvent('run/a', first);
      await store.appendEvent('run?a', second);

      assert.deepEqual(await store.listTaskRunIds(), ['run/a', 'run?a']);
      assert.deepEqual(await store.readEvents('run/a'), [first]);
      assert.deepEqual(await store.readEvents('run?a'), [second]);
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });

  test('rejects invalid task run and event identities before writing', async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), 'maka-task-run-store-'));
    try {
      const store = await openSqliteTaskRunWriter(storageRoot);
      await assert.rejects(
        () => store.appendEvent('', completedEvents('')[0]!),
        /taskRunId must not be empty/,
      );
      const malformedId = '\uD800';
      await assert.rejects(
        () => store.appendEvent(malformedId, completedEvents(malformedId)[0]!),
        /taskRunId must be well-formed Unicode/,
      );
      await assert.rejects(
        () => store.appendEvent('owned-run', completedEvents('other-run')[0]!),
        /taskRunId mismatch/,
      );
      await assert.rejects(() => lstat(join(storageRoot, 'runtime.sqlite')), { code: 'ENOENT' });
    } finally {
      await rm(storageRoot, { recursive: true, force: true });
    }
  });
});

async function openSqliteTaskRunWriter(storageRoot: string) {
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'headless' });
  return openHeadlessTaskRunWriter(createHeadlessRootLease(capability, 'write'));
}

async function openSqliteTaskRunReader(storageRoot: string) {
  const capability = await resolveStorageRoot({ path: storageRoot, kind: 'headless' });
  return openHeadlessTaskRunReader(createHeadlessRootLease(capability, 'read'));
}

function prepareTaskRunWriterProcess(
  storageRoot: string,
  eventPath: string,
): { child: ChildProcess; ready: Promise<void>; append: () => Promise<void> } {
  const child = fork(taskRunWriterProcessPath, [storageRoot, eventPath], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });

  const ready = new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`TaskRun writer exited before ready (${String(code)}): ${stderr}`));
    };
    const onMessage = (message: unknown) => {
      if (!isChildMessage(message, 'ready')) return;
      cleanup();
      resolve();
    };
    const cleanup = () => {
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    };
    child.on('error', onError);
    child.on('exit', onExit);
    child.on('message', onMessage);
  });

  return {
    child,
    ready: withTestDeadline(ready, 'TaskRun writer readiness'),
    append: () =>
      withTestDeadline(
        new Promise<void>((resolve, reject) => {
          child.once('error', reject);
          child.once('exit', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`TaskRun writer exited with ${String(code)}: ${stderr}`));
          });
          child.send({ type: 'append' }, (error) => {
            if (error) reject(error);
          });
        }),
        'TaskRun writer append',
      ),
  };
}

function withTestDeadline<T>(
  operation: Promise<T>,
  description: string,
  timeoutMs = 30_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${description} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    operation.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

async function terminateChildProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = waitForChildExit(child);
  child.kill();
  await withTestDeadline(exited, 'TaskRun writer termination', 5_000);
}

function waitForChildExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const onExit = () => resolve();
    child.once('exit', onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      child.off('exit', onExit);
      resolve();
    }
  });
}

function isChildMessage(value: unknown, type: string): boolean {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === type;
}
