import { existsSync, writeSync } from 'node:fs';
import type { RuntimeEvent, ToolRecoveryFactEnvelope } from '@maka/core';
import { createSqliteRuntimeStore } from '../../sqlite-runtime-store.js';

const mode = requiredEnv('MAKA_SQLITE_RECOVERY_CONCURRENCY_MODE');
const dbPath = requiredEnv('MAKA_SQLITE_RECOVERY_CONCURRENCY_DB');
const startPath = requiredEnv('MAKA_SQLITE_RECOVERY_CONCURRENCY_START');
const stopPath = process.env.MAKA_SQLITE_RECOVERY_CONCURRENCY_STOP;

writeSync(1, 'READY\n');
while (!existsSync(startPath)) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
}

let store: ReturnType<typeof createSqliteRuntimeStore> | undefined;
try {
  store = createSqliteRuntimeStore(dbPath);
  writeSync(1, 'OPENED\n');
  if (mode === 'open_only') {
    if (!stopPath) throw new Error('Missing MAKA_SQLITE_RECOVERY_CONCURRENCY_STOP');
    while (!existsSync(stopPath)) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  } else if (mode === 'completed') {
    await store.commitToolRecoveryBundle(completedBundle());
  } else if (mode === 'parked') {
    await store.commitToolRecoveryBundle(parkedBundle());
  } else if (mode === 'rebuild') {
    await store.rebuildToolProjectionsFromRuntimeEvents();
  } else {
    throw new Error(`Unknown concurrency mode ${mode}`);
  }
  writeSync(1, 'RESULT ok\n');
} catch (error) {
  writeSync(2, `RESULT error ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
} finally {
  store?.close();
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
