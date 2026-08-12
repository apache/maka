import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type RuntimeEvent } from '@maka/core/runtime-event';
import { type WorkspaceBaselineAuthorityInput } from '@maka/core/workspace-version-authority';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import {
  createSqliteRuntimeStore,
  type SqliteRuntimeStoreFailpoint,
} from '../sqlite-runtime-store.js';
import {
  bindWorkspaceBaselineAuthorityStoreRootInternal,
  commitWorkspaceBaselineInternal,
} from '../workspace-version-authority-internal.js';

const CRASH_READ_ARGS_HASH = canonicalToolArgsHash('Read', {
  path: '/workspace/README.md',
});
const childMode = process.env.MAKA_SQLITE_CRASH_CHILD;

if (childMode) {
  await runCrashChild(childMode);
} else {
  describe('SqliteRuntimeStore real-process crash boundaries', () => {
    it('rolls back a process killed inside T1', { timeout: 30_000 }, async () => {
      await withKilledChild('inside_t1', async (store) => {
        assert.deepEqual(await store.readRuntimeEvents('session-1', 'run-1'), []);
        assert.deepEqual(await store.listUnsettledToolOperations(), []);
      });
    });

    it('retains a prepared operation when killed after T1 and a possible side effect', {
      timeout: 30_000,
    }, async () => {
      await withKilledChild('after_effect', async (store, markerPath) => {
        assert.equal(await readFile(markerPath, 'utf8'), 'effect-happened');
        assert.deepEqual(
          (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
          ['call-event-1', 'dispatch-event-1'],
        );
        assert.deepEqual(
          (await store.listUnsettledToolOperations()).map((operation) => operation.operationId),
          ['operation-1'],
        );
      });
    });

    it('rolls back a process killed inside T2 without losing T1', { timeout: 30_000 }, async () => {
      await withKilledChild('inside_t2', async (store) => {
        assert.deepEqual(
          (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
          ['call-event-1', 'dispatch-event-1'],
        );
        assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
      });
    });

    it('retains the committed outcome when killed after T2', { timeout: 30_000 }, async () => {
      await withKilledChild('after_t2', async (store) => {
        assert.deepEqual(
          (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
          ['call-event-1', 'dispatch-event-1', 'response-event-1'],
        );
        assert.equal(
          (await store.readToolOperation('operation-1'))?.currentState,
          'outcome_committed',
        );
        assert.deepEqual(await store.listUnsettledToolOperations(), []);
      });
    });

    for (const mode of [
      'inside_recovery_reconcile',
      'inside_recovery_outcome',
      'inside_recovery_decision',
    ]) {
      it(`rolls back the whole recovery bundle when killed at ${mode}`, {
        timeout: 30_000,
      }, async () => {
        await withKilledChild(mode, async (store) => {
          assert.deepEqual(
            (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
            ['call-event-1', 'dispatch-event-1'],
          );
          assert.equal((await store.readToolOperation('operation-1'))?.currentState, 'prepared');
        });
      });
    }

    it('retains the whole recovery bundle when killed after COMMIT', {
      timeout: 30_000,
    }, async () => {
      await withKilledChild('after_recovery_commit', async (store) => {
        assert.deepEqual(
          (await store.readRuntimeEvents('session-1', 'run-1')).map((event) => event.id),
          [
            'call-event-1',
            'dispatch-event-1',
            'reconcile-event-1',
            'response-event-1',
            'decision-event-1',
          ],
        );
        assert.equal(
          (await store.readToolOperation('operation-1'))?.currentState,
          'recovery_completed',
        );
      });
    });

    it('rolls back a workspace baseline when killed inside its authority transaction', {
      timeout: 30_000,
    }, async () => {
      await withKilledChild('inside_workspace_baseline', async (store) => {
        assert.equal(
          await store.readWorkspaceHead(`workspace_${'2'.repeat(32)}`, `epoch_${'3'.repeat(32)}`),
          undefined,
        );
      });
    });

    it('retains the complete workspace baseline when killed after COMMIT', {
      timeout: 30_000,
    }, async () => {
      await withKilledChild('after_workspace_baseline_commit', async (store) => {
        assert.equal(
          (await store.readWorkspaceHead(`workspace_${'2'.repeat(32)}`, `epoch_${'3'.repeat(32)}`))
            ?.workspaceVersionId,
          `version_${'5'.repeat(32)}`,
        );
      });
    });
  });
}

async function withKilledChild(
  mode: string,
  inspect: (
    store: ReturnType<typeof createSqliteRuntimeStore>,
    markerPath: string,
  ) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'maka-sqlite-crash-'));
  const dbPath = join(root, 'runtime.sqlite');
  const markerPath = join(root, 'effect.marker');
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: {
      ...process.env,
      MAKA_SQLITE_CRASH_CHILD: mode,
      MAKA_SQLITE_CRASH_DB: dbPath,
      MAKA_SQLITE_CRASH_MARKER: markerPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForReady(child);
    child.kill('SIGKILL');
    await new Promise<void>((resolve, reject) => {
      child.once('exit', () => resolve());
      child.once('error', reject);
    });
    const store = createSqliteRuntimeStore(dbPath);
    try {
      await inspect(store, markerPath);
    } finally {
      store.close();
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
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
    child.once('exit', (code, signal) => {
      reject(new Error(`crash child exited before READY: code=${code} signal=${signal} ${stderr}`));
    });
    child.once('error', reject);
  });
}

async function runCrashChild(mode: string): Promise<void> {
  const dbPath = requiredEnv('MAKA_SQLITE_CRASH_DB');
  const markerPath = requiredEnv('MAKA_SQLITE_CRASH_MARKER');
  let runtimeInsertCount = 0;
  const failpoint = (point: SqliteRuntimeStoreFailpoint) => {
    if (point === 'after_runtime_event_insert') {
      runtimeInsertCount += 1;
      if (mode === 'inside_t1' && runtimeInsertCount === 1) blockUntilKilled();
      if (mode === 'inside_t2' && runtimeInsertCount === 2) blockUntilKilled();
    }
    if (point === 'after_recovery_reconcile' && mode === 'inside_recovery_reconcile') {
      blockUntilKilled();
    }
    if (point === 'after_recovery_outcome' && mode === 'inside_recovery_outcome') {
      blockUntilKilled();
    }
    if (point === 'after_recovery_decision' && mode === 'inside_recovery_decision') {
      blockUntilKilled();
    }
    if (point === 'after_workspace_version_event_insert' && mode === 'inside_workspace_baseline') {
      blockUntilKilled();
    }
  };
  const store = createSqliteRuntimeStore(dbPath, { failpoint });
  if (mode === 'inside_workspace_baseline' || mode === 'after_workspace_baseline_commit') {
    bindWorkspaceBaselineAuthorityStoreRootInternal(store, 'a'.repeat(64));
    await commitWorkspaceBaselineInternal(store, workspaceBaselineInput());
    if (mode === 'after_workspace_baseline_commit') blockUntilKilled();
    throw new Error(`Workspace baseline crash mode ${mode} missed its failpoint`);
  }
  await store.commitToolPrepared(preparedCommit());
  if (mode === 'after_effect') {
    writeFileSync(markerPath, 'effect-happened');
    blockUntilKilled();
  }
  if (mode.startsWith('inside_recovery_') || mode === 'after_recovery_commit') {
    await store.commitToolRecoveryBundle(recoveryCommit());
    if (mode === 'after_recovery_commit') blockUntilKilled();
    throw new Error(`Recovery crash mode ${mode} missed its failpoint`);
  }
  await store.commitToolOutcome(outcomeCommit());
  if (mode === 'after_t2') blockUntilKilled();
  throw new Error(`Unknown crash child mode ${mode}`);
}

function blockUntilKilled(): never {
  writeSync(1, 'READY\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  throw new Error('unreachable');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function preparedCommit() {
  return {
    operationId: 'operation-1',
    journalEventId: 'operation-1_prepared',
    runtimeEvent: functionCallEvent(),
    dispatchRuntimeEvent: toolDispatchEvent(),
    providerToolCallId: 'provider-call-1',
    toolName: 'Read',
    canonicalArgsHash: CRASH_READ_ARGS_HASH,
    recoveryMode: 'reconcile' as const,
    committedAt: 1,
  };
}

function workspaceBaselineInput(): WorkspaceBaselineAuthorityInput {
  return {
    epochOpenedEventId: 'workspace-epoch-event-1',
    baselineAcceptedEventId: 'workspace-version-event-1',
    committedAt: 1_700_000_000_000,
    epoch: {
      repositoryId: `repository_${'1'.repeat(32)}`,
      workspaceId: `workspace_${'2'.repeat(32)}`,
      workspaceEpochId: `epoch_${'3'.repeat(32)}`,
      workspaceInstanceId: `instance_${'4'.repeat(32)}`,
      mode: 'managed_worktree',
      objectFormat: 'sha1',
      sourceCommitOid: '1'.repeat(40),
      sourceTreeOid: '2'.repeat(40),
      materializationProfileDigest: `sha256:${'3'.repeat(64)}`,
      materializationSemantics: 'git_tree_materialized_with_fixed_config_v1',
      policyHash: `sha256:${'4'.repeat(64)}`,
    },
    baseline: {
      workspaceVersionId: `version_${'5'.repeat(32)}`,
      commitOid: '5'.repeat(40),
      treeOid: '2'.repeat(40),
      treeDeltaDigest: `sha256:${'6'.repeat(64)}`,
      changedFileCount: 7,
      deletedFileCount: 0,
    },
  };
}

function outcomeCommit() {
  return {
    operationId: 'operation-1',
    journalEventId: 'operation-1_outcome',
    runtimeEvent: functionResponseEvent(),
    committedAt: 2,
  };
}

function toolDispatchEvent(): RuntimeEvent {
  return {
    id: 'dispatch-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      toolDispatch: {
        protocol: 't1_after_preflight_v1',
        operationId: 'operation-1',
        providerToolCallId: 'provider-call-1',
        toolName: 'Read',
        canonicalArgsHash: CRASH_READ_ARGS_HASH,
        recoveryMode: 'reconcile',
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  };
}

function functionCallEvent(): RuntimeEvent {
  return {
    id: 'call-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1,
    partial: false,
    role: 'model',
    author: 'agent',
    content: {
      kind: 'function_call',
      id: 'provider-call-1',
      name: 'Read',
      args: { path: '/workspace/README.md' },
    },
  };
}

function functionResponseEvent(): RuntimeEvent {
  return {
    id: 'response-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 2,
    partial: false,
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'provider-call-1',
      name: 'Read',
      result: 'contents',
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  };
}

function recoveryCommit() {
  return {
    operationId: 'operation-1',
    reconcileRuntimeEvent: reconcileEvent(),
    outcomeRuntimeEvent: functionResponseEvent(),
    decisionRuntimeEvent: decisionEvent(),
  };
}

function reconcileEvent(): RuntimeEvent {
  return {
    id: 'reconcile-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 2,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      toolRecovery: {
        kind: 'maka.tool.reconcile_result',
        version: 1,
        payload: {
          protocol: 'tool_reconcile_v1',
          operationId: 'operation-1',
          observation: 'matches_expected_state',
          observationSchema: 'state_identity_v1',
          observationDigest:
            'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  };
}

function decisionEvent(): RuntimeEvent {
  return {
    id: 'decision-event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 3,
    partial: false,
    role: 'system',
    author: 'system',
    actions: {
      toolRecovery: {
        kind: 'maka.tool.recovery_decision',
        version: 1,
        payload: {
          protocol: 'tool_recovery_v1',
          operationId: 'operation-1',
          disposition: 'completed',
          reasonCode: 'reconcile_matches_expected_state',
          outcomeEventId: 'response-event-1',
          evidenceEventIds: [
            'call-event-1',
            'dispatch-event-1',
            'reconcile-event-1',
            'response-event-1',
          ],
        },
      },
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  };
}
