import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalToolArgsHash, scanToolLedger, type RuntimeEvent } from '@maka/core';
import { createSqliteRuntimeStore } from '../sqlite-runtime-store.js';

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
): Promise<Array<{ code: number | null; stdout: string; stderr: string }>> {
  const workers = modes.map((mode) => {
    const child = spawn(
      process.execPath,
      [fileURLToPath(new URL('./fixtures/sqlite-recovery-concurrency-child.js', import.meta.url))],
      {
        env: {
          ...process.env,
          MAKA_SQLITE_RECOVERY_CONCURRENCY_MODE: mode,
          MAKA_SQLITE_RECOVERY_CONCURRENCY_DB: dbPath,
          MAKA_SQLITE_RECOVERY_CONCURRENCY_START: startPath,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    return { child, ready: waitForReady(child) };
  });
  await Promise.all(workers.map(({ ready }) => ready));
  await writeFile(startPath, 'go');
  return Promise.all(
    workers.map(
      ({ child }) =>
        new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
          let stdout = '';
          let stderr = '';
          child.stdout?.on('data', (chunk) => {
            stdout += String(chunk);
          });
          child.stderr?.on('data', (chunk) => {
            stderr += String(chunk);
          });
          child.once('error', reject);
          child.once('exit', (code) => resolve({ code, stdout, stderr }));
        }),
    ),
  );
}

function waitForReady(child: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('READY\n')) resolve();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('exit', (code) => {
      reject(new Error(`worker exited before READY: ${code} ${stderr}`));
    });
    child.once('error', reject);
  });
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
