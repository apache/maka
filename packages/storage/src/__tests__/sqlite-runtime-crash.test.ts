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

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type RuntimeEvent } from '@maka/core/runtime-event';
import {
  type WorkspaceBaselineAuthorityInput,
  type WorkspaceSuccessorAuthorityInput,
} from '@maka/core/workspace-version-authority';
import { canonicalToolArgsHash } from '@maka/core/tool-args-identity';
import {
  createSqliteRuntimeStore,
  type SqliteRuntimeStoreFailpoint,
} from '../sqlite-runtime-store.js';
import {
  bindWorkspaceBaselineAuthorityStoreRootInternal,
  commitManagedMutationTerminalInternal,
  commitWorkspaceBaselineInternal,
  commitWorkspaceSuccessorInternal,
  readActiveManagedMutationInternal,
  registerManagedMutationNoEffectVerifierInternal,
  registerWorkspaceSuccessorCandidateVerifierInternal,
  type ManagedMutationNoEffectClaimV1,
  type WorkspaceSuccessorCommitInput,
} from '../workspace-version-authority-internal.js';

const CRASH_READ_ARGS_HASH = canonicalToolArgsHash('Read', {
  path: '/workspace/README.md',
});
const CRASH_CANDIDATES = new WeakMap<object, WorkspaceSuccessorAuthorityInput>();
const CRASH_NO_EFFECT_CLAIMS = new WeakMap<object, ManagedMutationNoEffectClaimV1>();

function registerCrashCandidateVerifier(store: object): void {
  registerWorkspaceSuccessorCandidateVerifierInternal(store, (capability) => {
    const successor = CRASH_CANDIDATES.get(capability);
    if (!successor) throw new Error('Unrecognized crash-test candidate capability');
    return structuredClone(successor);
  });
  registerManagedMutationNoEffectVerifierInternal(store, (capability) => {
    const claim = CRASH_NO_EFFECT_CLAIMS.get(capability);
    if (!claim) throw new Error('Unrecognized crash-test no-effect capability');
    return structuredClone(claim);
  });
}

function issueCrashNoEffect(claim: ManagedMutationNoEffectClaimV1): object {
  const capability = Object.freeze({});
  CRASH_NO_EFFECT_CLAIMS.set(capability, structuredClone(claim));
  return capability;
}
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

    it('retains exclusive managed mutation ownership when killed after T1', {
      timeout: 30_000,
    }, async () => {
      await withKilledChild('after_workspace_mutation_t1', async (store) => {
        bindWorkspaceBaselineAuthorityStoreRootInternal(store, 'a'.repeat(64));
        assert.equal(
          (await readActiveManagedMutationInternal(store, `instance_${'4'.repeat(32)}`))
            ?.operationId,
          'workspace-successor-operation',
        );
        await assert.rejects(
          store.commitToolPrepared(
            workspaceSuccessorPreparedCommit('workspace-conflicting-operation'),
          ),
          /managed mutation reservation conflict/i,
        );
      });
    });

    it('rolls back a workspace successor when killed inside its authority transaction', {
      timeout: 30_000,
    }, async () => {
      await withKilledChild('inside_workspace_successor', async (store) => {
        assert.equal(
          (await store.readWorkspaceHead(`workspace_${'2'.repeat(32)}`, `epoch_${'3'.repeat(32)}`))
            ?.workspaceVersionId,
          `version_${'5'.repeat(32)}`,
        );
        assert.equal(
          (await store.readToolOperation('workspace-successor-operation'))?.currentState,
          'prepared',
        );
        assert.equal(await store.readWorkspaceVersion(`version_${'7'.repeat(32)}`), undefined);
      });
    });

    it('returns the accepted workspace successor after a process is killed post-commit', {
      timeout: 30_000,
    }, async () => {
      await withKilledChild('after_workspace_successor_commit', async (store) => {
        bindWorkspaceBaselineAuthorityStoreRootInternal(store, 'a'.repeat(64));
        const retry = await commitWorkspaceSuccessorInternal(store, workspaceSuccessorCommit());
        assert.equal(retry.created, false);
        assert.equal(retry.committedSuccessor.workspaceVersionId, `version_${'7'.repeat(32)}`);
        assert.equal(
          (await store.readToolOperation('workspace-successor-operation'))?.currentState,
          'outcome_committed',
        );
      });
    });

    it('rolls back a no-effect terminal when killed inside its transaction', {
      timeout: 30_000,
    }, async () => {
      await withKilledChild('inside_workspace_terminal', async (store) => {
        bindWorkspaceBaselineAuthorityStoreRootInternal(store, 'a'.repeat(64));
        assert.equal(
          (await store.readToolOperation('workspace-successor-operation'))?.currentState,
          'prepared',
        );
        assert.equal(
          (await readActiveManagedMutationInternal(store, `instance_${'4'.repeat(32)}`))
            ?.operationId,
          'workspace-successor-operation',
        );
      });
    });

    it('retains a no-effect terminal and released reservation after process exit', {
      timeout: 30_000,
    }, async () => {
      await withKilledChild('after_workspace_terminal_commit', async (store) => {
        bindWorkspaceBaselineAuthorityStoreRootInternal(store, 'a'.repeat(64));
        assert.equal(
          (await store.readToolOperation('workspace-successor-operation'))?.currentState,
          'outcome_committed',
        );
        assert.equal(
          await readActiveManagedMutationInternal(store, `instance_${'4'.repeat(32)}`),
          undefined,
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
    registerCrashCandidateVerifier(store);
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
      if (mode === 'inside_workspace_terminal' && runtimeInsertCount === 2) blockUntilKilled();
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
    if (
      point === 'after_workspace_successor_event_insert' &&
      mode === 'inside_workspace_successor'
    ) {
      blockUntilKilled();
    }
  };
  const store = createSqliteRuntimeStore(dbPath, { failpoint });
  registerCrashCandidateVerifier(store);
  if (
    mode === 'inside_workspace_baseline' ||
    mode === 'after_workspace_baseline_commit' ||
    mode === 'after_workspace_mutation_t1' ||
    mode === 'inside_workspace_successor' ||
    mode === 'after_workspace_successor_commit' ||
    mode === 'inside_workspace_terminal' ||
    mode === 'after_workspace_terminal_commit'
  ) {
    bindWorkspaceBaselineAuthorityStoreRootInternal(store, 'a'.repeat(64));
    await commitWorkspaceBaselineInternal(store, workspaceBaselineInput());
    if (mode === 'after_workspace_baseline_commit') blockUntilKilled();
    if (mode === 'after_workspace_mutation_t1') {
      await store.commitToolPrepared(workspaceSuccessorPreparedCommit());
      blockUntilKilled();
    }
    if (mode === 'inside_workspace_successor' || mode === 'after_workspace_successor_commit') {
      await store.commitToolPrepared(workspaceSuccessorPreparedCommit());
      await commitWorkspaceSuccessorInternal(store, workspaceSuccessorCommit());
      if (mode === 'after_workspace_successor_commit') blockUntilKilled();
    }
    if (mode === 'inside_workspace_terminal' || mode === 'after_workspace_terminal_commit') {
      await store.commitToolPrepared(workspaceSuccessorPreparedCommit());
      await commitManagedMutationTerminalInternal(store, workspaceTerminalCommit());
      if (mode === 'after_workspace_terminal_commit') blockUntilKilled();
    }
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

function workspaceSuccessorPreparedCommit(operationId = 'workspace-successor-operation') {
  const args = { path: 'notes.txt', content: 'successor' };
  const canonicalArgsHash = canonicalToolArgsHash('Write', args);
  const isCanonicalFixture = operationId === 'workspace-successor-operation';
  const toolCallId = isCanonicalFixture ? 'workspace-successor-call-id' : `${operationId}-call-id`;
  const callEventId = isCanonicalFixture ? 'workspace-successor-call' : `${operationId}-call`;
  const dispatchEventId = isCanonicalFixture
    ? 'workspace-successor-dispatch'
    : `${operationId}-dispatch`;
  return {
    operationId,
    journalEventId: `${operationId}_prepared`,
    runtimeEvent: {
      id: callEventId,
      invocationId: 'workspace-successor-invocation',
      runId: 'workspace-successor-run',
      sessionId: 'workspace-successor-session',
      turnId: 'workspace-successor-turn',
      ts: 1_700_000_000_001,
      partial: false,
      role: 'model' as const,
      author: 'agent' as const,
      content: {
        kind: 'function_call' as const,
        id: toolCallId,
        name: 'Write',
        args,
      },
      refs: {
        operationId,
        toolCallId,
      },
    },
    dispatchRuntimeEvent: {
      id: dispatchEventId,
      invocationId: 'workspace-successor-invocation',
      runId: 'workspace-successor-run',
      sessionId: 'workspace-successor-session',
      turnId: 'workspace-successor-turn',
      ts: 1_700_000_000_001,
      partial: false,
      role: 'system' as const,
      author: 'system' as const,
      actions: {
        toolDispatch: {
          protocol: 't1_after_preflight_v1' as const,
          operationId,
          providerToolCallId: toolCallId,
          toolName: 'Write',
          canonicalArgsHash,
          recoveryMode: 'reconcile' as const,
          managedMutation: {
            protocol: 'managed_mutation_v2' as const,
            repositoryId: `repository_${'1'.repeat(32)}`,
            workspaceId: `workspace_${'2'.repeat(32)}`,
            workspaceEpochId: `epoch_${'3'.repeat(32)}`,
            workspaceInstanceId: `instance_${'4'.repeat(32)}`,
            objectFormat: 'sha1' as const,
            baseWorkspaceVersionId: `version_${'5'.repeat(32)}`,
            baseAcceptedEventId: 'workspace-version-event-1',
            baseHeadRevision: 1,
            baseCommitOid: '5'.repeat(40),
            baseTreeOid: '2'.repeat(40),
            expectedPath: 'notes.txt',
            pathPolicyVersion: 3 as const,
            executionProfileDigest:
              'sha256:ffdfdda9cf38f382e0c4db81dac7319cd33586a6c65051a97a15e6c41b88f825' as const,
          },
        },
      },
      refs: {
        operationId,
        toolCallId,
      },
    },
    providerToolCallId: toolCallId,
    toolName: 'Write',
    canonicalArgsHash,
    recoveryMode: 'reconcile' as const,
    committedAt: 1_700_000_000_001,
  };
}

function workspaceSuccessorCommit(): WorkspaceSuccessorCommitInput {
  const successor: WorkspaceSuccessorAuthorityInput = {
    acceptedEventId: 'workspace-successor-accepted',
    committedAt: 1_700_000_000_002,
    successor: {
      repositoryId: `repository_${'1'.repeat(32)}`,
      workspaceId: `workspace_${'2'.repeat(32)}`,
      workspaceEpochId: `epoch_${'3'.repeat(32)}`,
      workspaceVersionId: `version_${'7'.repeat(32)}`,
      objectFormat: 'sha1',
      parentWorkspaceVersionId: `version_${'5'.repeat(32)}`,
      baseAcceptedEventId: 'workspace-version-event-1',
      baseHeadRevision: 1,
      commitOid: '7'.repeat(40),
      treeOid: '8'.repeat(40),
      policyHash: `sha256:${'4'.repeat(64)}`,
      treeDeltaDigest: `sha256:${'9'.repeat(64)}`,
      changedPaths: ['notes.txt'],
      changedFileCount: 1,
      deletedFileCount: 0,
      executionProfileDigest:
        'sha256:ffdfdda9cf38f382e0c4db81dac7319cd33586a6c65051a97a15e6c41b88f825' as const,
    },
    origin: {
      operationId: 'workspace-successor-operation',
      dispatchEventId: 'workspace-successor-dispatch',
      outcomeEventId: 'workspace-successor-outcome',
    },
  };
  const candidateOutcome = Object.freeze({});
  CRASH_CANDIDATES.set(candidateOutcome, successor);
  return {
    candidateOutcome,
    toolOutcome: {
      operationId: 'workspace-successor-operation',
      journalEventId: 'workspace-successor-operation_outcome',
      committedAt: 1_700_000_000_002,
      runtimeEvent: {
        id: 'workspace-successor-outcome',
        invocationId: 'workspace-successor-invocation',
        runId: 'workspace-successor-run',
        sessionId: 'workspace-successor-session',
        turnId: 'workspace-successor-turn',
        ts: 1_700_000_000_002,
        partial: false,
        role: 'tool',
        author: 'tool',
        content: {
          kind: 'function_response',
          id: 'workspace-successor-call-id',
          name: 'Write',
          result: 'Wrote notes.txt',
        },
        refs: {
          operationId: 'workspace-successor-operation',
          toolCallId: 'workspace-successor-call-id',
        },
      },
    },
  };
}

function workspaceTerminalCommit() {
  return {
    noEffectOutcome: issueCrashNoEffect({
      operationId: 'workspace-successor-operation',
      dispatchEventId: 'workspace-successor-dispatch',
      workspaceInstanceId: `instance_${'4'.repeat(32)}`,
      terminalKind: 'no_workspace_change',
    }),
    toolOutcome: {
      operationId: 'workspace-successor-operation',
      journalEventId: 'workspace-successor-operation_outcome',
      committedAt: 1_700_000_000_002,
      runtimeEvent: {
        id: 'workspace-terminal-outcome',
        invocationId: 'workspace-successor-invocation',
        runId: 'workspace-successor-run',
        sessionId: 'workspace-successor-session',
        turnId: 'workspace-successor-turn',
        ts: 1_700_000_000_002,
        partial: false,
        role: 'tool' as const,
        author: 'tool' as const,
        content: {
          kind: 'function_response' as const,
          id: 'workspace-successor-call-id',
          name: 'Write',
          result: 'No workspace change',
        },
        actions: {
          managedMutationTerminal: {
            protocol: 'managed_mutation_terminal_v1' as const,
            operationId: 'workspace-successor-operation',
            dispatchEventId: 'workspace-successor-dispatch',
            workspaceInstanceId: `instance_${'4'.repeat(32)}`,
            terminalKind: 'no_workspace_change' as const,
          },
        },
        refs: {
          operationId: 'workspace-successor-operation',
          toolCallId: 'workspace-successor-call-id',
        },
      },
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
