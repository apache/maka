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
import test from 'node:test';
import { createBotTranscriptCore } from '../app/botTranscriptCore.ts';

const SESSION = 'bot-session';
const message = (sequence, turnId, text = `m${sequence}`) => ({
  sequence,
  messageId: `id${sequence}`,
  index: 0,
  text,
  at: 0,
  turnId,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A Host whose outbox reads can be held back or made to fail. */
function host({ messages = [], hold = false, fail = false } = {}) {
  const state = { messages, hold, fail, releases: [], reads: 0, watchers: [] };
  const query = async (_endpoint, _method, input) => {
    const through = state.messages.length;
    if (input.limit === 0) return { sessionId: SESSION, through, messages: [] };
    state.reads += 1;
    if (state.hold) await new Promise((resolve) => state.releases.push(resolve));
    if (state.fail) throw new Error('outbox read failed');
    const page = state.messages.filter((m) => m.sequence > (input.after ?? 0));
    return { sessionId: SESSION, through, messages: page, nextAfter: null };
  };
  const subscribe = async () => ({
    next: () => new Promise((resolve) => state.watchers.push(resolve)),
    close: async () => {},
  });
  return { state, host: { query, subscribe } };
}
const turn = (core, id) => ({
  replies: core.forTurn(id).length,
  confirmedEmpty: core.confirmedEmpty(id),
});

test('a Turn is not known to have sent nothing while its replies are still being read', async () => {
  const { state, host: h } = host({ messages: [message(1, 'turn-a')], hold: true });
  const core = createBotTranscriptCore(h, SESSION, () => {});
  await core.started;
  await settle();
  assert.equal(core.isBot(), true);
  // The reply exists in the Host but its page has not arrived: unknown, not empty.
  assert.deepEqual(turn(core, 'turn-a'), { replies: 0, confirmedEmpty: false });
  void core.confirm('turn-a');
  await settle();
  assert.equal(core.confirmedEmpty('turn-a'), false, 'confirmation waits for the read');
  state.hold = false;
  for (const release of state.releases) release();
  await settle();
  assert.deepEqual(turn(core, 'turn-a'), { replies: 1, confirmedEmpty: false });
  core.close();
});

test('a failed outbox read never confirms that a Turn sent nothing', async () => {
  const { state, host: h } = host({ messages: [message(1, 'turn-a')], fail: true });
  const core = createBotTranscriptCore(h, SESSION, () => {});
  await core.started;
  await settle();
  await core.confirm('turn-a');
  await settle();
  assert.deepEqual(turn(core, 'turn-a'), { replies: 0, confirmedEmpty: false });
  // Reading works again: the next ask reaches the reply instead of an empty answer.
  state.fail = false;
  await core.confirm('turn-a');
  assert.deepEqual(turn(core, 'turn-a'), { replies: 1, confirmedEmpty: false });
  core.close();
});

test('a Turn is confirmed empty only by a read that reached the head', async () => {
  const { host: h } = host({ messages: [message(1, 'turn-a')] });
  const core = createBotTranscriptCore(h, SESSION, () => {});
  await core.started;
  await settle();
  await core.confirm('turn-b');
  assert.deepEqual(turn(core, 'turn-b'), { replies: 0, confirmedEmpty: true });
  assert.deepEqual(turn(core, 'turn-a'), { replies: 1, confirmedEmpty: false });
  core.close();
});

test('a reply that lands after the Turn ended is read before confirming', async () => {
  const { state, host: h } = host({ messages: [] });
  const core = createBotTranscriptCore(h, SESSION, () => {});
  await core.started;
  await settle();
  // The Turn ends; its reply was committed just before, after our last head read.
  state.messages.push(message(1, 'turn-a'));
  await core.confirm('turn-a');
  assert.deepEqual(turn(core, 'turn-a'), { replies: 1, confirmedEmpty: false });
  core.close();
});

test('an ordinary Session makes one lookup and is never a Bot', async () => {
  let queries = 0;
  let subscribed = false;
  const core = createBotTranscriptCore(
    {
      query: async () => {
        queries += 1;
        return { sessionId: null, through: 0, messages: [] };
      },
      subscribe: async () => {
        subscribed = true;
        return { next: async () => null, close: async () => {} };
      },
    },
    'ordinary',
    () => {},
  );
  await core.started;
  assert.equal(core.isBot(), false);
  await core.confirm('turn-a');
  assert.equal(core.confirmedEmpty('turn-a'), false);
  assert.equal(queries, 1);
  assert.equal(subscribed, false);
  core.close();
});

test('concurrent confirmations share reads and the outbox is read in order', async () => {
  const { state, host: h } = host({ messages: [message(1, 'turn-a'), message(2, 'turn-a')] });
  const core = createBotTranscriptCore(h, SESSION, () => {});
  await core.started;
  await settle();
  const before = state.reads;
  await Promise.all(['t1', 't2', 't3', 't4'].map((id) => core.confirm(id)));
  assert.equal(core.forTurn('turn-a').length, 2, 'no message is read twice');
  for (const id of ['t1', 't2', 't3', 't4']) assert.equal(core.confirmedEmpty(id), true);
  assert.ok(state.reads - before <= 2, `reads were shared (${state.reads - before})`);
  core.close();
});
