import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  SESSION_TRACE_SCHEMA_VERSION,
  emptyTraceTotals,
  type SessionTrace,
} from '@maka/core/session-trace';
import { deriveInspectorPanelModel } from '../../renderer/session-inspector-panel-model.js';
import {
  estimatedSessionCost,
  hasUnavailableSessionUsage,
} from '../../renderer/session-inspector-overview-model.js';

test('does not render legacy zero cost as a known free Session', () => {
  const summary = {
    range: { from: 0, to: 1 },
    totalRequests: 1,
    totalCostUsd: 0,
    totalTokens: {
      input: 1,
      output: 1,
      cacheMiss: 1,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
      total: 2,
    },
    cacheHitRequests: 0,
    cacheCreateRequests: 0,
    errorRequests: 0,
    provenance: {
      coverage: {
        attempts: 0,
        pricedAttempts: 0,
        unpricedAttempts: 0,
        usageReportedAttempts: 0,
        usagePartialAttempts: 0,
        usageMissingAttempts: 0,
      },
      legacyRecords: 1,
      unreadableRecords: 0,
      pendingRepairs: 0,
    },
  };
  assert.equal(estimatedSessionCost(summary), undefined);
  assert.equal(estimatedSessionCost({ ...summary, totalCostUsd: 0.01 }), 0.01);
});

test('reports zero recorded requests with incomplete provenance as unavailable', () => {
  assert.equal(
    hasUnavailableSessionUsage({
      range: { from: 0, to: 1 },
      totalRequests: 0,
      totalCostUsd: 0,
      totalTokens: {
        input: 0,
        output: 0,
        cacheMiss: 0,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: 0,
        total: 0,
      },
      cacheHitRequests: 0,
      cacheCreateRequests: 0,
      errorRequests: 0,
      provenance: {
        coverage: {
          attempts: 0,
          pricedAttempts: 0,
          unpricedAttempts: 0,
          usageReportedAttempts: 0,
          usagePartialAttempts: 0,
          usageMissingAttempts: 0,
        },
        legacyRecords: 0,
        unreadableRecords: 1,
        pendingRepairs: 0,
      },
    }),
    true,
  );
});

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
  const turn = deriveInspectorPanelModel(trace).turns[0];
  assert.equal('index' in (turn ?? {}), false);
  assert.equal((turn as { startedAt?: number } | undefined)?.startedAt, 1);
});
