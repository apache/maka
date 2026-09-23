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
import { test } from 'node:test';
import { deferred, withTimeout } from '@maka/core/test-only/async-primitives';
import { WORKHUB_COORDINATION_SESSION_ID } from '@maka/core/session';
import type { MakaToolContext } from '@maka/runtime/tool-runtime';
import { createWorkHubResultRuntime } from '../server/workhub-result-runtime.js';
import {
  SessionAdmissionGate,
  type SessionAdmissionLease,
} from '../server/session-admission-gate.js';

type Options = Parameters<typeof createWorkHubResultRuntime>[0];
function fixture() {
  let active = true,
    stopped = false;
  let requests = true;
  let status = 'waiting_for_user';
  let disposition: 'owned_root' | 'cancelled' = 'owned_root';
  let resultReads = 0;
  let rejectRelay: ((reason: Error) => void) | undefined;
  const closedRelays: unknown[] = [];
  const assignment = {
    actionId: 'action',
    delegationId: 'delegation',
    targetSessionId: 'target',
    targetMessageId: 'message',
    returnResults: true,
  };
  const questions = [
    {
      question: 'When should the release go out?',
      options: [{ label: 'Friday' }, { label: 'Monday' }],
    },
  ];
  const record = {
    requestId: 'question',
    sessionId: 'target',
    turnId: 'target-turn',
    runId: 'target-run',
    request: { kind: 'question', questions },
    createdAt: 1,
  };
  const admission = new SessionAdmissionGate();
  const forwarded: unknown[] = [];
  const startWorkHubResult: Options['executions']['startWorkHubResult'] = async (
    _origin,
    prepare,
  ) => {
    await prepare({} as SessionAdmissionLease);
    return 'delivered';
  };
  const runtime = createWorkHubResultRuntime({
    // Each stub is an external authority; use the real admission gate and tool.
    stores: {
      sessionStore: {
        listHeaders: async () => [{ id: 'target', isArchived: false }],
        readWorkHubAssignment: async () => assignment,
        readHeaderSnapshot: async () => ({ isArchived: false }),
        readActiveWorkHubAssignmentsByTarget: async () => (active ? [assignment] : []),
        readWorkHubReplacement: async () => undefined,
        readWorkHubStopRequest: async () => (stopped ? {} : undefined),
        readWorkHubStopResolution: async () => undefined,
        listPendingSandboxBoundaryRequests: async () => [],
      },
      interactionStore: { listSessionPending: async () => (requests ? [record] : []) },
    } as unknown as Options['stores'],
    executions: {
      startWorkHubResult,
      readLatestRootTurnLineage: async () => ({
        sessionId: 'target',
        turnId: 'target-turn',
        runId: 'target-run',
      }),
      read: async () => ({ status, terminalEventId: 'terminal' }),
    } as unknown as Options['executions'],
    messages: {
      readMessageExecutionDispositionAdmitted: async () =>
        disposition === 'cancelled'
          ? { kind: 'cancelled' }
          : { kind: 'owned_root', turnId: 'target-turn', runId: 'target-run' },
    } as unknown as Options['messages'],
    interactions: {
      closeRelayedQuestion: async (turnId, toolCallId) => {
        closedRelays.push({ turnId, toolCallId });
        rejectRelay?.(new Error('Relay closed after original question settled'));
        return true;
      },
      answerDelegatedQuestion: async (input, lease) =>
        admission.runAdmitted('target', lease, async () => {
          forwarded.push(input);
          return { ok: true, result: { status: 'answered' } };
        }),
    } as Options['interactions'],
    readTurnResult: async (sessionId, turnId) => {
      assert.equal(sessionId, 'target');
      assert.equal(turnId, 'target-turn');
      resultReads++;
      return '😀'.repeat(16001);
    },
    admission,
    acquireResidency: () => ({ release() {} }),
    onError: (error) => {
      throw error;
    },
  });
  const context: MakaToolContext = {
    sessionId: WORKHUB_COORDINATION_SESSION_ID,
    turnId: 'feedback-turn',
    runId: 'feedback-run',
    cwd: '/tmp',
    toolCallId: 'relay',
    abortSignal: new AbortController().signal,
    emitOutput() {},
  };
  const call = (input: Record<string, unknown>, ctx = context) =>
    runtime.tool.impl(input as never, ctx);
  return {
    call,
    context,
    questions,
    forwarded,
    closedRelays,
    resultReads: () => resultReads,
    notify: runtime.notify,
    reconcile: () => runtime.coordinator.reconcile(),
    setRelayReject: (reject: (reason: Error) => void) => {
      rejectRelay = reject;
    },
    setOriginalAnswered: () => {
      requests = false;
      status = 'completed';
    },
    setDisposition: (value: typeof disposition) => {
      disposition = value;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    setStopped: () => {
      stopped = true;
    },
    setRunning: () => {
      status = 'running';
      requests = false;
    },
    setStatus: (value: string) => {
      status = value;
    },
    setCompleted: () => {
      status = 'completed';
    },
    record,
  };
}

test('WorkHubResult presents the exact question and forwards only the actual collected answer', async () => {
  const f = fixture();
  let shown: unknown;
  const result = await f.call(
    { actionId: 'action', operation: 'ask_question', interactionId: 'question' },
    {
      ...f.context,
      askUserQuestion: async (questions) => {
        shown = questions;
        return { answers: [{ question: questions[0]!.question, answer: 'Monday' }] };
      },
    },
  );
  assert.deepEqual(shown, f.questions);
  assert.deepEqual(f.forwarded, [
    {
      sessionId: 'target',
      interactionId: 'question',
      answer: { kind: 'question', answers: ['Monday'] },
    },
  ]);
  assert.deepEqual(result, { status: 'answered', targetSessionId: 'target' });
});

test('WorkHubResult refuses model-supplied answers and access from other Sessions', async () => {
  const f = fixture();
  await assert.rejects(
    Promise.resolve().then(() =>
      f.call({
        actionId: 'action',
        operation: 'ask_question',
        interactionId: 'question',
        answers: ['Friday'],
      }),
    ),
  );
  await assert.rejects(
    Promise.resolve().then(() =>
      f.call({ actionId: 'action' }, { ...f.context, sessionId: 'another-session' }),
    ),
    /coordination Session/u,
  );
  assert.equal(f.forwarded.length, 0);
});

for (const retire of ['replace', 'stop'] as const) {
  test(`a ${retire} while the human answers prevents relaying to the old task`, async () => {
    const f = fixture();
    const result = await f.call(
      { actionId: 'action', operation: 'ask_question', interactionId: 'question' },
      {
        ...f.context,
        askUserQuestion: async () => {
          if (retire === 'replace') f.setActive(false);
          else f.setStopped();
          return { answers: [{ question: 'When?', answer: 'Friday' }] };
        },
      },
    );
    assert.deepEqual(result, { status: 'obsolete' });
    assert.equal(f.forwarded.length, 0);
  });
}

test('WorkHubResult reads complete results in Unicode-safe pages', async () => {
  const f = fixture();
  f.setCompleted();
  const first = (await f.call({ actionId: 'action' })) as { result: string; nextOffset: number };
  const last = (await f.call({ actionId: 'action', offset: first.nextOffset })) as {
    result: string;
    nextOffset: null;
  };
  assert.equal(Array.from(first.result).length, 16000);
  assert.equal(first.nextOffset, 16000);
  assert.equal(last.result, '😀');
  assert.equal(last.nextOffset, null);
});

test('WorkHubResult cannot relay a permission decision', async () => {
  const f = fixture();
  f.record.request.kind = 'permission';
  await assert.rejects(
    Promise.resolve().then(() =>
      f.call(
        { actionId: 'action', operation: 'ask_question', interactionId: 'question' },
        {
          ...f.context,
          askUserQuestion: async () => {
            throw new Error('Must not ask for permission through this tool');
          },
        },
      ),
    ),
    /Only pending user questions/u,
  );
  assert.equal(f.forwarded.length, 0);
});

test('a stopped WorkHub turn cannot forward an answer after cancellation', async () => {
  const f = fixture();
  const abort = new AbortController();
  await assert.rejects(
    Promise.resolve().then(() =>
      f.call(
        { actionId: 'action', operation: 'ask_question', interactionId: 'question' },
        {
          ...f.context,
          abortSignal: abort.signal,
          askUserQuestion: async () => {
            abort.abort();
            return { answers: [{ question: 'When?', answer: 'Friday' }] };
          },
        },
      ),
    ),
    /abort/u,
  );
  assert.equal(f.forwarded.length, 0);
});

for (const status of ['completed', 'failed', 'cancelled']) {
  test(`WorkHubResult ${status} result survives lossless JSON persistence`, async () => {
    const f = fixture();
    f.setStatus(status);
    const result = await f.call({ actionId: 'action' });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
  });
}

test('a still-running delegation reports pending and asks the model to yield', async () => {
  const f = fixture();
  f.setRunning();
  const result = (await f.call({ actionId: 'action' })) as { status: string; message: string };
  assert.equal(result.status, 'pending');
  assert.match(result.message, /automatically notify/u);
  f.setActive(false);
  assert.deepEqual(await f.call({ actionId: 'action' }), {
    status: 'obsolete',
    targetSessionId: 'target',
  });
});

test('a message cancelled before execution returns a durable cancellation result', async () => {
  const f = fixture();
  f.setDisposition('cancelled');
  const result = (await f.call({ actionId: 'action' })) as { status: string; details: unknown };
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(result.details, { abortSource: 'message_cancelled_before_execution' });
  assert.equal(f.resultReads(), 0);
});

test('delivered terminal events do not reread the target transcript on reconciliation', async () => {
  const f = fixture();
  f.setCompleted();
  await f.reconcile();
  await f.reconcile();
  assert.equal(f.resultReads(), 1);
});

test('answering the original task closes the copied WorkHub question', async () => {
  const f = fixture();
  const presented = deferred();
  const relayed = f.call(
    { actionId: 'action', operation: 'ask_question', interactionId: 'question' },
    {
      ...f.context,
      askUserQuestion: async () =>
        new Promise((_, reject) => {
          f.setRelayReject(reject);
          presented.resolve();
        }),
    },
  );
  await withTimeout(presented.promise, 1000, 'Question was not presented');
  f.setOriginalAnswered();
  f.notify('target');
  assert.deepEqual(await withTimeout(Promise.resolve(relayed), 1000, 'Relay remained blocked'), {
    status: 'question_settled_in_target',
    targetSessionId: 'target',
    message:
      'The original task question has settled. Wait for the automatic task result; do not ask again.',
  });
  assert.deepEqual(f.closedRelays, [{ turnId: 'feedback-turn', toolCallId: 'relay' }]);
  assert.equal(f.forwarded.length, 0);
});
