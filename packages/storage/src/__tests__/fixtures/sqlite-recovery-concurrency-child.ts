import { existsSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { type RuntimeEvent } from '@maka/core/runtime-event';
import { type ToolRecoveryFactEnvelope } from '@maka/core/tool-recovery-fact';
import { type WorkspaceBaselineAuthorityInput } from '@maka/core/workspace-version-authority';
import { createRuntimeBoundaryCursor, runtimePrefixSegment } from '@maka/core/runtime-boundary';
import { createSqliteRuntimeStore } from '../../sqlite-runtime-store.js';
import { acquireOperationalStateDatabase } from '../../operational-state-store.js';
import {
  bindWorkspaceBaselineAuthorityStoreRootInternal,
  commitWorkspaceBaselineInternal,
} from '../../workspace-version-authority-internal.js';

const mode = requiredEnv('MAKA_SQLITE_RECOVERY_CONCURRENCY_MODE');
const dbPath = requiredEnv('MAKA_SQLITE_RECOVERY_CONCURRENCY_DB');
const startPath = requiredEnv('MAKA_SQLITE_RECOVERY_CONCURRENCY_START');
const stopPath = process.env.MAKA_SQLITE_RECOVERY_CONCURRENCY_STOP;

writeSync(1, 'READY\n');
while (!existsSync(startPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

let store: ReturnType<typeof createSqliteRuntimeStore> | undefined;
let operationalLease: ReturnType<typeof acquireOperationalStateDatabase> | undefined;
try {
  if (mode === 'operational_open_only') {
    operationalLease = acquireOperationalStateDatabase(dirname(dbPath));
  } else {
    store = createSqliteRuntimeStore(dbPath);
  }
  writeSync(1, 'OPENED\n');
  if (mode === 'open_only' || mode === 'operational_open_only') {
    if (!stopPath) throw new Error('Missing MAKA_SQLITE_RECOVERY_CONCURRENCY_STOP');
    while (!existsSync(stopPath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  } else if (mode === 'completed') {
    await store!.commitToolRecoveryBundle(completedBundle());
  } else if (mode === 'parked') {
    await store!.commitToolRecoveryBundle(parkedBundle());
  } else if (mode === 'rebuild') {
    await store!.rebuildToolProjectionsFromRuntimeEvents();
  } else if (mode === 'workspace_baseline_a' || mode === 'workspace_baseline_b') {
    bindWorkspaceBaselineAuthorityStoreRootInternal(store!, 'a'.repeat(64));
    const result = await commitWorkspaceBaselineInternal(
      store!,
      workspaceBaselineInput(mode === 'workspace_baseline_b' ? 'b' : 'a'),
    );
    writeSync(1, `BASELINE ${result.created ? 'created' : 'existing'}\n`);
  } else if (mode === 'append_source') {
    await store!.ensureTerminalRuntimeEventDurable('session-1', 'run-1', {
      ...baseEvent('concurrent-source-terminal', 3),
      status: 'failed',
      actions: {
        endInvocation: true,
        stateDelta: { failureClass: 'runtime_interrupted' },
      },
    });
    writeSync(1, 'APPEND committed\n');
  } else if (mode === 'append_target') {
    await store!.appendRuntimeEvent('session-1', 'fixed-target-run', {
      id: `target-event-${process.pid}`,
      sessionId: 'session-1',
      invocationId: 'fixed-target-invocation',
      runId: 'fixed-target-run',
      turnId: 'fixed-target-turn',
      ts: process.pid,
      partial: false,
      role: 'model',
      author: 'agent',
      content: { kind: 'text', text: 'racing ordinary target event' },
    });
    writeSync(1, 'TARGET_APPEND committed\n');
  } else if (mode === 'claim' || mode === 'claim_fixed_target' || mode === 'claim_nonterminal') {
    const sourceRunId = mode === 'claim_nonterminal' ? 'run-1' : 'continuation-source-run';
    const prefix = await store!.readImmutableRuntimePrefix({
      sessionId: 'session-1',
      runId: sourceRunId,
      ...(mode === 'claim_nonterminal' ? { upToEventSeq: 2 } : {}),
    });
    const boundary = createRuntimeBoundaryCursor([runtimePrefixSegment(prefix)]);
    const source = boundary.segments.at(-1)!;
    const target =
      mode === 'claim_fixed_target'
        ? {
            sessionId: 'session-1',
            invocationId: 'fixed-target-invocation',
            runId: 'fixed-target-run',
            turnId: 'fixed-target-turn',
          }
        : {
            sessionId: 'session-1',
            invocationId: `invocation-${process.pid}`,
            runId: `run-${process.pid}`,
            turnId: `turn-${process.pid}`,
          };
    const result = await store!.claimContinuation({
      claim: {
        protocol: 'continuation_claim_v1',
        claimId: `claim-${process.pid}`,
        boundaryDigest: boundary.manifestDigest,
        boundary,
        providerProjectionVersion: 1,
        providerReplayDigest: `sha256:${'a'.repeat(64)}`,
        target,
        targetRunHeader: {
          ...target,
          status: 'created',
          backendKind: 'fake',
          llmConnectionSlug: 'connection-1',
          modelId: 'model-1',
          cwd: '/workspace/repo',
          permissionMode: 'ask',
          collaborationMode: 'agent',
          orchestrationMode: 'default',
          orchestrationSource: 'session',
          agentSwarmAuthorization: 'none',
          createdAt: process.pid,
          updatedAt: process.pid,
          parentRunId: source.identity.runId,
          parentTurnId: source.identity.turnId,
          continuationSource: {
            protocol: 'continuation_source_v2',
            claimId: `claim-${process.pid}`,
            boundaryDigest: boundary.manifestDigest,
            sourceInvocationId: source.identity.invocationId,
            sourceRunId: source.identity.runId,
            sourceTurnId: source.identity.turnId,
            sourceRuntimeEventHighWater: source.position.lastEventSeq,
            sourcePrefixDigest: source.prefixDigest,
            replayManifestDigest: boundary.manifestDigest,
          },
        },
        claimedAt: process.pid,
      },
    });
    writeSync(1, `CLAIM ${result.kind}\n`);
  } else {
    throw new Error(`Unknown concurrency mode ${mode}`);
  }
  writeSync(1, 'RESULT ok\n');
} catch (error) {
  writeSync(2, `RESULT error ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  store?.close();
  operationalLease?.close();
}

function completedBundle() {
  return {
    operationId: 'operation-1',
    reconcileRuntimeEvent: recoveryFact(
      'completed-reconcile',
      'maka.tool.reconcile_result',
      {
        protocol: 'tool_reconcile_v1',
        operationId: 'operation-1',
        observation: 'matches_expected_state',
        observationSchema: 'state_identity_v1',
        observationDigest:
          'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
      3,
    ),
    outcomeRuntimeEvent: outcomeEvent(),
    decisionRuntimeEvent: recoveryFact(
      'completed-decision',
      'maka.tool.recovery_decision',
      {
        protocol: 'tool_recovery_v1',
        operationId: 'operation-1',
        disposition: 'completed',
        reasonCode: 'reconcile_matches_expected_state',
        outcomeEventId: 'completed-outcome',
        evidenceEventIds: [
          'call-event-1',
          'dispatch-event-1',
          'completed-reconcile',
          'completed-outcome',
        ],
      },
      5,
    ),
  } as const;
}

function parkedBundle() {
  return {
    operationId: 'operation-1',
    reconcileRuntimeEvent: recoveryFact(
      'parked-reconcile',
      'maka.tool.reconcile_result',
      {
        protocol: 'tool_reconcile_v1',
        operationId: 'operation-1',
        observation: 'diverged',
        observationSchema: 'state_identity_v1',
        observationDigest:
          'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      3,
    ),
    decisionRuntimeEvent: recoveryFact(
      'parked-decision',
      'maka.tool.recovery_decision',
      {
        protocol: 'tool_recovery_v1',
        operationId: 'operation-1',
        disposition: 'parked',
        reasonCode: 'reconcile_diverged',
        evidenceEventIds: ['call-event-1', 'dispatch-event-1', 'parked-reconcile'],
      },
      4,
    ),
  } as const;
}

function outcomeEvent(): RuntimeEvent {
  return {
    ...baseEvent('completed-outcome', 4),
    role: 'tool',
    author: 'tool',
    content: {
      kind: 'function_response',
      id: 'provider-call-1',
      name: 'Write',
      result: 'ok',
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
  };
}

function recoveryFact(
  id: string,
  kind: 'maka.tool.reconcile_result' | 'maka.tool.recovery_decision',
  payload: Record<string, unknown>,
  ts: number,
): RuntimeEvent {
  return {
    ...baseEvent(id, ts),
    actions: {
      toolRecovery: { kind, version: 1, payload } as unknown as ToolRecoveryFactEnvelope,
    },
    refs: { operationId: 'operation-1', toolCallId: 'provider-call-1' },
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

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function workspaceBaselineInput(variant: 'a' | 'b'): WorkspaceBaselineAuthorityInput {
  const alternate = variant === 'b';
  return {
    epochOpenedEventId: alternate ? 'workspace-epoch-event-b' : 'workspace-epoch-event-a',
    baselineAcceptedEventId: alternate ? 'workspace-version-event-b' : 'workspace-version-event-a',
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
      workspaceVersionId: `version_${(alternate ? '9' : '5').repeat(32)}`,
      commitOid: (alternate ? '9' : '5').repeat(40),
      treeOid: '2'.repeat(40),
      treeDeltaDigest: `sha256:${'6'.repeat(64)}`,
      changedFileCount: 7,
      deletedFileCount: 0,
    },
  };
}
