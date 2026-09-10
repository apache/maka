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
  const interrupts: Array<{ sessionId: string; turnId: string; runId: string }> = [];
  const handlers = new Map<string, IpcHandler>();
  const ipc = { handle: (channel: string, handler: IpcHandler) => { handlers.set(channel, handler); } };
  registerRuntimeHostSessionExecutionIpc({
    observer: { snapshot: async () => ({ rootTurn }) },
    beforeStop: async () => {},
    emitSessionsChanged: () => {},
    client: { interruptTurn: async (input: typeof interrupts[number]) => {
      interrupts.push({ sessionId: input.sessionId, turnId: input.turnId, runId: input.runId });
      rootTurn!.status = 'cancelled';
      return { retracted: [] };
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
    answer: (_id: string, input: Parameters<WorkHubServices['answer']>[1]) => invoke('workhub:answer', input),
    stop: (target: string, turnId: string) => invoke('sessions:stop', target, { source: 'stop_button', expectedTurnId: turnId }),
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
