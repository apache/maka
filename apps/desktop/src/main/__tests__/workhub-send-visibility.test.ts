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
import type { AttachmentRef } from '@maka/core/events';
import type { StoredMessage } from '@maka/core/session';
import { WorkHubServicesProvider, type WorkHubServices, type WorkHubTranscriptSnapshot } from '../../renderer/features/workhub/index.js';
import { useWorkHubController } from '../../renderer/features/workhub/testing.js';
import { cleanupFakeDom, installReactRenderer } from './fake-dom.js';

afterEach(cleanupFakeDom);

async function mountController() {
  const { root } = installReactRenderer();
  let controller!: ReturnType<typeof useWorkHubController>;
  let publish!: (snapshot: WorkHubTranscriptSnapshot) => void;
  let observe!: Parameters<WorkHubServices['observe']>[1];
  let loadLatestCount = 0;
  const admission = deferred<{ turnId: string }>();
  const latestRead = deferred<void>();
  const requests: Array<Parameters<WorkHubServices['answer']>[1]> = [];
  const sessionId = JSON.stringify(['host-1', 'workhub-coordination']);
  const services = {
    resolve: async () => sessionId,
    getSession: async () => ({ id: sessionId, runningTurnIds: [] }),
    listSessions: async () => [],
    modelChoices: async () => [],
    subscribeHosts: () => () => {},
    subscribeAvailability: () => () => {},
    subscribeSessions: () => () => {},
    observe: (_id: string, handler: typeof observe) => { observe = handler; return () => {}; },
    openTranscript: async (_id: string, handler: typeof publish) => {
      publish = handler;
      handler({ messages: [], ready: true, hasOlder: false, hasNewer: false });
      return { loadOlder: async () => {}, loadLatest: () => { loadLatestCount += 1; return latestRead.promise; }, close: async () => {} };
    },
    answer: async (_id: string, input: Parameters<WorkHubServices['answer']>[1]) => {
      requests.push(input);
      return admission.promise;
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
    get controller() { return controller; }, sessionId, requests, admission, latestRead,
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
