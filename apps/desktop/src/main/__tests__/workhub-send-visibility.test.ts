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
import { afterEach, test } from 'node:test';
import { act, createElement } from 'react';
import { LocaleProvider } from '@maka/ui';
import { deferred } from '@maka/core/test-only/async-primitives';
import { RuntimeHostRequestInterruptedError, RuntimeHostOperationError } from '@maka/runtime-host/client';
import { registerRuntimeHostSessionExecutionIpc, type RuntimeHostSessionExecutionIpcDeps } from '../runtime-host-session-execution-ipc-main.js';
import { registerRuntimeHostWorkHubIpc } from '../runtime-host-workhub-ipc-main.js';
import type { IpcHandler } from '../ipc-reconnect-policy.js';
import type { DesktopSessionStopResult } from '../../preload/bridge-contract.js';
import type { AttachmentRef } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import { WorkHubServicesProvider, type WorkHubServices, type WorkHubTranscriptSnapshot } from '../../renderer/features/workhub/index.js';
import { useWorkHubController } from '../../renderer/features/workhub/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

async function mountController(failFirstRead = false) {
  let hostEpoch = 'host-epoch-1';
  let openCount = 0;
  let onPhase!: (phase: 'pending' | 'ready') => void;
  const { root } = installReactRenderer();
  let controller!: ReturnType<typeof useWorkHubController>;
  let publish!: (snapshot: WorkHubTranscriptSnapshot) => void;
  let observe!: Parameters<WorkHubServices['observe']>[1];
  let loadLatestCount = 0;
  let admission = deferred<{ turnId: string }>();
  const latestRead = deferred<void>();
  const requests: Array<Parameters<WorkHubServices['answer']>[1]> = [];
  let rootTurn: { turnId: string; runId: string; status: 'running' | 'cancelled' | 'completed' } | undefined;
  const queueMutations: unknown[][] = [];
  const steers: Array<Parameters<WorkHubServices['enqueueMessage']>> = [];
  let steerResult: Awaited<ReturnType<WorkHubServices['enqueueMessage']>> = 'admitted';
  let onSteer: ((input: Parameters<WorkHubServices['enqueueMessage']>) => void) | undefined;
  const interrupts: Array<{ sessionId: string; turnId: string; runId: string }> = [];
  let stopRetractions: string[] = [];
  const handlers = new Map<string, IpcHandler>();
  const ipc = { handle: (channel: string, handler: IpcHandler) => { handlers.set(channel, handler); } };
  registerRuntimeHostSessionExecutionIpc({
    observer: { snapshot: async () => ({ rootTurn }) },
    beforeStop: async () => {},
    emitSessionsChanged: () => {},
    client: { interruptTurn: async (input: typeof interrupts[number]) => {
      interrupts.push({ sessionId: input.sessionId, turnId: input.turnId, runId: input.runId });
      rootTurn!.status = 'cancelled';
      return { retracted: stopRetractions.map((messageId) => ({ messageId })) };
    } },
  } as unknown as RuntimeHostSessionExecutionIpcDeps, ipc);
  registerRuntimeHostWorkHubIpc({
    get hostEpoch() { return hostEpoch; },
    queryTurn: async () => {
      if (!rootTurn) throw new RuntimeHostOperationError('turn.query', 'not_found', 'Turn was not admitted');
      return { ...rootTurn, sessionId: 'workhub-coordination' };
    },
    answerWorkHubCoordination: async (input: Parameters<WorkHubServices['answer']>[1]) => {
      requests.push(input);
      return admission.promise;
    },
  } as unknown as Parameters<typeof registerRuntimeHostWorkHubIpc>[0], ipc, {});
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as Parameters<IpcHandler>[0], ...args);

  const sessionId = JSON.stringify(['host-1', 'workhub-coordination']);
  const services = {
    resolve: async () => sessionId,
    getSession: async () => ({ id: sessionId, runningTurnIds: [] }),
    listSessions: async () => [],
    modelChoices: async () => [],
    subscribeHosts: () => () => {},
    subscribeAvailability: () => () => {},
    subscribeSessions: () => () => {},
    observe: (_id: string, handler: typeof observe, _onError: unknown, phase: typeof onPhase) => { observe = handler; onPhase = phase; return () => {}; },
    openTranscript: async (_id: string, handler: typeof publish) => {
      openCount++;
      if (failFirstRead && openCount === 1) throw new Error('transient initial read failure');
      publish = handler;
      handler({ messages: [], ready: true, hasOlder: false, hasNewer: false });
      return { observationChanged: () => {}, loadOlder: async () => {}, loadLatest: () => { loadLatestCount += 1; return latestRead.promise; }, close: async () => {} };
    },
    retractQueueEntry: async (...input: Parameters<WorkHubServices['retractQueueEntry']>) => { queueMutations.push(['retract', ...input]); },
    promoteQueueEntry: async (...input: Parameters<WorkHubServices['promoteQueueEntry']>) => { queueMutations.push(['promote', ...input]); },
    updateQueueEntry: async (...input: Parameters<WorkHubServices['updateQueueEntry']>) => { queueMutations.push(['update', ...input]); },
    reorderQueueEntries: async (...input: Parameters<WorkHubServices['reorderQueueEntries']>) => { queueMutations.push(['reorder', ...input]); },
    enqueueMessage: async (...input: Parameters<WorkHubServices['enqueueMessage']>) => { steers.push(input); onSteer?.(input); return steerResult; },
    answer: (_id: string, input: Parameters<WorkHubServices['answer']>[1]) => invoke('workhub:answer', input),
    stop: async (target: string, turnId: string) => {
      const result = await invoke('sessions:stop', target, { source: 'stop_button', expectedTurnId: turnId }) as DesktopSessionStopResult;
      return result?.kind === 'interrupted' ? result.retractedMessageIds : undefined;
    },
  } as unknown as WorkHubServices;
  function Probe() { controller = useWorkHubController(); return null; }
  await act(async () => {
    root.render(createElement(LocaleProvider, { locale: 'en', children:
      createElement(WorkHubServicesProvider, { services }, createElement(Probe)),
    }));
  });
  assert.equal(controller.sessionId, sessionId);
  return {
    get controller() { return controller; }, get openCount() { return openCount; },
    reconnect(epoch = hostEpoch) { hostEpoch = epoch; onPhase('pending'); onPhase('ready'); },
    complete(turnId: string) { rootTurn = { turnId, runId: `run:${turnId}`, status: 'completed' }; },
    onSteer(handler: typeof onSteer) { onSteer = handler; },
    queueMutations, steers, setSteerResult(value: typeof steerResult) { steerResult = value; },
    setStopRetractions(ids: string[]) { stopRetractions = ids; },
    sessionId, requests, get admission() { return admission; }, latestRead, interrupts,
    resetAdmission() { admission = deferred<{ turnId: string }>(); },
    admit(turnId: string) { rootTurn = { turnId, runId: `run:${turnId}`, status: 'running' }; },
    get loadLatestCount() { return loadLatestCount; },
    emit(event: Parameters<typeof observe>[0]) { observe(event); },
    publish(messages: StoredMessage[]) { publish({ messages, ready: true, hasOlder: false, hasNewer: false }); },
  };
}

test('WorkHub shows the submitted prompt before admission and keeps it until its durable user record arrives', async () => {
  const h = await mountController();
  await act(() => {
    h.emit({ type: 'text_delta', id: 'previous-output', turnId: 'previous-turn', messageId: 'previous-answer', ts: 1, text: 'Earlier answer' });
    h.emit({ type: 'abort', id: 'previous-abort', turnId: 'previous-turn', ts: 2, reason: 'user_stop' });
  });
  assert.ok(h.controller.liveTurn?.terminal);
  const text = '给我改成浅色主题';
  const attachments: AttachmentRef[] = [{ kind: 'doc', name: 'brief.txt', mimeType: 'text/plain', bytes: 4, ref: { kind: 'workspace_file', relativePath: 'brief.txt' } }];
  const followed: string[] = [];
  const unsubscribe = h.controller.viewportNavigation.subscribe((id) => followed.push(id));
  let sent!: Promise<boolean>;
  await act(async () => { sent = h.controller.send(text, attachments); });
  assert.deepEqual(h.controller.transientMessages.map((message) => message.text), [text]);
  assert.deepEqual(h.controller.transientMessages[0]!.attachments, attachments);
  assert.equal(h.requests.length, 1, 'the pending history read must not delay admission');
  assert.equal(h.loadLatestCount, 1);
  assert.deepEqual(followed, [h.sessionId]);
  const turnId = h.requests[0]!.turnId;
  assert.equal(h.controller.liveTurn?.turnId, turnId, 'waiting feedback starts before admission');
  assert.equal(h.controller.liveTurn?.phase, 'waiting');
  assert.equal(h.controller.busy, true);
  await act(async () => { h.admission.resolve({ turnId }); assert.equal(await sent, true); });
  assert.equal(h.controller.transientMessages.length, 1, 'an acknowledgement is not a durable message');
  await act(async () => {
    h.publish([{ type: 'assistant', id: 'reply', turnId, text: 'Working on it', ts: 2, modelId: 'fixture' }]);
  });
  assert.equal(h.controller.transientMessages.length, 1, 'assistant delivery cannot erase the user prompt');
  await act(async () => {
    h.publish([{ type: 'user', id: 'canonical-user-id', turnId, text, attachments, ts: 1 }]);
  });
  assert.equal(h.controller.transientMessages.length, 0);
  assert.deepEqual(h.controller.transcript.messages.map((message) => message.id), ['canonical-user-id']);
  unsubscribe();
  h.latestRead.resolve();
});

test('WorkHub removes a failed submission from the conversation and preserves its retry identity', async () => {
  const h = await mountController();
  let sent!: Promise<boolean>;
  await act(async () => { sent = h.controller.send('retry this prompt', []); });
  const turnId = h.requests[0]!.turnId;
  await act(async () => { h.admission.reject(new Error('admission rejected')); assert.equal(await sent, false); });
  assert.equal(h.controller.transientMessages.length, 0);
  assert.equal(h.controller.error, 'admission rejected');
  assert.equal(h.controller.liveTurn, undefined, 'rejected admission retires the waiting feedback');
  assert.equal(h.controller.busy, false);
  await act(async () => { assert.equal(await h.controller.send('retry this prompt', []), false); });
  assert.equal(h.requests[1]!.turnId, turnId);
  assert.equal(h.controller.transientMessages.length, 0);
  h.latestRead.resolve();
});

test('a lost admission response cannot erase confirmed WorkHub activity', async () => {
  const h = await mountController();
  let sent!: Promise<boolean>;
  await act(async () => { sent = h.controller.send('keep the real activity', []); });
  const turnId = h.requests[0]!.turnId;
  await act(() => h.emit({ type: 'text_delta', id: 'first-output', turnId, messageId: 'answer', ts: 1, text: 'Working' }));
  await act(async () => { h.admission.reject(new Error('response lost')); assert.equal(await sent, false); });
  assert.equal(h.controller.liveTurn?.turnId, turnId);
  assert.equal(h.controller.liveTurn?.unconfirmed, undefined);
  assert.equal(h.controller.busy, true);
  h.latestRead.resolve();
});


test('WorkHub carries Stop through deferred or uncertain admission for the original Turn', async () => {
  for (const order of ['stop-before-response', 'stop-after-response', 'response-before-observation', 'lost-response', 'observation-during-stop', 'rejected', 'terminal'] as const) {
    const h = await mountController();
    let sent!: Promise<boolean>;
    await act(async () => { sent = h.controller.send('stop this attempt', []); });
    const turnId = h.requests[0]!.turnId;
    if (order === 'stop-after-response') {
      h.admit(turnId);
      await act(async () => { h.admission.resolve({ turnId }); await sent; });
    } else if (order === 'lost-response') {
      await act(async () => {
        h.admission.reject(new RuntimeHostRequestInterruptedError('workhub.coordination.answer', 'control', 'dispatched', 'connection_lost'));
        assert.equal(await sent, true);
      });
      assert.equal(h.controller.busy, true, 'an unknown outcome still exposes Stop');
    }
    await act(async () => {
      const stopped = h.controller.stop();
      if (order === 'observation-during-stop') {
        h.admit(turnId);
        h.emit({ type: 'text_delta', id: 'first-output', turnId, messageId: 'answer', ts: 1, text: 'Working' });
      }
      await stopped;
    });
    if (order === 'rejected') {
      await act(async () => { h.admission.reject(new Error('admission rejected')); assert.equal(await sent, false); });
      assert.equal(h.controller.stopPending, false);
      assert.equal(h.controller.busy, false);
      assert.deepEqual(h.interrupts, []);
      // Retrying a rejected send keeps identity but must not inherit its Stop.
      h.resetAdmission();
      let retried!: Promise<boolean>;
      await act(async () => { retried = h.controller.send('stop this attempt', []); });
      assert.equal(h.requests[1]!.turnId, turnId);
      h.admit(turnId);
      await act(async () => {
        h.emit({ type: 'text_delta', id: 'retry-output', turnId, messageId: 'retry-answer', ts: 2, text: 'Retrying' });
        h.admission.resolve({ turnId });
        assert.equal(await retried, true);
      });
      assert.deepEqual(h.interrupts, [], 'a successful retry cannot inherit a rejected attempt’s Stop');
    } else if (order === 'terminal') {
      await act(async () => h.emit({ type: 'complete', id: 'done', turnId, ts: 1, stopReason: 'end_turn' }));
      await act(async () => { h.admission.resolve({ turnId }); await sent; });
      assert.equal(h.controller.stopPending, false);
      assert.equal(h.controller.busy, false);
      assert.deepEqual(h.interrupts, []);
    } else {
      if (order === 'response-before-observation') {
        await act(async () => { h.admission.resolve({ turnId }); await sent; });
        assert.deepEqual(h.interrupts, [], 'the response can precede the observer root');
      }
      if (order === 'stop-before-response' || order === 'lost-response' || order === 'response-before-observation') {
        assert.deepEqual(h.interrupts, []);
        h.admit('different-turn');
        await act(async () => h.emit({ type: 'text_delta', id: 'other', turnId: 'different-turn', messageId: 'other-answer', ts: 1, text: 'Other work' }));
        assert.deepEqual(h.interrupts, []);
        h.admit(turnId);
        if (order !== 'stop-before-response')
          await act(async () => h.emit({ type: 'text_delta', id: 'first-output', turnId, messageId: 'answer', ts: 2, text: 'Working' }));
      }
      if (order === 'stop-before-response' || order === 'observation-during-stop') {
        await act(async () => { h.admission.resolve({ turnId }); await sent; });
      }
      assert.deepEqual(h.interrupts, [{ sessionId: h.sessionId, turnId, runId: `run:${turnId}` }], order);
      assert.equal(h.controller.stopPending, false);
      h.admit('later-turn');
      await act(async () => h.emit({ type: 'text_delta', id: 'later', turnId: 'later-turn', messageId: 'later-answer', ts: 3, text: 'Later work' }));
      assert.equal(h.interrupts.length, 1, 'the intent cannot transfer to a later Turn');
    }
    h.latestRead.resolve();
    cleanupFakeDom();
  }
});


test('an unknown WorkHub submission converges through the original Host admission and payload', async () => {
  for (const outcome of ['not_admitted', 'running', 'completed', 'replay'] as const) {
    const h = await mountController();
    const attachments: AttachmentRef[] = [{ kind: 'doc', name: 'brief.txt', mimeType: 'text/plain', bytes: 4, ref: { kind: 'workspace_file', relativePath: 'brief.txt' } }];
    let sent!: Promise<boolean>;
    await act(async () => { sent = h.controller.send('original payload', attachments); });
    const original = h.requests[0]!;
    await act(async () => {
      h.admission.reject(new RuntimeHostRequestInterruptedError('workhub.coordination.answer', 'command', 'dispatched', 'connection_lost'));
      assert.equal(await sent, true);
      await h.controller.stop();
      h.publish([]);
    });
    assert.equal(h.controller.busy, true, 'absence in the same Host is not rejection');
    await act(async () => {
      h.emit({ type: 'text_delta', id: 'other-output', turnId: 'other-turn', messageId: 'other-answer', ts: 1, text: 'Other work' });
      h.emit({ type: 'complete', id: 'other-completed', turnId: 'other-turn', ts: 2, stopReason: 'end_turn' });
    });
    assert.equal(h.controller.busy, true, 'another Turn finishing cannot settle the original unknown submission');
    assert.equal(h.controller.stopPending, true);
    assert.equal(h.controller.canRetry, true);
    const submitted = h.requests.length;
    if (outcome === 'running') h.admit(original.turnId);
    if (outcome === 'completed') h.complete(original.turnId);
    if (outcome === 'replay') h.resetAdmission();
    await act(async () => h.reconnect(outcome === 'replay' ? undefined : 'host-epoch-2'));
    if (outcome === 'replay') {
      assert.deepEqual(h.requests.at(-1), original, 'replay keeps the original Turn, text and attachments');
      assert.equal(h.requests.length, submitted + 1);
      await act(async () => {
        h.admit(original.turnId);
        h.admission.resolve({ turnId: original.turnId });
      });
    } else assert.equal(h.requests.length, submitted, 'admission lookup must not send a new request after Host replacement');
    assert.equal(h.controller.stopPending, false);
    if (outcome === 'not_admitted' || outcome === 'completed') {
      assert.equal(h.controller.busy, false);
      assert.equal(h.interrupts.length, 0);
    } else {
      assert.deepEqual(h.interrupts.map(({ turnId }) => turnId), [original.turnId]);
    }
    if (outcome === 'not_admitted') {
      h.resetAdmission();
      await act(async () => h.controller.retry());
      assert.deepEqual(h.requests.at(-1), original, 'explicit Retry retains the text, attachments and unadmitted Turn identity');
      await act(async () => {
        h.admit(original.turnId);
        h.admission.resolve({ turnId: original.turnId });
      });
      assert.equal(h.interrupts.length, 0, 'explicit Retry cannot inherit the retired Stop intent');
      await act(async () => h.emit({ type: 'complete', id: 'retry-completed', turnId: original.turnId, ts: 2, stopReason: 'end_turn' }));
      h.resetAdmission();
      let next!: Promise<boolean>;
      await act(async () => { next = h.controller.send('a different message', []); });
      const nextTurn = h.requests.at(-1)!.turnId;
      assert.notEqual(nextTurn, original.turnId);
      await act(async () => { h.admit(nextTurn); h.admission.resolve({ turnId: nextTurn }); await next; });
      assert.equal(h.interrupts.length, 0, 'an unadmitted attempt cannot leave Stop on a later Turn');
    }
    h.latestRead.resolve();
    cleanupFakeDom();
  }
});

test('Retry reopens a failed initial WorkHub read after Session resolution', async () => {
  const h = await mountController(true);
  assert.ok(h.controller.sessionId);
  assert.equal(h.controller.transcript.ready, false);
  assert.equal(h.controller.canRetry, true);
  let sent!: Promise<boolean>;
  await act(async () => { sent = h.controller.send('retain this in-flight message', []); });
  const turnId = h.requests[0]!.turnId;
  await act(async () => h.controller.retry());
  assert.equal(h.openCount, 2);
  assert.equal(h.controller.liveTurn?.turnId, turnId);
  assert.equal(h.controller.transientMessages[0]?.text, 'retain this in-flight message');
  assert.equal(h.controller.transcript.ready, true);
  assert.equal(h.controller.error, undefined);
  await act(async () => { h.admission.resolve({ turnId }); await sent; });
  h.latestRead.resolve();
});


test('WorkHub steering keeps the current Turn and Stop authority and reconciles only its own durable message', async () => {
  const h = await mountController();
  let sent!: Promise<boolean>;
  await act(async () => { sent = h.controller.send('original request', []); });
  const turnId = h.requests[0]!.turnId;
  h.admit(turnId);
  await act(async () => { h.admission.resolve({ turnId }); await sent; });
  const attachments: AttachmentRef[] = [{ kind: 'doc', name: 'brief.txt', mimeType: 'text/plain', bytes: 4, ref: { kind: 'workspace_file', relativePath: 'brief.txt' } }];
  await act(async () => { assert.equal(await h.controller.send('change direction', attachments, 'steer'), true); });
  assert.equal(h.requests.length, 1, 'steering must not start or queue another answer');
  assert.equal(h.controller.liveTurn?.turnId, turnId);
  assert.deepEqual(h.steers[0]!.slice(2), ['change direction', attachments, 'current_turn']);
  const messageId = h.steers[0]![1];
  const original: StoredMessage = { type: 'user', id: 'original-canonical-id', turnId, text: 'original request', ts: 1 };
  await act(() => h.publish([original]));
  assert.deepEqual(h.controller.transientMessages.map((message) => message.id), [messageId],
    'an admitted response and unrelated transcript evidence must keep the submission visible');
  await act(() => h.emit({ type: 'steering_message', id: 'steer-observation', turnId, messageId, ts: 2, content: { text: 'change direction', attachments } }));
  assert.deepEqual(h.controller.transientMessages, [], 'live steering must not duplicate its admission placeholder while the transcript lags');
  await act(() => h.publish([original, { type: 'user', id: messageId, turnId, text: 'change direction', attachments, ts: 2 }]));
  assert.deepEqual(h.controller.transientMessages, []);
  await act(async () => { await h.controller.stop(); });
  assert.equal(h.interrupts[0]?.turnId, turnId);
  h.latestRead.resolve();
});

test('uncertain steering retains its identity across Turn completion and rejection preserves the active Turn', async () => {
  const h = await mountController();
  await act(() => h.emit({ type: 'text_delta', id: 'live', turnId: 'active-turn', messageId: 'answer', ts: 1, text: 'Working' }));
  h.setSteerResult('rejected');
  await act(async () => { assert.equal(await h.controller.send('change direction', [], 'steer'), false); });
  assert.equal(h.controller.liveTurn?.turnId, 'active-turn');
  assert.equal(h.controller.busy, true);
  assert.equal(h.controller.transientMessages.length, 0);
  h.setSteerResult('unknown');
  await act(async () => { assert.equal(await h.controller.send('change direction', [], 'steer'), false); });
  const messageId = h.steers[1]![1];
  await act(async () => { assert.equal(await h.controller.send('change direction', []), false); });
  assert.match(h.controller.error!, /Shift\+Enter/);
  assert.equal(h.steers.length, 2, 'Enter cannot silently replay uncertain steering or duplicate it');
  for (const [text, attachments] of [
    ['edited direction', []],
    ['change direction', [{ kind: 'doc', name: 'new.txt', mimeType: 'text/plain', bytes: 1,
      ref: { kind: 'workspace_file', relativePath: 'new.txt' } }]],
  ] as [string, AttachmentRef[]][]) {
    await act(async () => { assert.equal(await h.controller.send(text, attachments, 'steer'), false); });
  }
  assert.equal(h.steers.length, 2, 'edited text or attachments cannot overwrite an unknown attempt');
  assert.deepEqual(h.controller.transientMessages.map((message) => message.id), [messageId]);
  await act(() => h.emit({ type: 'complete', id: 'done', turnId: 'active-turn', ts: 2, stopReason: 'end_turn' }));
  h.setSteerResult('admitted');
  await act(async () => { assert.equal(await h.controller.send('change direction', [], 'steer'), true); });
  assert.equal(h.steers[2]![1], messageId);
  assert.equal(h.requests.length, 0, 'retry must recover the steering receipt even after its Turn ends');
  h.latestRead.resolve();
});


test('Host retraction resolves an uncertain WorkHub attempt before the next draft is sent', async () => {
  const h = await mountController();
  await act(() => h.emit({ type: 'text_delta', id: 'live', turnId: 'active-turn', messageId: 'answer', ts: 1, text: 'Working' }));
  h.setSteerResult('unknown');
  await act(async () => { assert.equal(await h.controller.send('old direction', [], 'steer'), false); });
  const messageId = h.steers[0]![1];
  await act(() => h.emit({ type: 'message_admission', id: 'retracted', turnId: 'active-turn', messageId, ts: 2, outcome: 'retracted' }));
  assert.equal(h.controller.transientMessages.length, 0);
  h.setSteerResult('admitted');
  await act(async () => { assert.equal(await h.controller.send('new direction', [], 'steer'), true); });
  assert.notEqual(h.steers[1]![1], messageId);
  h.latestRead.resolve();
});

test('steering observed before its admission response renders once and outranks an uncertain receipt', async () => {
  const h = await mountController();
  await act(() => h.emit({ type: 'text_delta', id: 'live', turnId: 'active-turn', messageId: 'answer', ts: 1, text: 'Working' }));
  h.setSteerResult('unknown');
  h.onSteer(([, messageId, text]) => h.emit({ type: 'steering_message', id: 'consumed', turnId: 'active-turn', messageId, ts: 2, content: { text } }));
  await act(async () => { assert.equal(await h.controller.send('change direction', [], 'steer'), true); });
  assert.deepEqual(h.controller.transientMessages, []);
  assert.equal(h.controller.error, undefined);
  assert.equal(h.controller.liveTurn?.turnId, 'active-turn');
  h.latestRead.resolve();
});


test('WorkHub Host queue owns restored, consumed and retracted rows without transient mirrors', async () => {
  const h = await mountController();
  await act(() => h.emit({ type: 'text_delta', id: 'live', turnId: 'active-turn', messageId: 'answer', ts: 1, text: 'Working' }));
  const entry = { entryId: 'queued', messageId: 'queued', placement: 'current_turn' as const, state: 'queued' as const, content: { text: 'change direction' } };
  const project = (state: 'queued' | 'in_flight') => h.emit({
    type: 'queue_update', id: 'snapshot', turnId: 'active-turn', ts: 2,
    steering: [entry.content.text], followup: [], steeringEntries: [{ ...entry, state }],
  });
  await act(() => project('queued'));
  assert.deepEqual(h.controller.messageQueue.entries, [entry]);
  assert.deepEqual(h.controller.transientMessages, []);
  await act(() => h.emit({ type: 'steering_message', id: 'consumed', turnId: 'active-turn', ts: 3, messageId: entry.messageId, content: entry.content }));
  await act(() => project('in_flight'));
  assert.deepEqual(h.controller.messageQueue.entries, []);
  assert.deepEqual(h.controller.transientMessages, [], 'an in-flight snapshot cannot resurrect consumed steering');
  await act(() => project('queued'));
  await act(async () => { await h.controller.deleteQueuedEntry(entry.entryId); });
  await act(() => h.emit({ type: 'queue_update', id: 'removed', turnId: 'active-turn', ts: 4, steering: [], followup: [], steeringEntries: [] }));
  assert.deepEqual(h.controller.messageQueue.entries, []);
  assert.deepEqual(h.controller.transientMessages, [], 'withdrawal needs no separate admission event');
  h.latestRead.resolve();
});

test('WorkHub sends queue edits, withdrawal and both queue orders to the Host and waits for its projection', async () => {
  const h = await mountController();
  const entries = ['first', 'second'].map((id) => ({ entryId: id, messageId: id,
    content: { text: id }, placement: 'current_turn' as const, state: 'queued' as const }));
  await act(() => h.emit({ type: 'queue_update', id: 'queued', turnId: 'active-turn', ts: 2,
    queueRevision: 7, steering: ['first', 'second'], followup: [], steeringEntries: entries }));
  await act(async () => {
    await h.controller.updateQueuedEntry('second', 7, 'edited second');
    await h.controller.reorderQueuedEntries(['second', 'first']);
    await h.controller.deleteQueuedEntry('first');
  });
  assert.deepEqual(h.queueMutations, [
    ['update', h.controller.sessionId, 'second', 7, 'edited second'],
    ['reorder', h.controller.sessionId, ['second', 'first']],
    ['retract', h.controller.sessionId, 'first'],
  ]);
  assert.deepEqual(h.controller.messageQueue.entries.map((entry) => entry.entryId), ['first', 'second']);
  await act(() => h.emit({ type: 'queue_update', id: 'updated', turnId: 'active-turn', ts: 3,
    queueRevision: 10, steering: ['edited second'], followup: [], steeringEntries: [{ ...entries[1]!, content: { text: 'edited second' } }] }));
  assert.deepEqual(h.controller.messageQueue.entries.map((entry) => entry.content.text), ['edited second']);
  assert.deepEqual(h.controller.transientMessages, []);
  h.latestRead.resolve();
});


test('WorkHub defaults to follow-up and moves each message into its admitted successor Turn', async () => {
  const h = await mountController();
  await act(() => h.emit({ type: 'text_delta', id: 'live', turnId: 'active-turn', messageId: 'answer', ts: 1, text: 'Working' }));
  const attachments: AttachmentRef[] = [{ kind: 'doc', name: 'brief.txt', mimeType: 'text/plain', bytes: 4, ref: { kind: 'workspace_file', relativePath: 'brief.txt' } }];
  await act(async () => {
    assert.equal(await h.controller.send('first follow-up', attachments), true);
    assert.equal(await h.controller.send('second follow-up', []), true);
  });
  assert.deepEqual(h.steers.map((input) => input.slice(2)), [
    ['first follow-up', attachments, 'next_turn'], ['second follow-up', [], 'next_turn'],
  ]);
  assert.equal(h.requests.length, 0);
  assert.equal(h.controller.liveTurn?.turnId, 'active-turn');
  const first = h.steers[0]![1];
  const second = h.steers[1]![1];
  assert.deepEqual(h.controller.transientMessages.map((message) => message.id), [first, second]);
  await act(() => h.reconnect());
  assert.deepEqual(h.controller.transientMessages.map((message) => message.id), [first, second],
    'disconnecting before canonical evidence cannot hide accepted messages');
  const entries = h.steers.map(([, messageId, text, attachments]) => ({
    entryId: messageId, messageId, content: { text, attachments }, placement: 'next_turn' as const, state: 'queued' as const,
  }));
  await act(() => h.emit({ type: 'queue_update', id: 'queued', turnId: 'active-turn', ts: 2,
    steering: [], followup: entries.map((entry) => entry.content.text), followupEntries: entries }));
  await act(() => h.emit({ type: 'message_admission', id: 'first-admission', turnId: 'successor', messageId: first, ts: 2, outcome: 'admitted' }));
  assert.deepEqual(h.controller.messageQueue.entries.map((entry) => entry.messageId), [second]);
  await act(() => h.publish([{ type: 'user', id: first, turnId: 'successor', text: 'first follow-up', attachments, ts: 2 }]));
  assert.deepEqual(h.controller.transientMessages, []);
  assert.deepEqual(h.controller.messageQueue.entries.map((entry) => entry.messageId), [second]);
  h.latestRead.resolve();
});

test('follow-up admission before an uncertain response keeps its successor placement', async () => {
  const h = await mountController();
  await act(() => h.emit({ type: 'text_delta', id: 'live', turnId: 'active-turn', messageId: 'answer', ts: 1, text: 'Working' }));
  h.setSteerResult('unknown');
  h.onSteer(([, messageId]) => h.emit({ type: 'message_admission', id: 'admitted', turnId: 'successor', messageId, ts: 2, outcome: 'admitted' }));
  await act(async () => { assert.equal(await h.controller.send('next request', []), true); });
  assert.equal(h.controller.transientMessages[0]?.transientPlacement, 'current_turn');
  assert.equal(h.controller.transientMessages[0]?.hostTurnId, 'successor');
  assert.equal(h.controller.error, undefined);
  h.latestRead.resolve();
});


test('Stop retires only Host-confirmed queued messages even without retraction events', async () => {
  for (const origin of ['local', 'restored'] as const) {
    const h = await mountController();
    let turnId = 'active-turn';
    if (origin === 'local') {
      let sent!: Promise<boolean>;
      await act(async () => { sent = h.controller.send('original request', []); });
      turnId = h.requests[0]!.turnId;
      h.admit(turnId);
      await act(async () => { h.admission.resolve({ turnId }); await sent; });
    } else {
      h.admit(turnId);
      await act(() => h.emit({ type: 'text_delta', id: 'live', turnId, messageId: 'answer', ts: 1, text: 'Working' }));
    }
    const entries = ['steering', 'followup', 'retained'].map((messageId) => ({
      messageId, entryId: messageId, content: { text: messageId }, state: 'queued' as const,
      placement: messageId === 'steering' ? 'current_turn' as const : 'next_turn' as const,
    }));
    await act(() => h.emit({ type: 'queue_update', id: 'queued', turnId, ts: 2,
      steering: ['steering'], followup: ['followup', 'retained'],
      steeringEntries: entries.slice(0, 1), followupEntries: entries.slice(1),
    }));
    h.setStopRetractions(['steering', 'followup']);
    await act(async () => { await h.controller.stop(); });
    assert.deepEqual(h.controller.messageQueue.entries.map((entry) => entry.messageId), ['retained']);
    assert.deepEqual(h.controller.transientMessages.filter((message) => message.id !== turnId), []);
    assert.equal(h.controller.stopPending, false);
    h.latestRead.resolve();
    cleanupFakeDom();
  }
});
