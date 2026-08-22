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

/**
 * Session Inspector trace projection (#1625).
 *
 * Run: `npm --workspace @maka/runtime run test`
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MODEL_CALL_ATTEMPT_SCHEMA_VERSION,
  type ModelCallAttempt,
} from '@maka/core/model-call-attempt';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { isSessionTrace } from '@maka/core/session-trace';
import { projectSessionTrace } from '../session-trace-projection.js';

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

function event(overrides: Partial<RuntimeEvent> = {}): RuntimeEvent {
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

describe('session trace projection', () => {
  test('keeps the same turn identity separate across distinct runs', () => {
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [],
      modelCallAttempts: [
        attempt({ runId: 'run-1', logicalCallId: 'call-1', attemptId: 'attempt-1' }),
        attempt({
          runId: 'run-2',
          logicalCallId: 'call-2',
          attemptId: 'attempt-2',
          startedAt: 2_000,
          completedAt: 2_500,
        }),
      ],
    });

    assert.deepEqual(
      trace.turns.map(({ runId, turnId }) => ({ runId, turnId })),
      [
        { runId: 'run-1', turnId: 'turn-1' },
        { runId: 'run-2', turnId: 'turn-1' },
      ],
    );
  });

  test('preserves durable history-compaction route and provider failure facts', () => {
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [],
      modelCallAttempts: [
        attempt({
          callKind: 'history_compact',
          historyCompactRoute: 'provider_native',
          status: 'failed',
          usageBasis: 'missing',
          inputTokens: undefined,
          outputTokens: undefined,
          costBasis: 'unpriced',
          costUsd: undefined,
          errorClass: 'RequestRejected',
          httpStatus: 400,
          providerCode: 'invalid_request_error',
          providerRequestId: 'req-compact-1',
          retryable: false,
        }),
      ],
    });

    const step = trace.turns[0]?.steps[0];
    assert.equal(step?.kind, 'model_call');
    if (step?.kind !== 'model_call') return;
    assert.equal(step.historyCompactRoute, 'provider_native');
    assert.deepEqual(step.attempts[0], {
      attemptId: 'attempt-1',
      attempt: 0,
      status: 'failed',
      startedAt: 1_000,
      completedAt: 1_500,
      latencyMs: 500,
      errorClass: 'RequestRejected',
      httpStatus: 400,
      providerCode: 'invalid_request_error',
      providerRequestId: 'req-compact-1',
      retryable: false,
      costBasis: 'unpriced',
      usageBasis: 'missing',
    });
    assert.equal(isSessionTrace(trace), true, 'the Host protocol accepts the projected trace');
  });

  test('an entirely unpriced logical call keeps its step cost absent', () => {
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [],
      modelCallAttempts: [attempt({ costUsd: undefined, costBasis: 'unpriced' })],
    });

    const call = trace.turns[0]?.steps[0];
    assert.equal(call?.kind, 'model_call');
    if (call?.kind !== 'model_call') return;
    assert.equal(call.costUsd, undefined, 'absent price is not a zero price');
    assert.equal(call.attempts[0]?.costBasis, 'unpriced');
  });

  test('a logical call sums its priced retry attempts and ignores unpriced ones', () => {
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [],
      modelCallAttempts: [
        attempt({ attemptId: 'attempt-0', attempt: 0, costUsd: 0.001 }),
        attempt({
          attemptId: 'attempt-1',
          attempt: 1,
          costUsd: undefined,
          costBasis: 'unpriced',
        }),
        attempt({ attemptId: 'attempt-2', attempt: 2, costUsd: 0.002 }),
      ],
    });

    const call = trace.turns[0]?.steps[0];
    assert.equal(call?.kind, 'model_call');
    if (call?.kind !== 'model_call') return;
    assert.equal(call.attempts.length, 3);
    assert.equal(call.costUsd, 0.003);
  });

  test('attributes a turn failure to what failed first, not to the terminal error', () => {
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [
        event({
          id: 'dispatch-1',
          ts: 1_000,
          actions: {
            toolDispatch: {
              protocol: 't1_after_preflight_v1',
              operationId: 'op-1',
              providerToolCallId: 'tool-call-1',
              toolName: 'Bash',
              canonicalArgsHash: 'hash',
              recoveryMode: 'replay_safe',
            },
          },
        }),
        event({
          id: 'response-1',
          ts: 1_200,
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-call-1',
            name: 'Bash',
            result: 'boom',
            isError: true,
          },
        }),
        event({
          id: 'error-1',
          ts: 2_000,
          content: { kind: 'error', message: 'turn ended after tool failure' },
        }),
      ],
      modelCallAttempts: [],
    });

    const failure = trace.turns[0]!.failure;
    assert.ok(failure);
    assert.equal(failure.code, 'tool_failed');
    assert.equal(failure.attributedToStepId, 'dispatch-1', 'the symptom is not the cause');
    assert.equal(failure.message, 'turn ended after tool failure');
  });

  test('reports a backend that emits no canonical records instead of rendering an idle session', () => {
    // The pi backend emits `token_usage` and no `ModelCallAttempt` at all. An
    // empty timeline would be indistinguishable from a session that did nothing.
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [
        event({
          id: 'usage-1',
          ts: 1_000,
          actions: { tokenUsage: { input: 100, output: 20, total: 120 } },
        }),
      ],
      modelCallAttempts: [],
    });

    assert.equal(trace.coverage.modelCalls, 'absent');
    assert.deepEqual(trace.coverage.turnsMissingModelCalls, [{ runId: 'run-1', turnId: 'turn-1' }]);
  });

  test('known unreadable evidence makes an otherwise absent backend partial', () => {
    for (const gap of [{ unreadableRecords: 1 }, { oversizedRuns: 1 }]) {
      const trace = projectSessionTrace({
        sessionId: 'session-1',
        runtimeEvents: [
          event({
            id: 'usage-1',
            ts: 1_000,
            actions: { tokenUsage: { input: 100, output: 20, total: 120 } },
          }),
        ],
        modelCallAttempts: [],
        ...gap,
      });

      assert.equal(trace.coverage.modelCalls, 'partial');
    }
  });

  test('distinguishes a partially covered session from a wholly uncovered one', () => {
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [
        event({
          id: 'usage-1',
          turnId: 'turn-1',
          ts: 1_000,
          actions: { tokenUsage: { input: 100, output: 20, total: 120 } },
        }),
        event({
          id: 'usage-2',
          turnId: 'turn-2',
          ts: 3_000,
          actions: { tokenUsage: { input: 50, output: 10, total: 60 } },
        }),
      ],
      modelCallAttempts: [attempt({ turnId: 'turn-2', startedAt: 3_000, completedAt: 3_200 })],
    });

    assert.equal(trace.coverage.modelCalls, 'partial');
    assert.deepEqual(trace.coverage.turnsMissingModelCalls, [{ runId: 'run-1', turnId: 'turn-1' }]);
    assert.equal(trace.turns.map((turn) => turn.turnId).join(','), 'turn-1,turn-2');
  });

  test('a session with no model activity is uncovered rather than incomplete', () => {
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [event({ content: { kind: 'text', text: 'hi' } })],
      modelCallAttempts: [],
    });

    assert.equal(trace.coverage.modelCalls, 'none');
    assert.deepEqual(trace.coverage.turnsMissingModelCalls, []);
  });

  test('collapses a re-appended settlement instead of inventing a retry', () => {
    // A provisional abort and its later settlement are appended under one
    // `attemptId`. The ledger dedupes on write; a stream read does not, so
    // without collapsing them the trace shows a retry that never happened and
    // bills the priced settlement twice.
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [],
      modelCallAttempts: [
        attempt({ attemptId: 'a-0', status: 'aborted', costUsd: undefined, costBasis: 'unpriced' }),
        attempt({ attemptId: 'a-0', status: 'completed', costUsd: 0.002 }),
      ],
    });

    const call = trace.turns[0]!.steps[0]!;
    assert.equal(call.kind, 'model_call');
    if (call.kind !== 'model_call') return;
    assert.equal(call.attempts.length, 1, 'one attempt id is one attempt');
    assert.equal(call.status, 'completed', 'the later settlement wins');
    assert.equal(call.costUsd, 0.002, 'not double-counted against Settings → Usage');
    assert.equal(call.attempts[0]?.costBasis, 'priced');
  });

  test('reports a shortfall when usage stands for more steps than there are calls', () => {
    // `runtimeSteps` says how many tool-loop steps one aggregate usage event
    // represents, and each is a main call. Fewer on record is a gap the two
    // ledgers disagree about — a floor on what is missing, not a count.
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [
        event({
          id: 'usage-1',
          ts: 2_000,
          actions: { tokenUsage: { input: 100, output: 20, total: 120, runtimeSteps: 2 } },
        }),
      ],
      modelCallAttempts: [attempt()],
    });

    assert.equal(trace.coverage.modelCalls, 'partial');
    assert.deepEqual(trace.coverage.turnsWithFewerModelCallsThanSteps, [
      { runId: 'run-1', turnId: 'turn-1' },
    ]);
    assert.deepEqual(trace.coverage.turnsMissingModelCalls, []);
  });

  test('a matching turn is reported as no known gap rather than as proven complete', () => {
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [
        event({
          id: 'usage-1',
          ts: 2_000,
          actions: { tokenUsage: { input: 100, output: 20, total: 120, runtimeSteps: 1 } },
        }),
      ],
      modelCallAttempts: [attempt()],
    });

    assert.equal(trace.coverage.modelCalls, 'no_known_gap');
    assert.deepEqual(trace.coverage.turnsWithFewerModelCallsThanSteps, []);
  });

  test('a tool failure the turn recovered from does not fail the turn', () => {
    // The ledger's terminal verdict decides whether the turn failed; the failed
    // step only locates a cause once that is established.
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [
        event({
          id: 'dispatch-1',
          ts: 1_000,
          actions: {
            toolDispatch: {
              protocol: 't1_after_preflight_v1',
              operationId: 'op-1',
              providerToolCallId: 'tool-call-1',
              toolName: 'Bash',
              canonicalArgsHash: 'hash',
              recoveryMode: 'replay_safe',
            },
          },
        }),
        event({
          id: 'response-1',
          ts: 1_200,
          role: 'tool',
          author: 'tool',
          content: {
            kind: 'function_response',
            id: 'tool-call-1',
            name: 'Bash',
            result: 'boom',
            isError: true,
          },
        }),
        event({
          id: 'final-1',
          ts: 2_000,
          status: 'completed',
          content: { kind: 'text', text: 'recovered and finished' },
        }),
      ],
      modelCallAttempts: [],
    });

    assert.equal(trace.turns[0]?.failure, undefined, 'a handled failure is not a failed turn');
    const tool = trace.turns[0]!.steps.find((step) => step.kind === 'tool');
    assert.equal(
      tool?.kind === 'tool' ? tool.status : undefined,
      'failed',
      'the step still failed',
    );
  });

  test('an unreadable record is a known gap even with no other evidence of one', () => {
    // The reader counts what it could not decode; the projection has to carry
    // that through, or spend nobody can see reads as a clean session.
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [],
      modelCallAttempts: [attempt()],
      unreadableRecords: 2,
    });

    assert.equal(trace.coverage.unreadableRecords, 2);
    assert.equal(trace.coverage.modelCalls, 'partial', 'records nobody can read are a gap');
  });

  test('a session that is only unreadable records is still a covered session', () => {
    const trace = projectSessionTrace({
      sessionId: 'session-1',
      runtimeEvents: [],
      modelCallAttempts: [],
      unreadableRecords: 1,
    });

    assert.equal(trace.coverage.modelCalls, 'partial');
    assert.equal(trace.coverage.unreadableRecords, 1);
    assert.notEqual(trace.coverage.modelCalls, 'none', 'not "nothing happened"');
  });
});
