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
import { botTurnEnding, createBotTranscriptCore } from '../app/botTranscriptCore.ts';

const SESSION = 'bot-session';
const message = (sequence, turnId, text = `m${sequence}`) => ({
  sequence,
  messageId: `id${sequence}`,
  index: 0,
  text,
  at: 0,
  turnId,
});
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/** A Host whose outbox pages can be held back or made to fail, and which can announce changes. */
function host({ messages = [], hold = false, fail = false, pageSize = 100 } = {}) {
  const state = { messages, hold, fail, releases: [], waiting: [], reads: [] };
  const query = async (_endpoint, _method, input) => {
    const through = state.messages.length;
    if (input.limit === 0) return { sessionId: SESSION, through, messages: [] };
    state.reads.push(input.after ?? 0);
    if (state.hold) await new Promise((resolve) => state.releases.push(resolve));
    if (state.fail) throw new Error('outbox read failed');
    const rest = state.messages.filter((m) => m.sequence > (input.after ?? 0));
    const page = rest.slice(0, pageSize);
    return {
      sessionId: SESSION,
      through,
      messages: page,
      nextAfter: rest.length > page.length ? page[page.length - 1].sequence : null,
    };
  };
  const subscribe = async () => ({
    next: () => new Promise((resolve) => state.waiting.push(resolve)),
    close: async () => {},
  });
  /** The Host announces that the outbox head moved. */
  const announce = () => {
    for (const resolve of state.waiting.splice(0)) resolve({ sessionId: SESSION });
  };
  return { state, announce, host: { query, subscribe } };
}
const replies = (core, id) => core.forTurn(id).map((m) => m.text);

test('replies are grouped by the Turn that sent them and read in order across pages', async () => {
  const { state, host: h } = host({
    messages: [message(1, 'a'), message(2, 'a'), message(3, 'b'), message(4, 'a'), message(5, 'c')],
    pageSize: 2,
  });
  const core = createBotTranscriptCore(h, SESSION, () => {});
  await core.started;
  await settle();
  assert.deepEqual(replies(core, 'a'), ['m1', 'm2', 'm4']);
  assert.deepEqual(replies(core, 'b'), ['m3']);
  assert.deepEqual(replies(core, 'c'), ['m5']);
  assert.deepEqual(replies(core, 'none'), []);
  assert.deepEqual(state.reads, [0, 2, 4], 'each page is read once, in order');
  core.close();
});

test('a reply held behind a page read appears when the read completes', async () => {
  const { state, host: h } = host({ messages: [message(1, 'a')], hold: true });
  const core = createBotTranscriptCore(h, SESSION, () => {});
  await core.started;
  await settle();
  assert.equal(core.isBot(), true);
  assert.deepEqual(replies(core, 'a'), [], 'not yet read');
  state.hold = false;
  for (const release of state.releases) release();
  await settle();
  assert.deepEqual(replies(core, 'a'), ['m1']);
  core.close();
});

test('a failed read recovers on the next change without losing or repeating messages', async () => {
  const { state, announce, host: h } = host({ messages: [message(1, 'a')], fail: true });
  const core = createBotTranscriptCore(h, SESSION, () => {});
  await core.started;
  await settle();
  assert.deepEqual(replies(core, 'a'), []);
  state.fail = false;
  state.messages.push(message(2, 'a'));
  announce();
  await settle();
  assert.deepEqual(replies(core, 'a'), ['m1', 'm2']);
  announce();
  await settle();
  assert.deepEqual(replies(core, 'a'), ['m1', 'm2'], 'a repeated announcement adds nothing');
  core.close();
});

test('new messages are picked up as the head moves', async () => {
  const { state, announce, host: h } = host({ messages: [] });
  const core = createBotTranscriptCore(h, SESSION, () => {});
  await core.started;
  await settle();
  state.messages.push(message(1, 'a'));
  announce();
  await settle();
  state.messages.push(message(2, 'b'));
  announce();
  await settle();
  assert.deepEqual([replies(core, 'a'), replies(core, 'b')], [['m1'], ['m2']]);
  core.close();
});

test('an ordinary Session makes one lookup and never subscribes', async () => {
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
  assert.deepEqual(core.forTurn('a'), []);
  assert.equal(queries, 1);
  assert.equal(subscribed, false);
  core.close();
});

/** A Host whose identity lookup (`limit: 0`) can be held back or made to fail. */
function slowIdentity({ hold = false, failures = 0, bot = SESSION } = {}) {
  const state = { hold, failures, releases: [], lookups: 0, subscribed: false };
  const query = async (_endpoint, _method, input) => {
    if (input.limit === 0) {
      state.lookups += 1;
      if (state.hold) await new Promise((resolve) => state.releases.push(resolve));
      if (state.failures > 0) {
        state.failures -= 1;
        throw new Error('identity lookup failed');
      }
      return { sessionId: bot, through: 0, messages: [] };
    }
    return { sessionId: bot, through: 0, messages: [], nextAfter: null };
  };
  const subscribe = async () => {
    state.subscribed = true;
    return { next: () => new Promise(() => {}), close: async () => {} };
  };
  return { state, host: { query, subscribe } };
}
const noWait = async () => {};

test('identity is unknown, not ordinary, while the lookup is pending', async () => {
  const { state, host: h } = slowIdentity({ hold: true });
  const core = createBotTranscriptCore(h, SESSION, () => {}, noWait);
  await settle();
  assert.equal(core.identity(), 'unknown');
  assert.equal(core.isBot(), false);
  state.hold = false;
  for (const release of state.releases) release();
  await core.started;
  assert.equal(core.identity(), 'bot');
  core.close();
});

test('a failed identity lookup is retried and never decides ordinary', async () => {
  const { state, host: h } = slowIdentity({ failures: 2 });
  const core = createBotTranscriptCore(h, SESSION, () => {}, noWait);
  await core.started;
  assert.equal(core.identity(), 'bot');
  // Two failures, then the successful lookup; the watch then reads the head once more.
  assert.ok(state.lookups >= 3, `retried (${state.lookups} lookups)`);
  core.close();
});

test('identity stays unknown when every lookup fails', async () => {
  const { host: h } = slowIdentity({ failures: 100 });
  const core = createBotTranscriptCore(h, SESSION, () => {}, noWait);
  await core.started;
  assert.equal(core.identity(), 'unknown');
  core.close();
});

test("a Session the Host reports as someone else's Bot is ordinary", async () => {
  const { host: h } = slowIdentity({ bot: 'other-session' });
  const core = createBotTranscriptCore(h, SESSION, () => {}, noWait);
  await core.started;
  assert.equal(core.identity(), 'ordinary');
  core.close();
});

test('an identity the application already knows is used without waiting for the lookup', async () => {
  const { state, host: h } = slowIdentity({ hold: true });
  const asBot = createBotTranscriptCore(
    h,
    SESSION,
    () => {},
    noWait,
    () => SESSION,
  );
  const asOrdinary = createBotTranscriptCore(
    h,
    'ordinary',
    () => {},
    noWait,
    () => SESSION,
  );
  const none = createBotTranscriptCore(
    h,
    SESSION,
    () => {},
    noWait,
    () => null,
  );
  assert.equal(asBot.identity(), 'bot');
  assert.equal(asOrdinary.identity(), 'ordinary');
  assert.equal(none.identity(), 'ordinary');
  assert.equal(state.lookups, 0, 'no lookup is needed');
  for (const core of [asBot, asOrdinary, none]) core.close();
});

test('a later answer from the application settles an unknown identity', async () => {
  const { host: h } = slowIdentity({ failures: 100 });
  let known;
  const core = createBotTranscriptCore(
    h,
    SESSION,
    () => {},
    noWait,
    () => known,
  );
  await core.started;
  assert.equal(core.identity(), 'unknown');
  known = SESSION;
  assert.equal(core.identity(), 'bot');
  core.close();
});

test('a late answer from the application starts the watch after every lookup failed', async () => {
  const { state, host: h } = slowIdentity({ failures: 100 });
  let known;
  const core = createBotTranscriptCore(
    h,
    SESSION,
    () => {},
    noWait,
    () => known,
  );
  await core.started;
  assert.equal(core.identity(), 'unknown');
  const lookups = state.lookups;
  known = SESSION;
  assert.equal(core.identity(), 'bot');
  await settle();
  assert.ok(state.subscribed, 'the outbox is now being watched');
  assert.ok(state.lookups >= lookups, 'no lookup was lost');
  assert.equal(core.identity(), 'bot');
  core.close();
});

test('a finished Turn is told apart by what the user could see', () => {
  const done = { finished: true, outcome: 'completed' };
  assert.equal(botTurnEnding({ ...done, sent: true, slept: true }), 'replied');
  assert.equal(botTurnEnding({ ...done, sent: true, slept: false }), 'replied');
  // Deliberate silence: slept without sending. No marker is needed.
  assert.equal(botTurnEnding({ ...done, sent: false, slept: true }), 'quiet');
  // Neither sent nor slept: the user cannot tell this from silence.
  assert.equal(botTurnEnding({ ...done, sent: false, slept: false }), 'unanswered');
});

test('a running, failed or stopped Turn is never reported as unanswered', () => {
  const quiet = { sent: false, slept: false };
  assert.equal(botTurnEnding({ finished: false, outcome: null, ...quiet }), 'running');
  assert.equal(botTurnEnding({ finished: true, outcome: 'failed', ...quiet }), 'other');
  assert.equal(botTurnEnding({ finished: true, outcome: 'aborted', ...quiet }), 'other');
  assert.equal(botTurnEnding({ finished: true, outcome: null, ...quiet }), 'other');
});
