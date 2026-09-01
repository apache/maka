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
import { describe, test } from 'node:test';

import type { AgentRunHeader } from '@maka/core/agent-run';
import type { SessionEvent } from '@maka/core/events';
import type { BackendSessionEvent } from '@maka/core/backend-types';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import {
  decodeRuntimeEvent,
  isTerminalRuntimeEvent,
  isPartialRuntimeEvent,
} from '@maka/core/runtime-event';

import {
  mapCompleteStopReason,
  mapSessionEventToRuntimeEvent,
  createSessionEventMapMemory,
  isLiveBackendSessionEvent,
} from '../session-event-runtime-mapper.js';
import type { RuntimeEventMapContext } from '../session-event-runtime-mapper.js';
import {
  isUnclaimedRuntimeEventDiagnostic,
  projectRuntimeEventsToStoredMessages,
} from '../runtime-event-read-model.js';
import { isNonTerminalErrorRuntimeEvent } from '../agent-run.js';
import { backfillRuntimeEventsFromStoredMessages } from '../runtime-event-backfill.js';

// ============================================================================
// Event builders
// ============================================================================

let __seq = 0;
type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;
function ev(
  e: DistributiveOmit<SessionEvent, 'id' | 'turnId' | 'ts'> & Partial<Pick<SessionEvent, 'ts'>>,
): SessionEvent {
  __seq += 1;
  return { id: `evt-${__seq}`, turnId: 'turn-1', ts: e.ts ?? __seq, ...e } as SessionEvent;
}

const ctx = {
  sessionId: 'session-1',
  invocationId: 'inv-1',
  runId: 'run-1',
  turnId: 'turn-1',
  now: () => 1000,
} satisfies RuntimeEventMapContext;

// ============================================================================
// Tests
// ============================================================================

describe('SessionEvent Runtime mapper', () => {
  test('maps the original steering content digest into the durable Runtime event', () => {
    const digest = `sha256:${'a'.repeat(64)}` as const;
    const runtimeEvent = mapSessionEventToRuntimeEvent(
      {
        id: 'steering-event',
        turnId: 'turn-1',
        ts: 1,
        type: 'steering_message',
        messageId: 'steering-message',
        content: { text: '<invoked-skill>Prepared</invoked-skill>' },
        submittedContentDigest: digest,
      },
      ctx,
    );

    assert.equal(runtimeEvent.refs?.sourceMessageDigest, digest);
  });

  test('maps provider retry progress as a partial non-terminal runtime fact', () => {
    const retry = ev({
      type: 'provider_retry',
      phase: 'scheduled',
      attempt: 2,
      maxAttempts: 10,
      delayMs: 4_000,
      reason: 'rate_limit',
    });

    const mapped = mapSessionEventToRuntimeEvent(retry, ctx);

    assert.equal(mapped.partial, true);
    assert.equal(isTerminalRuntimeEvent(mapped), false);
    assert.deepEqual(mapped.actions?.stateDelta, {
      providerRetry: {
        phase: 'scheduled',
        attempt: 2,
        maxAttempts: 10,
        delayMs: 4_000,
        reason: 'rate_limit',
      },
    });
  });

  test('maps provider capacity retry progress without collapsing its reason', () => {
    const retry = ev({
      type: 'provider_retry',
      phase: 'scheduled',
      attempt: 2,
      maxAttempts: 10,
      delayMs: 4_000,
      reason: 'provider_capacity',
    });

    const mapped = mapSessionEventToRuntimeEvent(retry, ctx);

    assert.deepEqual(mapped.actions?.stateDelta, {
      providerRetry: {
        phase: 'scheduled',
        attempt: 2,
        maxAttempts: 10,
        delayMs: 4_000,
        reason: 'provider_capacity',
      },
    });
  });
});

// ============================================================================
// Pure mapping unit tests
// ============================================================================

describe('mapSessionEventToRuntimeEvent (pure)', () => {
  test('mapCompleteStopReason covers all stop reasons', () => {
    assert.equal(mapCompleteStopReason('end_turn'), 'completed');
    assert.equal(mapCompleteStopReason('max_tokens'), 'completed');
    assert.equal(mapCompleteStopReason('plan_handoff'), 'completed');
    assert.equal(mapCompleteStopReason('graph_yield'), 'completed');
    assert.equal(mapCompleteStopReason('permission_handoff'), 'completed');
    assert.equal(mapCompleteStopReason('user_stop'), 'aborted');
    assert.equal(mapCompleteStopReason('error'), 'failed');
    assert.equal(mapCompleteStopReason('step_limit'), 'failed');
  });

  test('step_limit uses the established tool-step-cap failure class', () => {
    const mapped = mapSessionEventToRuntimeEvent(
      ev({ type: 'complete', stopReason: 'step_limit' }),
      ctx,
      createSessionEventMapMemory(),
    );

    assert.deepEqual(mapped.actions?.stateDelta, {
      stopReason: 'step_limit',
      failureClass: 'tool_step_cap_reached',
    });
  });

  test('context_budget_exhausted keeps its detail in the durable terminal state', () => {
    const mapped = mapSessionEventToRuntimeEvent(
      ev({
        type: 'complete',
        stopReason: 'context_budget_exhausted',
        contextBudgetExhaustedDetail: 'head_anchor_exceeds_capacity',
      }),
      ctx,
      createSessionEventMapMemory(),
    );

    assert.equal(mapped.status, 'failed');
    assert.deepEqual(mapped.actions?.stateDelta, {
      stopReason: 'context_budget_exhausted',
      failureClass: 'context_budget_exhausted',
      contextBudgetExhaustedDetail: 'head_anchor_exceeds_capacity',
    });
  });

  test('tool_output_delta and tool_progress map to partial tool-role heartbeats', () => {
    const mem = createSessionEventMapMemory();
    const a = mapSessionEventToRuntimeEvent(
      ev({
        type: 'tool_output_delta',
        sessionId: 'session-1',
        toolCallId: 'tu-1',
        toolUseId: 'tu-1',
        seq: 1,
        stream: 'stdout',
        chunk: 'c',
        redacted: false,
        createdAt: 1,
      }),
      ctx,
      mem,
    );
    assert.equal(a.partial, true);
    assert.equal(a.role, 'tool');
    assert.equal(a.author, 'tool');
    assert.equal(a.refs?.toolCallId, 'tu-1');

    const b = mapSessionEventToRuntimeEvent(
      ev({ type: 'tool_progress', toolUseId: 'tu-1', chunk: 'c' }),
      ctx,
      mem,
    );
    assert.equal(b.partial, true);
    assert.equal(b.role, 'tool');
  });

  test('tool activity mapping retains nested CodeMode replay and parent identity', () => {
    const memory = createSessionEventMapMemory();
    const start = mapSessionEventToRuntimeEvent(
      ev({
        type: 'tool_start',
        toolUseId: 'nested-1',
        toolName: 'Read',
        operationId: 'nested-op-1',
        args: {},
        origin: 'code_mode',
        modelVisibility: 'hidden',
        parentToolCallId: 'exec-1',
        parentOperationId: 'exec-op-1',
      }),
      ctx,
      memory,
    );
    const result = mapSessionEventToRuntimeEvent(
      ev({
        type: 'tool_result',
        toolUseId: 'nested-1',
        operationId: 'nested-op-1',
        isError: false,
        content: { kind: 'text', text: 'ok' },
        origin: 'code_mode',
        modelVisibility: 'hidden',
        parentToolCallId: 'exec-1',
        parentOperationId: 'exec-op-1',
      }),
      ctx,
      memory,
    );

    for (const event of [start, result]) {
      assert.equal(event.origin, 'code_mode');
      assert.equal(event.modelVisibility, 'hidden');
      assert.equal(event.refs?.parentToolCallId, 'exec-1');
      assert.equal(event.refs?.parentOperationId, 'exec-op-1');
    }
  });

  test('owns independent tool args across SessionEvent to RuntimeEvent mappings', () => {
    const sourceArgs = { content: 'approved', layout: { cols: 120 } };
    const sourceEvent = ev({
      type: 'tool_start',
      toolUseId: 'tu-owned',
      toolName: 'Write',
      args: sourceArgs,
    });
    const mapped = mapSessionEventToRuntimeEvent(sourceEvent, ctx, createSessionEventMapMemory());
    const mappedArgs = (
      mapped.content?.kind === 'function_call' ? mapped.content.args : undefined
    ) as typeof sourceArgs;

    assert.notStrictEqual(mappedArgs, sourceArgs);
    assert.notStrictEqual(mappedArgs.layout, sourceArgs.layout);
    sourceArgs.layout.cols = 80;
    assert.equal(mappedArgs.layout.cols, 120);
    mappedArgs.content = 'runtime';
    assert.equal(sourceArgs.content, 'approved');
  });

  test('plan_submitted maps to an agent-authored state delta', () => {
    const a = mapSessionEventToRuntimeEvent(
      ev({ type: 'plan_submitted', planId: 'p1', title: 'T', markdownPath: '/p.md' }),
      ctx,
    );
    assert.equal(a.role, 'system');
    assert.equal(a.author, 'agent');
    assert.deepEqual(a.actions?.stateDelta, { planId: 'p1', title: 'T', markdownPath: '/p.md' });
  });

  test('user_question_request maps to one system-authored runtime action', () => {
    const mapped = mapSessionEventToRuntimeEvent(
      ev({
        type: 'user_question_request',
        requestId: 'question-1',
        toolUseId: 'tool-1',
        questions: [
          {
            question: 'Choose an approach',
            options: [
              { label: 'Extend', description: 'Reuse the runtime seam' },
              { label: 'Separate' },
            ],
          },
        ],
      }),
      ctx,
    );

    assert.equal(mapped.role, 'system');
    assert.equal(mapped.author, 'system');
    assert.deepEqual(mapped.actions?.userQuestionRequest, {
      requestId: 'question-1',
      toolUseId: 'tool-1',
      questions: [
        {
          question: 'Choose an approach',
          options: [
            { label: 'Extend', description: 'Reuse the runtime seam' },
            { label: 'Separate' },
          ],
        },
      ],
    });
  });

  test('user_question_answer_ack maps without duplicating the canonical answer', () => {
    const mapped = mapSessionEventToRuntimeEvent(
      ev({
        type: 'user_question_answer_ack',
        requestId: 'question-1',
        toolUseId: 'tool-1',
      }),
      ctx,
    );

    assert.equal(mapped.role, 'system');
    assert.equal(mapped.author, 'user');
    assert.deepEqual(mapped.actions?.userQuestionAnswerAccepted, {
      requestId: 'question-1',
    });
    assert.equal(mapped.refs?.toolCallId, 'tool-1');
  });

  test('tool_result without a prior tool_start still maps (name falls back to empty)', () => {
    const a = mapSessionEventToRuntimeEvent(
      ev({
        type: 'tool_result',
        toolUseId: 'orphan',
        isError: true,
        content: { kind: 'text', text: 'boom' },
      }),
      ctx,
    );
    const fnResp = a.content as { name: string; isError?: boolean };
    assert.equal(fnResp.name, '');
    assert.equal(fnResp.isError, true);
  });

  test('branch is propagated when present on the context', () => {
    const a = mapSessionEventToRuntimeEvent(ev({ type: 'complete', stopReason: 'end_turn' }), {
      ...ctx,
      branch: 'agent-b',
    });
    assert.equal(a.branch, 'agent-b');
  });
});

// ============================================================================
// Projection coverage contract
// ============================================================================

/**
 * One sample per backend-mappable SessionEvent variant. `subject` is typed to
 * its own key, so a new variant cannot be satisfied by an empty list or by
 * some other event that happens to project cleanly; `before` and `after` carry
 * only the companions that variant's projection needs.
 */
type ProjectionSamples = {
  [K in BackendSessionEvent['type']]: {
    subject: Extract<BackendSessionEvent, { type: K }>;
    before?: SessionEvent[];
    after?: SessionEvent[];
  };
};

const PROJECTION_SAMPLES: ProjectionSamples = {
  text_delta: {
    subject: { type: 'text_delta', id: 'e', turnId: 'turn-1', ts: 1, messageId: 'm1', text: 'h' },
  },
  text_complete: {
    subject: {
      type: 'text_complete',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'm1',
      text: 'hi',
    },
  },
  thinking_delta: {
    subject: {
      type: 'thinking_delta',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'm1',
      text: 'h',
    },
  },
  thinking_complete: {
    subject: {
      type: 'thinking_complete',
      id: 'e1',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'm1',
      text: 'why',
    },
    // Thinking is held until the assistant text row that shares its message id.
    after: [
      { type: 'text_complete', id: 'e2', turnId: 'turn-1', ts: 2, messageId: 'm1', text: 'hi' },
    ],
  },
  tool_start: {
    subject: {
      type: 'tool_start',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      toolUseId: 'tool-1',
      toolName: 'Read',
      args: { path: '/tmp/a' },
    },
  },
  tool_output_delta: {
    subject: {
      type: 'tool_output_delta',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      sessionId: 'session-1',
      toolCallId: 'tool-1',
      toolUseId: 'tool-1',
      seq: 1,
      stream: 'stdout',
      chunk: 'out',
      redacted: false,
      createdAt: 1,
    },
  },
  tool_progress: {
    subject: {
      type: 'tool_progress',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      toolUseId: 'tool-1',
      chunk: 'x',
    },
  },
  tool_result_preview: {
    subject: {
      type: 'tool_result_preview',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      toolUseId: 'tool-1',
      isError: false,
      content: {
        kind: 'subagent',
        childSessionId: 'child-1',
        agentName: 'Local Read',
        turnId: 'child-turn',
        status: 'running',
        permissionMode: 'explore',
      },
    },
  },
  tool_result: {
    subject: {
      type: 'tool_result',
      id: 'e2',
      turnId: 'turn-1',
      ts: 2,
      toolUseId: 'tool-1',
      isError: false,
      content: { kind: 'text', text: 'ok' },
    },
    // A result carries no tool name of its own; the mapper reads it from the call.
    before: [
      {
        type: 'tool_start',
        id: 'e1',
        turnId: 'turn-1',
        ts: 1,
        toolUseId: 'tool-1',
        toolName: 'Read',
        args: { path: '/tmp/a' },
      },
    ],
  },
  sandbox_boundary_request: {
    subject: {
      type: 'sandbox_boundary_request',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'boundary-1',
      toolUseId: 'tool-1',
      justification: 'read a file outside the workspace',
      expansion: {
        filesystem: { entries: [{ path: '/tmp/outside.txt', access: 'read', scope: 'exact' }] },
      },
    },
  },
  sandbox_boundary_decision_ack: {
    subject: {
      type: 'sandbox_boundary_decision_ack',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'boundary-1',
      toolUseId: 'tool-1',
      decision: 'allow',
      status: 'approved',
      revision: 2,
    },
  },
  user_question_request: {
    subject: {
      type: 'user_question_request',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'q-1',
      toolUseId: 'tool-1',
      questions: [{ question: 'Which one?', options: [{ label: 'A', description: 'a' }] }],
    },
  },
  user_question_answer_ack: {
    subject: {
      type: 'user_question_answer_ack',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'q-1',
      toolUseId: 'tool-1',
    },
  },
  plan_submitted: {
    subject: {
      type: 'plan_submitted',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      planId: 'plan-1',
      title: 'Plan',
    },
  },
  token_usage: {
    subject: {
      type: 'token_usage',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      input: 10,
      output: 5,
      total: 15,
    },
  },
  steering_message: {
    subject: {
      type: 'steering_message',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      messageId: 'm2',
      content: { text: 'steer' },
    },
  },
  provider_retry: {
    subject: {
      type: 'provider_retry',
      id: 'e',
      turnId: 'turn-1',
      ts: 1,
      phase: 'started',
      attempt: 2,
      maxAttempts: 3,
      reason: 'rate_limit',
    },
  },
  error: {
    subject: {
      type: 'error',
      id: 'e1',
      turnId: 'turn-1',
      ts: 1,
      recoverable: false,
      message: 'boom',
    },
    // An error is always followed by a terminal complete carrying the failure.
    after: [{ type: 'complete', id: 'e2', turnId: 'turn-1', ts: 2, stopReason: 'error' }],
  },
  complete: {
    subject: { type: 'complete', id: 'e', turnId: 'turn-1', ts: 1, stopReason: 'end_turn' },
  },
  abort: { subject: { type: 'abort', id: 'e', turnId: 'turn-1', ts: 1, reason: 'user_stop' } },
};

const projectionRunHeader: AgentRunHeader = {
  runId: 'run-1',
  sessionId: 'session-1',
  turnId: 'turn-1',
  status: 'completed',
  backendKind: 'ai-sdk',
  llmConnectionSlug: 'anthropic',
  modelId: 'model-1',
  cwd: '/tmp',
  permissionMode: 'ask',
  createdAt: 1,
  updatedAt: 2,
  completedAt: 2,
};

describe('SessionEvent projection coverage', () => {
  test('keeps Host admission facts out of durable Runtime events', () => {
    assert.throws(
      () =>
        mapSessionEventToRuntimeEvent(
          {
            type: 'message_admission',
            id: 'message-admission-1',
            turnId: 'turn-1',
            ts: 1,
            messageId: 'message-1',
            outcome: 'admitted',
          },
          ctx,
        ),
      /message_admission is not a backend event/,
    );
  });

  test('keeps Host-owned Client Capability interactions out of backend projection', () => {
    const request: SessionEvent = {
      type: 'client_capability_request',
      id: 'client-capability-request-1',
      turnId: 'turn-1',
      ts: 1,
      requestId: 'request-1',
      toolUseId: 'tool-1',
      capability: 'browser',
      scope: { kind: 'browser_origin', origin: 'https://example.com' },
    };
    const ack: SessionEvent = {
      type: 'client_capability_decision_ack',
      id: 'client-capability-ack-1',
      turnId: 'turn-1',
      ts: 2,
      requestId: 'request-1',
      toolUseId: 'tool-1',
      decision: 'allow',
    };

    for (const event of [request, ack]) {
      assert.equal(isLiveBackendSessionEvent(event), false);
      assert.throws(
        () => mapSessionEventToRuntimeEvent(event, ctx),
        new RegExp(`${event.type} is not a backend event`, 'u'),
      );
    }
  });

  // The contract is over what a reader can actually meet: every mapped event
  // AgentRun admits to the ledger has to project. It asserts on the unclaimed
  // codes at either severity, not on the hard one alone — a control fact whose
  // gap only degrades the view is still a gap, and must be found here rather
  // than by a user opening the session.
  for (const [type, sample] of Object.entries(PROJECTION_SAMPLES)) {
    test(`${type} projects without an unclaimed-event diagnostic`, () => {
      const memory = createSessionEventMapMemory();
      const runtimeEvents = [...(sample.before ?? []), sample.subject, ...(sample.after ?? [])]
        .map((event) => mapSessionEventToRuntimeEvent(event, ctx, memory))
        .filter((event) => !isNonTerminalErrorRuntimeEvent(event));

      const projected = projectRuntimeEventsToStoredMessages(runtimeEvents, {
        runHeaders: [projectionRunHeader],
      });

      assert.deepEqual(projected.diagnostics.filter(isUnclaimedRuntimeEventDiagnostic), []);
    });
  }

  // The guard's fallback is what a variant added without a claim actually
  // becomes. It has to stay on the degradable side of the line: control-only,
  // so the session it lands in still opens, and still reported so the gap the
  // coverage contract would have caught is not invisible at runtime.
  test('an unmapped SessionEvent maps to a reported control-only fact', () => {
    const unmapped = { type: 'not_yet_mapped', id: 'e', turnId: 'turn-1', ts: 1 };
    const memory = createSessionEventMapMemory();
    const runtimeEvent = mapSessionEventToRuntimeEvent(
      unmapped as unknown as SessionEvent,
      ctx,
      memory,
    );

    assert.equal(runtimeEvent.content, undefined);
    assert.equal(runtimeEvent.actions?.stateDelta?.unmappedSessionEventType, 'not_yet_mapped');

    const projected = projectRuntimeEventsToStoredMessages([runtimeEvent], {
      runHeaders: [projectionRunHeader],
    });
    assert.deepEqual(projected.messages, []);
    // Filtered through the predicate the contract above uses, not just compared
    // to the code string: dropping the soft code from the predicate would
    // otherwise loosen the contract to `unsupported_event` only, silently.
    assert.deepEqual(
      projected.diagnostics.filter(isUnclaimedRuntimeEventDiagnostic).map((d) => d.code),
      ['unclaimed_control_fact'],
    );
    assert.equal(projected.diagnostics.length, 1);
  });
});
