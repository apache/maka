import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  MODEL_CALL_ATTEMPT_EVENT_TYPE,
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { readSessionTrace, registerInspectorIpc } from '../inspector-ipc-main.js';

function attempt(overrides: Partial<ModelCallAttempt> = {}): ModelCallAttempt {
  return {
    schemaVersion: MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
    logicalCallId: 'call-1',
    attemptId: 'attempt-1',
    traceId: 'trace-1',
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    step: 0,
    attempt: 0,
    callKind: 'main',
    providerId: 'anthropic',
    modelId: 'claude-test',
    startedAt: 1_000,
    completedAt: 1_500,
    latencyMs: 500,
    status: 'completed',
    usageBasis: 'reported',
    inputTokens: 10,
    outputTokens: 5,
    costBasis: 'priced',
    costUsd: 0.002,
    ...overrides,
  };
}

function runtimeEvent(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
  return {
    id: 'event-1',
    invocationId: 'invocation-1',
    runId: 'run-1',
    sessionId: 'session-1',
    turnId: 'turn-1',
    ts: 1_000,
    partial: false,
    role: 'model',
    author: 'agent',
    ...overrides,
  };
}

describe('inspector trace read', () => {
  it('joins the AgentRun stream with the session runtime events', async () => {
    // The canonical metering authority is the run stream, not the Usage read
    // model — that one is range-queried and carries no session predicate.
    const readRuns: string[] = [];
    const trace = await readSessionTrace(
      {
        readSessionRuntimeEvents: async () => [
          runtimeEvent({
            id: 'usage-1',
            ts: 2_000,
            actions: { tokenUsage: { input: 10, output: 5, total: 15, runtimeSteps: 1 } },
          }),
        ],
        listSessionRuns: async () => [{ runId: 'run-1' }, { runId: 'run-2' }],
        readRunEvents: async (_sessionId, runId) => {
          readRuns.push(runId);
          return runId === 'run-1'
            ? [
                { type: 'run_started' },
                { type: MODEL_CALL_ATTEMPT_EVENT_TYPE, data: attempt() },
              ]
            : [];
        },
      },
      'session-1',
    );

    assert.deepEqual(readRuns, ['run-1', 'run-2'], 'every run of the session is read');
    assert.equal(trace.sessionId, 'session-1');
    assert.equal(trace.totals.modelAttempts, 1);
    assert.equal(trace.totals.costUsd, 0.002);
    assert.equal(trace.coverage.modelCalls, 'no_known_gap');
    assert.equal(trace.coverage.unreadableRecords, 0);
  });

  it('counts a record it cannot decode instead of dropping it', async () => {
    // An undecodable record is spend the trace cannot show. Silently skipping
    // it would make an incomplete trace look complete.
    const trace = await readSessionTrace(
      {
        readSessionRuntimeEvents: async () => [],
        listSessionRuns: async () => [{ runId: 'run-1' }],
        readRunEvents: async () => [
          { type: MODEL_CALL_ATTEMPT_EVENT_TYPE, data: attempt() },
          { type: MODEL_CALL_ATTEMPT_EVENT_TYPE, data: { schemaVersion: 1, broken: true } },
        ],
      },
      'session-1',
    );

    assert.equal(trace.totals.modelAttempts, 1, 'the readable record still projects');
    assert.equal(trace.coverage.unreadableRecords, 1);
    assert.equal(trace.coverage.modelCalls, 'partial', 'an unreadable record is a known gap');
  });

  it('ignores AgentRun events that are not canonical model calls', async () => {
    const trace = await readSessionTrace(
      {
        readSessionRuntimeEvents: async () => [],
        listSessionRuns: async () => [{ runId: 'run-1' }],
        readRunEvents: async () => [
          { type: 'provider_request_attempt_recorded', data: { step: 0 } },
          { type: 'run_completed' },
        ],
      },
      'session-1',
    );

    assert.equal(trace.turns.length, 0);
    assert.equal(trace.coverage.modelCalls, 'none');
  });

  it('answers a failed read as a typed error rather than a rejected invoke', async () => {
    // The renderer treats the channel as `Result`; an unwrapped rejection would
    // surface as an unhandled invoke failure instead of a retryable panel state.
    const handlers = new Map<string, (event: unknown, ...args: never[]) => unknown>();
    registerInspectorIpc({
      ipcMain: {
        handle: (channel: string, handler: (event: unknown, ...args: never[]) => unknown) => {
          handlers.set(channel, handler);
        },
      } as never,
      readSessionRuntimeEvents: async () => {
        throw new Error('ledger unavailable');
      },
      listSessionRuns: async () => [],
      readRunEvents: async () => [],
    });

    const handler = handlers.get('inspector:trace');
    assert.ok(handler, 'the channel is registered');
    const result = (await handler(undefined, 'session-1' as never)) as {
      ok: boolean;
      error?: { code: string };
    };
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, 'INSPECTOR_TRACE_FAILED');
  });
});
