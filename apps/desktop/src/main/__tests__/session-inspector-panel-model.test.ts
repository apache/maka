import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SESSION_TRACE_SCHEMA_VERSION,
  emptyTraceTotals,
  type SessionTrace,
} from '@maka/core/session-trace';
import { deriveInspectorPanelModel } from '../../renderer/session-inspector-panel-model.js';

test('shows one compact diagnostic line for a failed history-compaction call', () => {
  const trace: SessionTrace = {
    schemaVersion: SESSION_TRACE_SCHEMA_VERSION,
    sessionId: 'session-1',
    turns: [
      {
        turnId: 'turn-1',
        runId: 'run-1',
        startedAt: 1,
        endedAt: 10,
        durationMs: 9,
        steps: [
          {
            kind: 'model_call',
            id: 'call-compact-1',
            turnId: 'turn-1',
            runId: 'run-1',
            startedAt: 1,
            endedAt: 10,
            durationMs: 9,
            callKind: 'history_compact',
            historyCompactRoute: 'provider_native',
            providerId: 'openai-codex',
            modelId: 'gpt-5.6-luna',
            step: 0,
            status: 'failed',
            attempts: [
              {
                attemptId: 'attempt-compact-1',
                attempt: 0,
                status: 'failed',
                startedAt: 1,
                completedAt: 10,
                latencyMs: 9,
                errorClass: 'RequestRejected',
                httpStatus: 400,
                providerCode: 'invalid_request_error',
                providerRequestId: 'req-compact-1',
                retryable: false,
                costBasis: 'unpriced',
                usageBasis: 'missing',
              },
            ],
          },
        ],
        totals: {
          ...emptyTraceTotals(),
          durationMs: 9,
          modelAttempts: 1,
          unpricedAttempts: 1,
        },
      },
    ],
    totals: {
      ...emptyTraceTotals(),
      durationMs: 9,
      modelAttempts: 1,
      unpricedAttempts: 1,
    },
    coverage: {
      modelCalls: 'no_known_gap',
      turnsMissingModelCalls: [],
      turnsWithFewerModelCallsThanSteps: [],
      unreadableRecords: 0,
    },
  };

  const row = deriveInspectorPanelModel(trace).turns[0]?.steps[0];
  assert.equal(row?.callKind, 'history_compact');
  assert.equal(
    row?.detail,
    'route=provider_native · error=RequestRejected · HTTP 400 · code=invalid_request_error · request=req-compact-1 · retryable=false',
  );
});
