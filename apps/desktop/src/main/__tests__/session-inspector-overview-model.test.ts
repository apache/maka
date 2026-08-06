import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  SESSION_TRACE_SCHEMA_VERSION,
  emptyTraceTotals,
  type SessionTrace,
  type TraceModelAttempt,
  type TraceModelCallStep,
} from '@maka/core/session-trace';
import { deriveInspectorOverviewModel } from '../../renderer/session-inspector-overview-model.js';

const NOW = Date.UTC(2026, 7, 4, 10, 50, 0);

function trace(overrides: Partial<SessionTrace> = {}): SessionTrace {
  return {
    schemaVersion: SESSION_TRACE_SCHEMA_VERSION,
    sessionId: 'session-1',
    turns: [],
    totals: emptyTraceTotals(),
    coverage: {
      modelCalls: 'none',
      turnsMissingModelCalls: [],
      turnsWithFewerModelCallsThanSteps: [],
      unreadableRecords: 0,
    },
    ...overrides,
  };
}

function attempt(overrides: Partial<TraceModelAttempt> = {}): TraceModelAttempt {
  return {
    attemptId: 'attempt-1',
    attempt: 0,
    status: 'completed',
    startedAt: NOW,
    completedAt: NOW + 1_000,
    latencyMs: 1_000,
    costBasis: 'unpriced',
    usageBasis: 'reported',
    ...overrides,
  };
}

function modelCall(overrides: Partial<TraceModelCallStep> = {}): TraceModelCallStep {
  return {
    kind: 'model_call',
    id: 'call-1',
    turnId: 'turn-1',
    runId: 'run-1',
    startedAt: NOW,
    endedAt: NOW + 1_000,
    durationMs: 1_000,
    callKind: 'main',
    providerId: 'zhipu',
    modelId: 'glm-5.1',
    step: 0,
    attempts: [attempt()],
    status: 'completed',
    ...overrides,
  };
}

function turn(steps: SessionTrace['turns'][number]['steps'], overrides: Partial<SessionTrace['turns'][number]> = {}): SessionTrace['turns'][number] {
  return {
    turnId: 'turn-1',
    runId: 'run-1',
    startedAt: NOW,
    endedAt: NOW + 2_000,
    durationMs: 2_000,
    steps,
    totals: emptyTraceTotals(),
    ...overrides,
  };
}

describe('inspector overview model', () => {
  it('is empty for an absent or turnless trace', () => {
    assert.deepEqual(deriveInspectorOverviewModel(undefined), {});
    assert.deepEqual(deriveInspectorOverviewModel(trace()), {});
  });

  it('reads the context budget from the most recent metered main call', () => {
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [
          turn([
            modelCall({
              attempts: [
                attempt({ completedAt: NOW + 1_000, inputTokens: 40_000, contextWindow: 200_000 }),
              ],
            }),
            modelCall({
              id: 'call-2',
              step: 1,
              startedAt: NOW + 2_000,
              endedAt: NOW + 3_000,
              attempts: [
                attempt({
                  attemptId: 'attempt-2',
                  completedAt: NOW + 3_000,
                  inputTokens: 62_000,
                  cacheReadInputTokens: 55_000,
                  contextWindow: 200_000,
                }),
              ],
            }),
          ]),
        ],
      }),
    );

    assert.deepEqual(model.context, {
      usedTokens: 62_000,
      windowTokens: 200_000,
      ratio: 0.31,
      segments: [
        { kind: 'cacheRead', tokens: 55_000 },
        { kind: 'fresh', tokens: 7_000 },
        { kind: 'free', tokens: 138_000 },
      ],
    });
  });

  it('leaves the prompt one band when the provider reported no cache figure', () => {
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [
          turn([
            modelCall({
              attempts: [
                attempt({ completedAt: NOW + 1_000, inputTokens: 50_000, contextWindow: 200_000 }),
              ],
            }),
          ]),
        ],
      }),
    );

    // Not a `cacheRead: 0` band: the provider did not report a miss, it
    // reported nothing, and the bar says exactly that (#1679).
    assert.deepEqual(model.context?.segments, [
      { kind: 'used', tokens: 50_000 },
      { kind: 'free', tokens: 150_000 },
    ]);
  });

  it('drops empty bands and never draws negative headroom', () => {
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [
          turn([
            modelCall({
              attempts: [
                attempt({
                  completedAt: NOW + 1_000,
                  inputTokens: 200_000,
                  cacheReadInputTokens: 200_000,
                  contextWindow: 200_000,
                }),
              ],
            }),
          ]),
        ],
      }),
    );

    assert.deepEqual(model.context?.segments, [
      { kind: 'cacheRead', tokens: 200_000 },
    ]);
  });

  it('ignores attempts without a window or usage when sizing the context', () => {
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [
          turn([
            modelCall({
              attempts: [attempt({ completedAt: NOW + 1_000, inputTokens: 40_000, contextWindow: 200_000 })],
            }),
            modelCall({
              id: 'call-2',
              step: 1,
              startedAt: NOW + 2_000,
              endedAt: NOW + 3_000,
              // A later call the provider never metered must not blank the budget.
              attempts: [attempt({ attemptId: 'attempt-2', completedAt: NOW + 3_000, usageBasis: 'missing' })],
            }),
          ]),
        ],
      }),
    );

    assert.deepEqual(model.context, {
      usedTokens: 40_000,
      windowTokens: 200_000,
      ratio: 0.2,
      segments: [
        { kind: 'used', tokens: 40_000 },
        { kind: 'free', tokens: 160_000 },
      ],
    });
  });

  it('reports no context budget when no call carried both numbers', () => {
    const model = deriveInspectorOverviewModel(
      trace({ turns: [turn([modelCall({ attempts: [attempt({ inputTokens: 12_000 })] })])] }),
    );

    assert.equal(model.context, undefined);
  });

  it('derives the cache hit rate across every attempt that reported input', () => {
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [
          turn([
            modelCall({
              attempts: [
                attempt({
                  inputTokens: 20_000,
                  cacheReadInputTokens: 15_000,
                  outputTokens: 500,
                  reasoningTokens: 120,
                }),
                attempt({
                  attemptId: 'attempt-2',
                  attempt: 1,
                  startedAt: NOW + 1_000,
                  completedAt: NOW + 2_000,
                  inputTokens: 10_000,
                  outputTokens: 300,
                }),
              ],
            }),
          ]),
        ],
      }),
    );

    // 15,000 cached out of 30,000 prompt tokens over the two attempts.
    assert.equal(model.cacheHitRate, 0.5);
  });

  it('leaves the hit rate unknown rather than zero when no input was metered', () => {
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [turn([modelCall({ attempts: [attempt({ outputTokens: 400 })] })])],
      }),
    );

    assert.equal(model.cacheHitRate, undefined);
  });

  it('reads an attempt that reported no cache figure as a miss, not as unknown', () => {
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [
          turn([
            modelCall({
              attempts: [attempt({ inputTokens: 12_000, cacheReadInputTokens: 9_000, outputTokens: 300 })],
            }),
          ]),
        ],
      }),
    );

    assert.equal(model.cacheHitRate, 0.75);
  });


  it('clamps a cache figure larger than the prompt it belongs to', () => {
    // The runtime's own Google mapping guards against `cacheRead > input`, so
    // the pair reaches this model. A share of a prompt over 100% is not a fact.
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [
          turn([modelCall({ attempts: [attempt({ inputTokens: 100, cacheReadInputTokens: 120, contextWindow: 1_000 })] })]),
        ],
      }),
    );

    assert.equal(model.cacheHitRate, 1, 'the bar clamps this; the headline must agree');
    assert.equal(model.context?.segments.find((segment) => segment.kind === 'fresh'), undefined);
    assert.equal(model.context?.segments.find((segment) => segment.kind === 'cacheRead')?.tokens, 100);
  });

  it('drops the free band when the prompt overran its own window', () => {
    const model = deriveInspectorOverviewModel(
      trace({
        turns: [turn([modelCall({ attempts: [attempt({ inputTokens: 1_200, contextWindow: 1_000 })] })])],
      }),
    );

    assert.equal(model.context?.segments.some((segment) => segment.kind === 'free'), false, 'headroom is never negative');
    assert.ok((model.context?.ratio ?? 0) > 1, 'the overrun itself is not hidden');
  });
});
