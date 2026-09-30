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
import test, { type TestContext } from 'node:test';
import { markPersisted } from '@maka/core/persisted-value';
import { decodeStoredMessage, type StoredMessage } from '@maka/core/session';
import { waitFor } from '@maka/core/test-only/async-primitives';
import { SESSION_CONTINUITY_SCHEMA_VERSION } from '@maka/runtime-host/protocol';
import { ClientSessionSubscription } from '../../../../../packages/runtime-host/dist/client/session-subscription.js';
import { createSessionTranscriptBootstrap, readSessionTranscriptPage, updateSubscriberTranscriptHighWater } from '../../../../../packages/runtime-host/dist/server/session-transcript-pager.js';
import { RuntimeHostSessionObserver } from '../runtime-host-session-observer.js';
import { RuntimeHostSessionObservationRegistry } from '../runtime-host-session-observation-registry.js';
import { createDesktopTranscriptRangeController, DesktopTranscriptRangeStore } from '../../renderer/platform/desktop/desktop-transcript-range-store.js';
import type { DesktopTranscriptBatch, DesktopTranscriptHandle, DesktopTranscriptPosition } from '../../preload/transcript-contract.js';
import { runtimeHostSessionFixture } from './runtime-host-session-test-fixture.js';
import { openTranscriptLedger } from './transcript-ledger-test-fixture.js';

function turn(id: string): StoredMessage[] {
  return [
    { type: 'user', id: `user-${id}`, turnId: id, ts: 1, text: `Question ${id}` },
    { type: 'assistant', id: `answer-${id}`, turnId: id, ts: 2, text: `Answer ${id} ${'x'.repeat(400)}`, modelId: 'fixture-model' },
    { type: 'turn_state', id: `done-${id}`, turnId: id, ts: 3, status: 'completed' },
  ];
}

async function harness(t: TestContext, source: StoredMessage[], initialTurnId: string, checkpoint = source.at(-1)!.id) {
  const ledger = await openTranscriptLedger(source);
  await ledger.appendThrough(checkpoint);
  const { reader, sessionId } = ledger;
  const store = new DesktopTranscriptRangeStore(JSON.stringify(['host-1', sessionId]));
  const requests: Parameters<ClientSessionSubscription['loadTranscriptPage']>[0][] = [];
  const markers: string[] = [];
  const errors: unknown[] = [];
  const observers: RuntimeHostSessionObserver[] = [];
  let currentSubscription: ClientSessionSubscription;
  let currentState: Awaited<ReturnType<typeof createSessionTranscriptBootstrap>>['state'];
  let frameSequence = 1;
  const registry = new RuntimeHostSessionObservationRegistry((error) => errors.push(error));
  const newObserver = () => {
    const observer = new RuntimeHostSessionObserver({
      client: {
        async openSession() {
          const subscriptionId = `subscription-${sessionId}`;
          const opened = await createSessionTranscriptBootstrap({
            reader, sessionId, subscriptionId, throughSequence: await reader.readDurableHighWater(sessionId),
            maxBytes: 1024, projection: 'owner',
          });
          currentState = opened.state;
          frameSequence = 1;
          const subscription = new ClientSessionSubscription({
            hostEpoch: 'host-1', subscriptionId, nextSequence: 1, activeAssistantStreams: [], transcript: opened.bootstrap,
            snapshot: {
              schemaVersion: SESSION_CONTINUITY_SCHEMA_VERSION,
              session: { sessionId, metadataRevision: 1, status: 'active', createdAt: 1, isArchived: false },
              projectionRevision: 1, rootTurn: null, goal: null,
              queue: { hostEpoch: 'host-1', queueRevision: 0, steering: [], followup: [] }, interactions: { pending: [] },
            },
          }, async () => {}, async (request) => {
            requests.push(request);
            return readSessionTranscriptPage({ reader, state: opened.state, request });
          }, async () => {});
          currentSubscription = subscription;
          return runtimeHostSessionFixture({
            snapshot: subscription.snapshot, events: subscription, transcriptBootstrap: opened.bootstrap,
            transcriptWatermark: () => subscription.transcriptWatermark,
            decodeTranscriptPage: (page, maxBytes, accountBytes) => subscription.decodeTranscriptPage(
              page, (value) => decodeStoredMessage(markPersisted<StoredMessage>(value)), maxBytes, accountBytes,
            ),
            loadTranscriptPage: (request) => subscription.loadTranscriptPage(request),
            close: () => subscription.close(),
          });
        },
        listSessionTurnLandmarks: async (id, turnId) => ({
          sessionId: id, ...await reader.readDurableTurnLandmarks(id, { turnId: turnId ?? null, maxLandmarks: 100 }),
        }),
        async setSessionReadMarker(_id, messageId) {
          markers.push(messageId);
          return undefined as never;
        },
      },
      emitSessionsChanged() {}, transcriptHistoryBytes: 1200, transcriptInitialHistoryBytes: 600,
    });
    observers.push(observer);
    return observer;
  };
  let observer = newObserver();
  await registry.attach(observer);
  let nextConsumer = 0;
  const controller = createDesktopTranscriptRangeController(store, async (
    signal: AbortSignal, resumeFrom?: number, position?: DesktopTranscriptPosition,
    receive: (batch: DesktopTranscriptBatch) => void = (batch) => { store.accept(batch); },
  ): Promise<DesktopTranscriptHandle> => {
    const consumerId = `window-${++nextConsumer}`;
    const cancel = () => { void registry.closeTranscript(consumerId); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) throw new Error('cancelled');
    try {
      const opened = await registry.openTranscript(sessionId, consumerId, {
        id: 9, once() {}, off() {},
        send(_channel, batch) {
          if (!signal.aborted) receive(batch);
          queueMicrotask(() => {
            if (!signal.aborted) registry.acknowledgeTranscript(consumerId, batch.generation, batch.deliverySequence, 9);
          });
        },
      }, 'history', resumeFrom, position);
      return {
        ...opened,
        acknowledgeTail: (through) => registry.acknowledgeTranscriptTail({ consumerId, sessionId, hostEpoch: opened.hostEpoch, through }, 9),
        loadEarlier: (floor) => registry.loadEarlierTranscript(consumerId, 9, floor),
        loadNewer: () => registry.loadNewerTranscript(consumerId, 9),
        async close() { signal.removeEventListener('abort', cancel); await registry.closeTranscript(consumerId); },
      };
    } catch (error) {
      signal.removeEventListener('abort', cancel);
      throw error;
    }
  }, { initialTurnId, onError: (error) => errors.push(error) });
  t.after(async () => {
    await controller.close();
    await registry.close();
    for (const instance of observers) await instance.close();
    await ledger.close();
  });
  await controller.ready();
  return {
    store, controller, ledger, requests, markers, errors,
    acknowledgeAs(targetId: number) {
      observer.acknowledgeTranscriptTail({
        consumerId: 'window-1', sessionId, hostEpoch: 'host-1', through: Number.MAX_SAFE_INTEGER,
      }, targetId);
    },
    async reconnect() {
      const previous = observer;
      registry.detach(previous);
      observer = newObserver();
      const generation = store.range().generation;
      await registry.attach(observer);
      await waitFor(() => store.range().generation !== generation, { timeoutMs: 3000 });
      await previous.close();
    },
    async append(messageId: string) {
      const throughSequence = await ledger.appendThrough(messageId);
      updateSubscriberTranscriptHighWater(currentState, throughSequence);
      currentSubscription.accept({
        kind: 'subscription.transcript_advanced', sessionId, hostEpoch: 'host-1',
        subscriptionId: `subscription-${sessionId}`, sequence: frameSequence++, throughSequence: throughSequence!,
      });
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('opens an indexed window, reads both directions, and exports without replacing or marking the old view read', async (t) => {
  const h = await harness(t, Array.from({ length: 100 }, (_, i) => turn(`t${i}`)).flat(), 't40');
  const first = h.store.snapshot();
  assert.ok(first.messages.some((message) => message.turnId === 't40'));
  assert.ok(first.messages.length < 20, 'opening must not fill forty Turns to the tail');
  assert.equal(first.hasNewer, true);
  assert.equal(first.hasOlder, true);
  assert.ok(h.requests.length < 12, 'the page work is bounded by the target neighborhood');
  assert.throws(() => h.acknowledgeAs(10), /another renderer/);
  h.acknowledgeAs(9);
  assert.deepEqual(h.markers, []);
  const complete = await h.controller.readComplete();
  assert.deepEqual(complete.map(({ id }) => id), (await h.ledger.durableRecords()).map(({ message }) => message.id));
  assert.equal(h.store.snapshot(), first, 'export does not replace the reader');
  assert.deepEqual(h.markers, [], 'an explicit full read is not a visible tail acknowledgement');
  await h.controller.loadEarlier();
  assert.ok(h.store.range().oldestSequence! < first.oldestSequence!);
  await h.controller.loadNewer();
  assert.ok(h.store.range().durableThrough! > first.durableThrough!);
  const beforeReconnect = h.store.snapshot();
  await h.reconnect();
  assert.deepEqual(h.store.snapshot().messages, beforeReconnect.messages);
  assert.equal(h.store.range().hasNewer, true);
  assert.deepEqual(h.markers, []);
  await h.controller.showLatest();
  assert.equal(h.store.range().hasNewer, false);
  assert.ok(h.store.snapshot().messages.some((message) => message.turnId === 't99'));
  await waitFor(() => h.markers.length > 0, { timeoutMs: 1000 });
  assert.deepEqual(h.errors, []);
});

test('seeking a nested Turn includes the enclosing rows across both page edges', async (t) => {
  const outer = turn('outer');
  const inner = turn('inner');
  const source = [outer[0]!, ...inner, outer[1]!, outer[2]!, ...turn('later'), ...turn('last')];
  const h = await harness(t, source, 'inner');
  const ids = h.store.snapshot().messages.map(({ id }) => id);
  assert.ok(ids.includes('user-outer'));
  assert.ok(ids.includes('user-inner'));
  assert.ok(ids.includes('answer-inner'));
  assert.ok(ids.includes('answer-outer'));
  assert.equal(new Set(ids).size, ids.length);
  const all = await h.ledger.durableRecords();
  assert.deepEqual(ids, all.filter(({ sequence }) => sequence <= h.store.range().durableThrough!).map(({ message }) => message.id));
  assert.deepEqual(h.errors, []);
});

test('new live-tail rows stay outside a parked window and can be checked for durability without navigation', async (t) => {
  const source = Array.from({ length: 20 }, (_, i) => turn(`t${i}`)).flat();
  const h = await harness(t, source, 't0', 'done-t18');
  const parked = h.store.snapshot();
  assert.equal(parked.hasNewer, true);
  const settled = h.controller.waitForDurableMessage('answer-t19', 1000);
  await new Promise((resolve) => setImmediate(resolve));
  await h.append('done-t19');
  assert.equal(await settled, true);
  assert.equal(h.store.snapshot(), parked);
  assert.deepEqual(h.markers, []);
  let reads = 0;
  while (h.store.range().hasNewer) {
    assert.ok(++reads < 50, 'forward paging must advance');
    await h.controller.loadNewer();
  }
  assert.deepEqual(h.store.snapshot().messages.map(({ id }) => id), (await h.ledger.durableRecords()).map(({ message }) => message.id));
  assert.deepEqual(h.errors, []);
});

test('an indexed window reassembles a message spanning Host pages and Desktop IPC fragments', async (t) => {
  const text = '跨页'.repeat(24 * 1024);
  const large = turn('large').map((message) => message.type === 'assistant' ? { ...message, text } : message);
  const h = await harness(t, [...turn('before'), ...large, ...Array.from({ length: 20 }, (_, i) => turn(`after-${i}`)).flat()], 'large');
  const messages = h.store.snapshot().messages;
  const answer = messages.find((message) => message.id === 'answer-large');
  assert.equal(answer?.type === 'assistant' ? answer.text : undefined, text);
  assert.ok(messages.some((message) => message.id === 'done-large'));
  assert.equal(new Set(messages.map(({ id }) => id)).size, messages.length);
  assert.equal(h.store.range().hasNewer, true);
  assert.deepEqual(h.markers, []);
  assert.deepEqual(h.errors, []);
});

test('the last navigation wins over a pending seek and tail jump', async (t) => {
  const h = await harness(t, Array.from({ length: 40 }, (_, i) => turn(`t${i}`)).flat(), 't0');
  const rows = await h.ledger.durableRecords();
  const sequence = rows.find(({ message }) => message.id === 'user-t15')!.sequence;
  const obsolete = h.controller.seek(rows.find(({ message }) => message.id === 'user-t30')!.sequence);
  const tail = h.controller.showLatest();
  const final = h.controller.seek(sequence);
  const results = await Promise.allSettled([obsolete, tail, final]);
  assert.equal(results[2]!.status, 'fulfilled');
  assert.ok(h.store.snapshot().messages.some(({ id }) => id === 'user-t15'));
  assert.ok(!h.store.snapshot().messages.some(({ id }) => id === 'user-t39'));
  assert.equal(h.store.range().hasNewer, true);
  assert.deepEqual(h.markers, []);
  assert.deepEqual(h.errors, []);
});
