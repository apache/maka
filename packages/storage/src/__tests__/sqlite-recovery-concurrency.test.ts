import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalToolArgsHash, scanToolLedger, type RuntimeEvent } from '@maka/core';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';

const WORKER_READY_TIMEOUT_MS = 15_000;
const WORKER_EXECUTION_TIMEOUT_MS = 30_000;
const WORKER_SHUTDOWN_TIMEOUT_MS = 5_000;

interface WorkerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface WorkerHandle {
  mode: string;
  child: ReturnType<typeof spawn>;
  ready: Promise<void>;
  opened: Promise<void>;
  result: Promise<WorkerResult>;
  output(): Pick<WorkerResult, 'stdout' | 'stderr'>;
}

describe('SQLite recovery authority multi-process races', () => {
  it('makes an exact concurrent recovery bundle idempotent', async () => {
    await withPreparedDatabase(async ({ dbPath, startPath }) => {
      const results = await runWorkers(dbPath, startPath, ['completed', 'completed']);
      assert.deepEqual(
        results.map(({ code }) => code),
        [0, 0],
      );

      const store = createSqliteRuntimeStore(dbPath);
      try {
        assert.equal(
          (await store.readToolOperation('operation-1'))?.currentState,
          'recovery_completed',
        );
        assert.equal((await store.readImmutableRuntimeEvents('session-1', 'run-1')).length, 5);
      } finally {
        store.close();
      }
    });
  });

  it('serializes conflicting completed and parked bundles to one terminal decision', async () => {
    await withPreparedDatabase(async ({ dbPath, startPath }) => {
      const results = await runWorkers(dbPath, startPath, ['completed', 'parked']);
      assert.deepEqual(results.map(({ code }) => code).sort(), [0, 2]);

      const store = createSqliteRuntimeStore(dbPath);
      try {
        const operation = await store.readToolOperation('operation-1');
        assert.ok(
          operation?.currentState === 'recovery_completed' ||
            operation?.currentState === 'recovery_parked',
        );
        const events = await store.readImmutableRuntimeEvents('session-1', 'run-1');
        assert.equal(scanToolLedger(events).hasCorruption, false);
      } finally {
        store.close();
      }
    });
  });

  it('serializes projection rebuild against recovery commit', async () => {
    await withPreparedDatabase(async ({ dbPath, startPath }) => {
      const results = await runWorkers(dbPath, startPath, ['completed', 'rebuild']);
      assert.deepEqual(
        results.map(({ code }) => code),
        [0, 0],
      );

      const store = createSqliteRuntimeStore(dbPath);
      try {
        assert.equal(
          (await store.readToolOperation('operation-1'))?.currentState,
          'recovery_completed',
        );
        assert.equal(
          scanToolLedger(await store.readImmutableRuntimeEvents('session-1', 'run-1'))
            .hasCorruption,
          false,
        );
      } finally {
        store.close();
      }
    });
  });

  it('allows concurrent processes to keep the same initialized WAL database open', async () => {
    await withPreparedDatabase(async ({ dbPath, startPath }) => {
      const results = await runOpenWorkers(dbPath, startPath);
      assert.deepEqual(
        results.map(({ code }) => code),
        [0, 0],
      );
    });
  });

  it('serializes concurrent schema 4 to 5 upgrades', async () => {
    await withPreparedDatabase(async ({ dbPath, startPath }) => {
      const db = new DatabaseSync(dbPath);
      try {
        db.exec('DROP TABLE runtime_capabilities; PRAGMA user_version = 4;');
      } finally {
        db.close();
      }

      const results = await runOpenWorkers(dbPath, startPath);
      assert.deepEqual(
        results.map(({ code }) => code),
        [0, 0],
      );

      const upgraded = createSqliteRuntimeStore(dbPath);
      try {
        assert.equal(upgraded.schemaVersion(), 5);
      } finally {
        upgraded.close();
      }
    });
  });

  it('captures a fast worker initialization failure after releasing the barrier', async () => {
    const root = await mkdtemp(join(tmpdir(), 'maka-recovery-race-invalid-db-'));
    try {
      const results = await runWorkers(root, join(root, 'start'), ['completed']);
      assert.equal(results[0]?.code, 2);
      assert.match(results[0]?.stderr ?? '', /RESULT error/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function withPreparedDatabase(
  run: (input: { dbPath: string; startPath: string }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-recovery-race-'));
  const dbPath = join(root, 'runtime.sqlite');
  const startPath = join(root, 'start');
  const store = createSqliteRuntimeStore(dbPath);
  try {
    await store.commitToolPrepared(preparedCommit());
    store.close();
    await run({ dbPath, startPath });
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function runWorkers(
  dbPath: string,
  startPath: string,
  modes: readonly string[],
): Promise<WorkerResult[]> {
  const workers = modes.map((mode) => startWorker(dbPath, startPath, mode));
  try {
    await withTimeout(
      Promise.all(workers.map(({ ready }) => ready)),
      WORKER_READY_TIMEOUT_MS,
      'workers to reach the start barrier',
    );
    await writeFile(startPath, 'go');
    return await withTimeout(
      Promise.all(workers.map(({ result }) => result)),
      WORKER_EXECUTION_TIMEOUT_MS,
      'workers to finish their SQLite operations',
    );
  } catch (error) {
    await stopWorkers(workers);
    const diagnostics = workers.map(formatWorkerDiagnostics).join('\n');
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`);
  }
}

async function runOpenWorkers(dbPath: string, startPath: string): Promise<WorkerResult[]> {
  const stopPath = `${startPath}.stop`;
  const workers = ['open_only', 'open_only'].map((mode) =>
    startWorker(dbPath, startPath, mode, stopPath),
  );
  try {
    await withTimeout(
      Promise.all(workers.map(({ ready }) => ready)),
      WORKER_READY_TIMEOUT_MS,
      'workers to reach the concurrent-open start barrier',
    );
    await writeFile(startPath, 'go');
    await withTimeout(
      Promise.all(workers.map(({ opened }) => opened)),
      WORKER_READY_TIMEOUT_MS,
      'workers to open the same SQLite database',
    );
    await writeFile(stopPath, 'close');
    return await withTimeout(
      Promise.all(workers.map(({ result }) => result)),
      WORKER_EXECUTION_TIMEOUT_MS,
      'concurrent-open workers to close',
    );
  } catch (error) {
    await stopWorkers(workers);
    const diagnostics = workers.map(formatWorkerDiagnostics).join('\n');
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics}`);
  }
}

function startWorker(
  dbPath: string,
  startPath: string,
  mode: string,
  stopPath?: string,
): WorkerHandle {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('./fixtures/sqlite-recovery-concurrency-child.js', import.meta.url))],
    {
      env: {
        ...process.env,
        MAKA_SQLITE_RECOVERY_CONCURRENCY_MODE: mode,
        MAKA_SQLITE_RECOVERY_CONCURRENCY_DB: dbPath,
        MAKA_SQLITE_RECOVERY_CONCURRENCY_START: startPath,
        ...(stopPath ? { MAKA_SQLITE_RECOVERY_CONCURRENCY_STOP: stopPath } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  let readySeen = false;
  let openedSeen = false;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  let resolveOpened!: () => void;
  let rejectOpened!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpened = resolve;
    rejectOpened = reject;
  });
  const result = new Promise<WorkerResult>((resolve, reject) => {
    child.once('error', (error) => {
      rejectReady(error);
      rejectOpened(error);
      reject(error);
    });
    child.once('close', (code) => {
      if (!readySeen) {
        rejectReady(new Error(`worker ${mode} exited before READY: ${code} ${stderr}`));
      }
      if (!openedSeen) {
        rejectOpened(new Error(`worker ${mode} exited before OPENED: ${code} ${stderr}`));
      }
      resolve({ code, stdout, stderr });
    });
  });
  // A worker can fail before the coordinator reaches the phase that awaits one
  // of these promises. Attach handlers immediately so the diagnostic path, not
  // the process-level unhandled-rejection policy, owns the failure.
  void opened.catch(() => {});
  void result.catch(() => {});
  child.stdout?.on('data', (chunk) => {
    stdout += String(chunk);
    if (!readySeen && stdout.includes('READY\n')) {
      readySeen = true;
      resolveReady();
    }
    if (!openedSeen && stdout.includes('OPENED\n')) {
      openedSeen = true;
      resolveOpened();
    }
  });
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return {
    mode,
    child,
    ready,
    opened,
    result,
    output: () => ({ stdout, stderr }),
  };
}

async function stopWorkers(workers: readonly WorkerHandle[]): Promise<void> {
  for (const { child } of workers) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  await Promise.race([
    Promise.allSettled(workers.map(({ result }) => result)),
    new Promise<void>((resolve) => setTimeout(resolve, WORKER_SHUTDOWN_TIMEOUT_MS)),
  ]);
}

function formatWorkerDiagnostics(worker: WorkerHandle): string {
  const { stdout, stderr } = worker.output();
  const state =
    worker.child.exitCode !== null
      ? `exit=${worker.child.exitCode}`
      : worker.child.signalCode !== null
        ? `signal=${worker.child.signalCode}`
        : 'still-running';
  return [
    `worker mode=${worker.mode} pid=${worker.child.pid ?? 'unknown'} ${state}`,
    `stdout=${JSON.stringify(stdout)}`,
    `stderr=${JSON.stringify(stderr)}`,
  ].join('\n');
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  description: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function preparedCommit() {
  const args = { path: 'notes.txt', content: 'after' };
  const hash = canonicalToolArgsHash('Write', args);
  return {
    operationId: 'operation-1',
    journalEventId: 'operation-1_prepared',
    runtimeEvent: {
      ...baseEvent('call-event-1', 1),
      role: 'model' as const,
      author: 'agent' as const,
      content: {
        kind: 'function_call' as const,
        id: 'provider-call-1',
        name: 'Write',
        args,
      },
    },
    dispatchRuntimeEvent: {
      ...baseEvent('dispatch-event-1', 2),
      actions: {
        toolDispatch: {
          protocol: 't1_after_preflight_v1' as const,
          operationId: 'operation-1',
          providerToolCallId: 'provider-call-1',
          toolName: 'Write',
          canonicalArgsHash: hash,
          recoveryMode: 'reconcile' as const,
        },
      },
      refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
    },
    providerToolCallId: 'provider-call-1',
    toolName: 'Write',
    canonicalArgsHash: hash,
    recoveryMode: 'reconcile' as const,
    committedAt: 2,
  };
}

function baseEvent(id: string, ts: number): RuntimeEvent {
  return {
    id,
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts,
    partial: false,
    role: 'system',
    author: 'system',
  };
}
