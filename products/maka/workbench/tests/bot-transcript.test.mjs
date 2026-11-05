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
import {
  botTurnEnding,
  createBotTranscriptCore,
  reportedWorker,
  activeWorkers,
  assembleChildren,
} from '../app/botTranscriptCore.ts';

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
function host({
  messages = [],
  hold = false,
  fail = false,
  pageSize = 100,
  current = SESSION,
  former = [],
} = {}) {
  const state = { messages, hold, fail, releases: [], waiting: [], reads: [], subscribed: 0 };
  const query = async (_endpoint, _method, input) => {
    // The Host reports the current Bot, and whether the asked Session is or was a Bot.
    const asked = input.sessionId ?? current;
    const isBot = asked === current || former.includes(asked);
    const through = isBot ? state.messages.length : 0;
    if (input.limit === 0) return { sessionId: current, isBot, through, messages: [] };
    state.reads.push(input.after ?? 0);
    if (state.hold) await new Promise((resolve) => state.releases.push(resolve));
    if (state.fail) throw new Error('outbox read failed');
    const rest = isBot ? state.messages.filter((m) => m.sequence > (input.after ?? 0)) : [];
    const page = rest.slice(0, pageSize);
    return {
      sessionId: current,
      isBot,
      through,
      messages: page,
      nextAfter: rest.length > page.length ? page[page.length - 1].sequence : null,
    };
  };
  const subscribe = async () => (
    state.subscribed++,
    {
      next: () => new Promise((resolve) => state.waiting.push(resolve)),
      close: async () => {},
    }
  );
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
      return { sessionId: bot, isBot: (input.sessionId ?? bot) === bot, through: 0, messages: [] };
    }
    return {
      sessionId: bot,
      isBot: (input.sessionId ?? bot) === bot,
      through: 0,
      messages: [],
      nextAfter: null,
    };
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

test('the current Bot is known without a lookup; any other Session is asked about', async () => {
  const { state, host: h } = slowIdentity({ hold: true });
  const asBot = createBotTranscriptCore(
    h,
    SESSION,
    () => {},
    noWait,
    () => SESSION,
  );
  assert.equal(asBot.identity(), 'bot');
  assert.equal(state.lookups, 0, 'no lookup is needed for the current Bot');
  // Another Session may be a Bot that was replaced, so it stays unknown until answered.
  const other = createBotTranscriptCore(
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
  assert.equal(other.identity(), 'unknown');
  assert.equal(none.identity(), 'unknown');
  state.hold = false;
  for (const release of state.releases) release();
  await other.started;
  await none.started;
  assert.equal(other.identity(), 'ordinary');
  assert.equal(none.identity(), 'bot');
  for (const core of [asBot, other, none]) core.close();
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
  known = SESSION;
  assert.equal(core.identity(), 'bot');
  await settle();
  assert.ok(state.subscribed, 'the outbox is now being watched');
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

test('bot outbox watch reconnects across service observation cancellation and catches up', async () => {
  const state = { messages: [message(1, 't1', 'hello')], waiting: [], subscriptions: 0 };
  const h = {
    query: async (_endpoint, _method, input) => {
      const through = state.messages.length;
      if (input.limit === 0) return { sessionId: SESSION, isBot: true, through, messages: [] };
      const rest = state.messages.filter((m) => m.sequence > (input.after ?? 0));
      return { sessionId: SESSION, isBot: true, through, messages: rest, nextAfter: null };
    },
    subscribe: async () => {
      state.subscriptions += 1;
      return {
        next: () => new Promise((resolve, reject) => state.waiting.push({ resolve, reject })),
        close: async () => {},
      };
    },
  };
  const core = createBotTranscriptCore(
    h,
    SESSION,
    () => {},
    () => Promise.resolve(),
  );
  await core.started;
  await settle();
  assert.deepEqual(replies(core, 't1'), ['hello']);
  assert.equal(state.subscriptions, 1);

  state.messages.push(message(2, 't1', 'after-rebind'));
  for (const waiter of state.waiting.splice(0)) {
    waiter.reject(new Error('bot_observation_cancelled'));
  }
  await settle();
  assert.equal(state.subscriptions, 2);
  assert.deepEqual(replies(core, 't1'), ['hello', 'after-rebind']);
  core.close();
});

test('a running, failed or stopped Turn is never reported as unanswered', () => {
  const quiet = { sent: false, slept: false };
  assert.equal(botTurnEnding({ finished: false, outcome: null, ...quiet }), 'running');
  assert.equal(botTurnEnding({ finished: true, outcome: 'failed', ...quiet }), 'other');
  assert.equal(botTurnEnding({ finished: true, outcome: 'aborted', ...quiet }), 'other');
  assert.equal(botTurnEnding({ finished: true, outcome: null, ...quiet }), 'other');
});

test('a replaced Bot still reads as a Bot with its replies, and is not watched', async () => {
  const { state, host: h } = host({
    messages: [message(1, 'a'), message(2, 'b')],
    current: 'newer-bot',
    former: [SESSION],
  });
  const core = createBotTranscriptCore(
    h,
    SESSION,
    () => {},
    undefined,
    () => 'newer-bot',
  );
  await core.started;
  await settle();
  assert.equal(core.identity(), 'bot');
  assert.deepEqual(replies(core, 'a'), ['m1']);
  assert.deepEqual(replies(core, 'b'), ['m2']);
  assert.equal(state.subscribed, 0, 'only the current Bot is watched');
  core.close();
});

test('an ordinary Session is asked about once and is not a Bot', async () => {
  const { state, host: h } = host({ messages: [message(1, 'a')], current: 'the-bot' });
  const core = createBotTranscriptCore(
    h,
    SESSION,
    () => {},
    undefined,
    () => 'the-bot',
  );
  await core.started;
  await settle();
  assert.equal(core.identity(), 'ordinary');
  assert.deepEqual(replies(core, 'a'), []);
  assert.equal(state.subscribed, 0);
  core.close();
});

test('a Bot Turn started by a worker finishing reports that worker; other Turns report none', () => {
  const rows = [
    { turnId: 't1', origin: { kind: 'bot_worker', sessionId: 'worker-a' } },
    { turnId: 't2' },
    { turnId: 't3', origin: { kind: 'plan', executionId: 'x' } },
    { turnId: 't4', origin: { kind: 'bot_worker', sessionId: 'worker-b' } },
  ];
  assert.equal(reportedWorker(rows, 't1'), 'worker-a');
  assert.equal(reportedWorker(rows, 't2'), undefined, 'a user Turn reports no worker');
  assert.equal(reportedWorker(rows, 't3'), undefined, 'another origin is not a worker');
  assert.equal(reportedWorker(rows, 't4'), 'worker-b');
  assert.equal(reportedWorker(rows, 'missing'), undefined);
});

test('the Bot’s running and waiting conversations are listed, waiting first', () => {
  const session = (id, extra = {}) => ({
    id,
    title: `title ${id}`,
    parentSessionId: 'bot',
    activity: 'idle',
    archived: false,
    ...extra,
  });
  const sessions = [
    session('busy-worker', { activity: 'working' }),
    session('idle-worker'),
    session('waiting-worker', { activity: 'waiting' }),
    session('archived-worker', { activity: 'waiting', archived: true }),
    session('someone-elses', { activity: 'waiting', parentSessionId: 'other' }),
    session('ordinary', { activity: 'waiting', parentSessionId: null }),
  ];
  assert.deepEqual(activeWorkers(sessions, 'bot'), [
    { id: 'waiting-worker', title: 'title waiting-worker', activity: 'waiting' },
    { id: 'busy-worker', title: 'title busy-worker', activity: 'working' },
  ]);
  assert.deepEqual(activeWorkers(sessions, null), [], 'no Bot, no workers');
  assert.deepEqual(activeWorkers(sessions, undefined), []);
});

test('a worker behind a full first page of idle ones is still found by following the cursor', async () => {
  const idle = (n) =>
    Array.from({ length: 32 }, (_, i) => ({ id: `idle-${n}-${i}`, activity: 'idle' }));
  const pages = [
    { revision: 'r1', after: 'c1', sessions: idle(1) },
    { revision: 'r1', after: 'c2', sessions: idle(2) },
    { revision: 'r1', after: null, sessions: [{ id: 'old-waiting', activity: 'waiting' }] },
  ];
  const reads = [];
  const all = await assembleChildren(pages[0], async (previous) => {
    reads.push(previous.after);
    return pages[reads.length];
  });
  assert.deepEqual(reads, ['c1', 'c2']);
  assert.equal(all.length, 65);
  assert.ok(all.some((session) => session.id === 'old-waiting'));
});

test('a catalog that moves while its pages are read is refused, and a stuck cursor ends the read', async () => {
  const first = { revision: 'r1', after: 'c1', sessions: [{ id: 'a' }] };
  await assert.rejects(
    assembleChildren(first, async () => ({ revision: 'r2', after: null, sessions: [] })),
    /agent_catalog_changed/,
  );
  const stuck = await assembleChildren(first, async () => ({
    revision: 'r1',
    after: 'c1',
    sessions: [{ id: 'b' }],
  }));
  assert.deepEqual(
    stuck.map((session) => session.id),
    ['a'],
    'a page that does not advance is not added and ends the read',
  );
});
