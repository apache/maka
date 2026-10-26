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
import { setImmediate as turn } from 'node:timers/promises';
import { createDesktopPetPresentation } from '../../renderer/platform/desktop/pet-presentation.js';
import { encodeDesktopTranscriptSnapshot } from '../desktop-transcript-ipc.js';

function harness(t: any) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const opens: any[] = [], published: any[] = [];
  t.mock.timers.enable({ apis: ['setTimeout'] });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { maka: {
    petDesktop: { publish: (value: any) => published.push(value) },
    transcripts: { open: async (session: string, receive: Function, register: Function) => {
      let resolve!: (value: any) => void;
      const pending = new Promise<any>(done => { resolve = done; });
      const entry = { resolve: () => resolve({ generation: entry.generation, close: async () => { entry.closed = true; } }), session, receive, closed: false, cancelled: false, generation: opens.length === 0 ? 'cached:offline' : `live:${opens.length}` };
      opens.push(entry);
      register(() => { entry.cancelled = true; });
      return pending;
    } },
  } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'window', previous); else Reflect.deleteProperty(globalThis, 'window'); });
  const send = (entry: any, ids: string[]) => {
    for (const batch of encodeDesktopTranscriptSnapshot({
      sessionId: JSON.parse(entry.session)[1], generation: entry.generation, hostEpoch: 'host',
      durableThrough: ids.length, hasOlder: false, beginsAtTurnBoundary: true,
      durable: ids.map((id, i) => ({ sequence: i + 1, message: { id, type: 'assistant' as const, text: id, ts: i, turnId: 'turn', modelId: 'model' } })),
    })) entry.receive(batch);
  };
  return { opens, published, send, pet: createDesktopPetPresentation() };
}

test('cache-only transcript retries live and retains message deduplication', async t => {
  const h = harness(t);
  const stop = h.pet.observeMessages(JSON.stringify(['host', 'session']), () => assert.fail('cache is recoverable'));
  await turn();
  h.send(h.opens[0], ['old']); h.opens[0].resolve(); await turn();
  t.mock.timers.tick(1000); await turn();
  assert.equal(h.opens.length, 2, 'cached handles must not permanently own the subscription');
  assert.equal(h.opens[0].closed, true);
  h.opens[1].resolve(); await turn();
  h.send(h.opens[1], ['old', 'new']);
  h.send(h.opens[1], ['old', 'new']);
  assert.deepEqual(h.published.map(x => x.messages.map((m: any) => m.id)), [['new']]);
  stop();
  assert.equal(h.opens[1].closed, true);
});

test('cancelling a cached observation stops retries and ignores stale session deliveries', async t => {
  const h = harness(t);
  const stop = h.pet.observeMessages(JSON.stringify(['host', 'first']), () => {});
  await turn(); h.send(h.opens[0], ['old']); h.opens[0].resolve(); await turn(); stop();
  const nextStop = h.pet.observeMessages(JSON.stringify(['host', 'second']), () => {});
  await turn(); h.send(h.opens[1], ['initial']); h.opens[1].resolve(); await turn();
  h.send(h.opens[0], ['old', 'wrong-session']);
  t.mock.timers.tick(5000); await turn();
  assert.equal(h.opens.length, 2);
  h.send(h.opens[1], ['initial', 'right-session']);
  assert.deepEqual(h.published.map(x => x.sessionId), [JSON.stringify(['host', 'second'])]);
  nextStop();
});


test('an open resolving after cancellation closes its late handle and cannot replay after remount', async t => {
  const h = harness(t);
  const stop = h.pet.observeMessages(JSON.stringify(['host', 'session']), () => assert.fail('cancelled open'));
  await turn(); stop();
  h.opens[0].resolve(); await turn();
  assert.equal(h.opens[0].closed, true);
  assert.equal(h.opens[0].cancelled, true);
  const remountedStop = h.pet.observeMessages(JSON.stringify(['host', 'session']), () => {});
  await turn(); h.send(h.opens[1], ['history']); h.opens[1].resolve(); await turn();
  h.send(h.opens[0], ['history', 'stale']);
  assert.equal(h.published.length, 0);
  h.send(h.opens[1], ['history', 'fresh']);
  assert.deepEqual(h.published.flatMap(x => x.messages.map((m: any) => m.id)), ['fresh']);
  remountedStop();
});
