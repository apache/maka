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

import { createTestToolRuntime } from './execution-boundary-test-helpers.js';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createWorkspaceWritePermissionProfile } from '@maka/core/permission-profile';
import { type SandboxBoundarySettlement } from '@maka/core/sandbox-boundary';
import type { HostedInteractionBridge } from '@maka/core/backend-types';
import type { SessionEvent } from '@maka/core/events';
import type { SessionHeader } from '@maka/core/session';

import { buildAskUserQuestionTool } from '../ask-user-question-tool.js';
import { AsyncEventQueue } from '../async-queue.js';
import {
  RuntimeInteractionAdmissionRejectedError,
  RuntimeInteractionInvariantError,
  RuntimeInteractionRunBinding,
  bindRuntimeInteractionRun,
  type RuntimeInteractionAuthority,
  type RuntimeInteractionRunOwner,
  type RuntimeSandboxBoundaryContinuation,
  type RuntimeUserQuestionContinuation,
} from '../interaction-authority.js';
import { SessionManager } from '../session-manager.js';
import { ToolRuntime, type DurableSessionEventSink, type MakaTool } from '../tool-runtime.js';

describe('Runtime Interaction authority seam', () => {
  test('binds the exact Run and rejects release before durable close', async () => {
    const log: string[] = [];
    const binding = await bindRuntimeInteractionRun(
      authority({
        close: async (reason) => {
          log.push(`close:${reason}`);
        },
        release: () => log.push('release'),
      }),
      RUN,
    );

    assert.throws(() => binding.release(), RuntimeInteractionInvariantError);
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
    assert.deepEqual(log, ['close:turn_terminal', 'release']);

    let failedFinalizerReleased = false;
    const failedFinalizer = new RuntimeInteractionRunBinding(
      authority({
        release: () => {
          failedFinalizerReleased = true;
        },
      }).bindRun({ ...RUN, runId: 'failed-finalizer-run' }),
    );
    failedFinalizer.deferLocalClosure(() => {
      throw new Error('local closure failed');
    });
    await failedFinalizer.close('turn_terminal');
    await assert.rejects(failedFinalizer.settleLocalClosures(), /local closure failed/);
    assert.throws(() => failedFinalizer.release(), RuntimeInteractionInvariantError);
    assert.equal(failedFinalizerReleased, false);
  });

  test('durably reclaims an owner that returns the wrong Run identity', async () => {
    const log: string[] = [];
    await assert.rejects(
      bindRuntimeInteractionRun(
        {
          bindRun: () => ({
            ...RUN,
            runId: 'wrong-run',
            acceptSandboxBoundaryRequest: async () => {},
            acceptUserQuestionRequest: async () => {},
            close: async (reason) => {
              log.push(`close:${reason}`);
            },
            release: () => log.push('release'),
          }),
        },
        RUN,
      ),
      RuntimeInteractionInvariantError,
    );
    assert.deepEqual(log, ['close:turn_terminal', 'release']);
  });

  test('rejects a question registered after stop closure as an exact closed-Run admission', async () => {
    const binding = await bindRuntimeInteractionRun(authority(), RUN);
    await binding.close('turn_stopped');

    await assert.rejects(
      binding.admitUserQuestionRequest({
        request: {
          type: 'user_question_request',
          id: 'question-event-after-stop',
          turnId: RUN.turnId,
          ts: 1,
          requestId: 'question-after-stop',
          toolUseId: 'tool-after-stop',
          questions: [
            {
              question: 'Continue?',
              options: [{ label: 'Yes' }, { label: 'No' }],
            },
          ],
        },
        settlement: {
          applyAnswer: async () => {},
          applyClosure: async () => {},
        },
      }),
      (error: unknown) =>
        error instanceof RuntimeInteractionAdmissionRejectedError &&
        error.requestId === 'question-after-stop' &&
        error.reason === 'run_closed' &&
        error.closureReason === 'turn_stopped',
    );

    await binding.settleLocalClosures();
    binding.release();
  });

  test('publishes a hosted question only after admission and resolves only through its continuation', async () => {
    const admission = deferred<void>();
    let question: RuntimeUserQuestionContinuation | undefined;
    const events: SessionEvent[] = [];
    const binding = await bindRuntimeInteractionRun(
      authority({
        acceptUserQuestionRequest: async ({ continuation }) => {
          question = continuation;
          await admission.promise;
        },
      }),
      RUN,
    );
    const runtime = toolRuntime(events, binding);
    const pending = settleTool(
      runtime,
      buildAskUserQuestionTool(),
      RUN.turnId,
      durableEventSink(events),
    )(
      {
        questions: [
          {
            question: 'Continue?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );

    await immediate();
    assert.ok(question);
    assert.equal(
      events.some((event) => event.type === 'user_question_request'),
      false,
    );
    admission.resolve();
    await waitFor(() => events.some((event) => event.type === 'user_question_request'));

    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await immediate();
    assert.equal(settled, false);
    assert.throws(
      () =>
        runtime.respondToUserQuestion({
          requestId: question!.requestId,
          answers: ['Yes'],
        }),
      RuntimeInteractionInvariantError,
    );
    assert.equal(runtime.pendingUserQuestionCount(), 1);
    await question!.applyAnswer({ answers: ['Yes'] });
    assert.deepEqual(await pending, {
      answers: [{ question: 'Continue?', answer: 'Yes' }],
    });

    runtime.endTurn();
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('matches a hosted sandbox boundary acknowledgement to its exact durable settlement', async () => {
    let continuation: RuntimeSandboxBoundaryContinuation | undefined;
    let applied = false;
    const binding = await bindRuntimeInteractionRun(
      authority({
        acceptSandboxBoundaryRequest: async ({ continuation: admitted }) => {
          continuation = admitted;
        },
      }),
      RUN,
    );
    const request = {
      type: 'sandbox_boundary_request' as const,
      id: 'boundary-event-1',
      turnId: RUN.turnId,
      ts: 1,
      requestId: 'boundary-1',
      toolUseId: 'tool-boundary-1',
      expansion: {
        filesystem: {
          entries: [
            { path: '/outside/file.txt', access: 'read' as const, scope: 'exact' as const },
          ],
        },
      },
      justification: 'Read the selected file.',
    };
    await binding.admitSandboxBoundaryRequest({
      request,
      settlement: {
        applyDecision: async () => {
          applied = true;
        },
        applyClosure: async () => {},
      },
    });
    binding.assertPendingAdmission(request);
    assert.ok(continuation);
    const settlement: SandboxBoundarySettlement = {
      request: {
        sessionId: RUN.sessionId,
        requestId: request.requestId,
        status: 'approved',
        baseRevision: 0,
        expansion: request.expansion,
        justification: request.justification,
        createdAt: 1,
        settledAt: 2,
        appliedRevision: 1,
        turnId: RUN.turnId,
        runId: RUN.runId,
      },
      boundary: {
        kind: 'managed',
        profile: createWorkspaceWritePermissionProfile(),
        revision: 1,
      },
      changed: true,
    };
    await continuation.applyDecision(settlement);
    assert.equal(applied, true);
    assert.equal(
      await binding.canResumeAfterSettlementAck({
        type: 'sandbox_boundary_decision_ack',
        id: 'boundary-ack-1',
        turnId: RUN.turnId,
        ts: 2,
        requestId: request.requestId,
        toolUseId: request.toolUseId,
        decision: 'allow',
        status: 'approved',
        revision: 1,
      }),
      true,
    );

    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('keeps aggregate pending state until every hosted question settles', async () => {
    const continuations: RuntimeUserQuestionContinuation[] = [];
    const events: SessionEvent[] = [];
    const finishSecondAdmission = deferred<void>();
    const binding = await bindRuntimeInteractionRun(
      authority({
        acceptUserQuestionRequest: async ({ continuation }) => {
          continuations.push(continuation);
          if (continuations.length === 2) await finishSecondAdmission.promise;
        },
      }),
      RUN,
    );
    const runtime = toolRuntime(events, binding);
    const execute = settleTool(
      runtime,
      buildAskUserQuestionTool(),
      RUN.turnId,
      durableEventSink(events),
    );
    const first = execute(
      {
        questions: [
          {
            question: 'First?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    const second = execute(
      {
        questions: [
          {
            question: 'Second?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
      { toolCallId: 'tool-2', abortSignal: new AbortController().signal },
    );

    await waitFor(() => continuations.length === 2);
    await assert.rejects(
      binding.canResumeAfterSettlementAck({
        type: 'user_question_answer_ack',
        id: 'unknown-answer',
        turnId: RUN.turnId,
        ts: 1,
        requestId: 'unknown-question',
        toolUseId: 'tool-unknown',
      }),
      RuntimeInteractionInvariantError,
    );
    await continuations[0]!.applyAnswer({ answers: ['Yes'] });
    await first;
    await assert.rejects(
      binding.canResumeAfterSettlementAck({
        type: 'user_question_answer_ack',
        id: 'mismatched-answer',
        turnId: RUN.turnId,
        ts: 1,
        requestId: continuations[0]!.requestId,
        toolUseId: 'wrong-tool',
      }),
      RuntimeInteractionInvariantError,
    );
    assert.equal(
      await binding.canResumeAfterSettlementAck({
        type: 'user_question_answer_ack',
        id: 'first-answer',
        turnId: RUN.turnId,
        ts: 1,
        requestId: continuations[0]!.requestId,
        toolUseId: 'tool-1',
      }),
      false,
    );
    finishSecondAdmission.resolve();
    await waitFor(
      () => events.filter((event) => event.type === 'user_question_request').length === 2,
    );
    await continuations[1]!.applyAnswer({ answers: ['No'] });
    await second;
    assert.equal(
      await binding.canResumeAfterSettlementAck({
        type: 'user_question_answer_ack',
        id: 'second-answer',
        turnId: RUN.turnId,
        ts: 2,
        requestId: continuations[1]!.requestId,
        toolUseId: 'tool-2',
      }),
      true,
    );

    runtime.endTurn();
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('defers question teardown after backend cleanup clears current run identity', async () => {
    const events: SessionEvent[] = [];
    const log: string[] = [];
    let question: RuntimeUserQuestionContinuation | undefined;
    const binding = await bindRuntimeInteractionRun(
      authority({
        acceptUserQuestionRequest: async ({ continuation }) => {
          question = continuation;
        },
        close: async (reason) => {
          log.push(`close-durable:${reason}`);
          await question?.applyClosure(reason);
          log.push('local-closure-applied');
        },
        release: () => log.push('release'),
      }),
      RUN,
    );
    const runtime = toolRuntime(events, binding);
    const pending = settleTool(
      runtime,
      buildAskUserQuestionTool(),
      RUN.turnId,
      durableEventSink(events),
    )(
      {
        questions: [
          {
            question: 'Continue?',
            options: [{ label: 'Yes' }, { label: 'No' }],
          },
        ],
      },
      { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
    );
    await waitFor(() => events.some((event) => event.type === 'user_question_request'));
    const published = events.find((event) => event.type === 'user_question_request');
    if (published?.type !== 'user_question_request') {
      assert.fail('expected a published user question');
    }
    binding.assertPendingAdmission(published);

    const rejected = assert.rejects(pending, /turn_stopped/);
    runtime.endTurn('aborted');
    await immediate();
    assert.deepEqual(log, []);
    await binding.close('turn_stopped');
    await binding.settleLocalClosures();
    binding.release();
    assert.deepEqual(log, ['close-durable:turn_stopped', 'local-closure-applied', 'release']);
    await rejected;
  });

  test('removes a rejected admission without publishing or leaving a parked question', async () => {
    const events: SessionEvent[] = [];
    const binding = await bindRuntimeInteractionRun(
      authority({
        acceptUserQuestionRequest: async ({ continuation }) => {
          throw new RuntimeInteractionAdmissionRejectedError(
            continuation.requestId,
            'invalid_request',
          );
        },
      }),
      RUN,
    );
    const runtime = toolRuntime(events, binding);
    await assert.rejects(
      settleTool(
        runtime,
        buildAskUserQuestionTool(),
        RUN.turnId,
        durableEventSink(events),
      )(
        {
          questions: [
            {
              question: 'Continue?',
              options: [{ label: 'Yes' }, { label: 'No' }],
            },
          ],
        },
        { toolCallId: 'tool-1', abortSignal: new AbortController().signal },
      ),
      (error: unknown) =>
        error instanceof RuntimeInteractionAdmissionRejectedError &&
        error.requestId === 'runtime-2' &&
        error.reason === 'invalid_request',
    );
    assert.equal(runtime.pendingUserQuestionCount(), 0);
    assert.equal(
      events.some((event) => event.type === 'user_question_request'),
      false,
    );
    runtime.endTurn();
    await binding.close('turn_terminal');
    await binding.settleLocalClosures();
    binding.release();
  });

  test('fails closed instead of broadcasting Session-level hosted question answers', async () => {
    let questionBroadcasts = 0;
    const manager = new SessionManager({
      store: {} as never,
      backends: {} as never,
      newId: () => 'id',
      now: () => 1,
      interactionAuthority: authority(),
      canonicalPermissionOutcomes: {
        readPermissionOutcome: async () => undefined,
      },
      runtimeKernel: {
        respondToUserQuestion: async () => {
          questionBroadcasts += 1;
        },
      } as never,
    });

    await assert.rejects(
      manager.respondToUserQuestion(RUN.sessionId, {
        requestId: 'question-1',
        answers: ['Yes'],
      }),
      RuntimeInteractionInvariantError,
    );
    assert.equal(questionBroadcasts, 0);
  });
});

const RUN = Object.freeze({
  sessionId: 'session-1',
  turnId: 'turn-1',
  runId: 'run-1',
});

function authority(
  overrides: Partial<RuntimeInteractionRunOwner> = {},
): RuntimeInteractionAuthority {
  return {
    bindRun: (identity) => ({
      ...identity,
      acceptSandboxBoundaryRequest: async () => {},
      acceptUserQuestionRequest: async () => {},
      close: async () => {},
      release: () => {},
      ...overrides,
    }),
  };
}

function toolRuntime(
  events: SessionEvent[],
  hostedInteraction?: HostedInteractionBridge,
): ToolRuntime {
  let id = 0;
  return createTestToolRuntime({
    turnId: RUN.turnId,
    ...(hostedInteraction ? { hostedInteraction } : {}),
    sessionId: RUN.sessionId,
    header: header(),
    connection: { providerType: 'openai', slug: 'c' } as never,
    modelId: 'm',
    appendMessage: async () => {},
    newId: () => `runtime-${++id}`,
    now: () => 1,
    getPermissionPauseTarget: () => null,
    runId: RUN.runId,
    recordToolInvocation: () => void events,
  });
}

function settleTool(
  runtime: ToolRuntime,
  tool: MakaTool,
  turnId: string,
  eventSink: DurableSessionEventSink,
) {
  return async (
    input: unknown,
    context: { toolCallId: string; abortSignal: AbortSignal },
  ): Promise<unknown> =>
    (
      await runtime.settleToolCall({
        tool,
        turnId,
        toolCallId: context.toolCallId,
        input,
        abortSignal: context.abortSignal,
        eventSink,
      })
    ).result;
}

function durableEventSink(events: SessionEvent[]): AsyncEventQueue<SessionEvent> {
  const queue = new AsyncEventQueue<SessionEvent>();
  void (async () => {
    for await (const event of queue) {
      events.push(event);
      queue.ackConsumed();
    }
  })();
  return queue;
}

function header(): SessionHeader {
  return {
    id: RUN.sessionId,
    workspaceRoot: '/tmp/maka',
    cwd: '/tmp/maka',
    createdAt: 1,
    lastUsedAt: 1,
    name: 'Test',
    titleIsManual: true,
    isFlagged: false,
    labels: [],
    isArchived: false,
    status: 'active',
    statusUpdatedAt: 1,
    hasUnread: false,
    backend: 'ai-sdk',
    llmConnectionSlug: 'c',
    connectionLocked: true,
    model: 'm',
    permissionMode: 'ask',
    schemaVersion: 1,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function immediate(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await immediate();
  }
  assert.fail('condition was not reached');
}
