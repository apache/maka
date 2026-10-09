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

// The Session adapter (session-adapter.mjs) against a fake Host client: what
// Desktop's runtime-host-bot-session-adapter.ts sends and how it reads a Turn.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BotSessionUnavailableError,
  createHostBotSessionAdapter,
  createHostSessionClient,
} from '../session-adapter.mjs';
import { maka } from './support.mjs';

const WORKSPACE = { kind: 'host_path', path: '/work' };

function delta(turnId, messageId, text, extra = {}) {
  return { kind: 'subscription.session_delta', delta: { turnId, kind: 'text', messageId, text, ...extra } };
}

function settled(turnId, status, extra = {}) {
  return {
    kind: 'subscription.session_projection',
    snapshot: { rootTurn: { turnId, status, ...extra } },
  };
}

/** A subscription that yields `frames` once `ready()` was called. */
function fakeSubscription(frames, log) {
  let ready;
  const readied = new Promise((resolve) => {
    ready = resolve;
  });
  return {
    async ready() {
      log.push('ready');
      ready();
    },
    async close() {
      log.push('close');
    },
    async *[Symbol.asyncIterator]() {
      await readied;
      yield* frames;
    },
  };
}

function fakeClient({ frames = [], session = {} } = {}) {
  const log = [];
  const current = { id: 'session-1', permissionMode: 'ask', isArchived: false, revision: 3, ...session };
  return {
    log,
    async getSession(sessionId) {
      log.push(['get', sessionId]);
      return current.id === sessionId ? { ...current } : null;
    },
    async createSession(input) {
      log.push(['create', input]);
      return { ...current, id: input.sessionId };
    },
    async updateSessionConfiguration(sessionId, patch) {
      log.push(['configure', sessionId, patch]);
      Object.assign(current, patch);
      return { ...current };
    },
    async openSession(sessionId) {
      log.push(['open', sessionId]);
      return fakeSubscription(frames, log);
    },
    async startTurn(input) {
      log.push(['start', input]);
      return { kind: 'started' };
    },
  };
}

async function adapter(client) {
  return createHostBotSessionAdapter({
    client,
    maka: await maka(),
    newId: () => 'new-session',
    resolveCreateTarget: async () => ({ workspace: WORKSPACE }),
  });
}

test('a bot Session is created in bot mode with its labels', async () => {
  const client = fakeClient();
  const sessionId = await (await adapter(client)).createSession({
    name: 'Telegram 任务',
    labels: ['bot', 'telegram'],
  });
  assert.equal(sessionId, 'new-session');
  assert.deepEqual(client.log, [
    [
      'create',
      {
        sessionId: 'new-session',
        workspace: WORKSPACE,
        name: 'Telegram 任务',
        labels: ['bot', 'telegram'],
        modelTarget: { kind: 'default' },
        mode: 'bot',
      },
    ],
  ]);
});

test('preparing a reused Session switches it to explore', async () => {
  const client = fakeClient();
  const sessions = await adapter(client);
  assert.equal(await sessions.prepareSession('session-1'), 'ready');
  assert.deepEqual(client.log.at(-1), ['configure', 'session-1', { permissionMode: 'explore' }]);
  // Already in explore: nothing is written.
  client.log.length = 0;
  assert.equal(await sessions.prepareSession('session-1'), 'ready');
  assert.deepEqual(client.log, [['get', 'session-1']]);
  // A Session the Host no longer has is unavailable, so the chat rebinds.
  await assert.rejects(sessions.prepareSession('gone'), BotSessionUnavailableError);
});

test('a Turn streams folded snapshots and ends with the final text', async () => {
  const client = fakeClient({
    frames: [
      delta('other-turn', 'm0', 'ignored'),
      delta('turn-1', 'm1', 'Hel'),
      delta('turn-1', 'm1', 'lo', { startOffset: 3 }),
      // A replayed prefix folds into the same text.
      delta('turn-1', 'm1', 'Hello', { startOffset: 0 }),
      delta('turn-1', 'm1', ' there', { startOffset: 5 }),
      settled('turn-1', 'completed'),
    ],
  });
  const snapshots = [];
  const result = await (await adapter(client)).runTurn({
    sessionId: 'session-1',
    turnId: 'turn-1',
    text: '[Telegram:someone] hi',
    onReplySnapshot: (text) => snapshots.push(text),
  });
  assert.deepEqual(result, { kind: 'completed', text: 'Hello there' });
  assert.deepEqual(snapshots, ['Hel', 'Hello', 'Hello there']);
  // The subscription is ready before the Turn starts, and closed after it.
  const order = client.log.map((entry) => (Array.isArray(entry) ? entry[0] : entry));
  assert.deepEqual(order, ['open', 'ready', 'start', 'close']);
  assert.deepEqual(client.log[2], [
    'start',
    { sessionId: 'session-1', turnId: 'turn-1', content: { text: '[Telegram:someone] hi' } },
  ]);
});

test('a Turn waiting for approval or failing reports it', async () => {
  const waiting = await (await adapter(fakeClient({ frames: [settled('t', 'waiting_for_user')] })))
    .runTurn({ sessionId: 'session-1', turnId: 't', text: 'x' });
  assert.deepEqual(waiting, { kind: 'suspended' });
  const failed = await (
    await adapter(fakeClient({ frames: [settled('t', 'failed', { failureClass: 'provider_error' })] }))
  ).runTurn({ sessionId: 'session-1', turnId: 't', text: 'x' });
  assert.deepEqual(failed, { kind: 'errored', reason: 'provider_error' });
});

test('the Host client retries a configuration update on a stale revision', async () => {
  const requests = [];
  let revision = 1;
  const connection = {
    async request(operation, input) {
      requests.push([operation, input]);
      if (operation === 'session.catalog.query') {
        return { kind: 'session', session: { id: input.sessionId, revision, permissionMode: 'ask' } };
      }
      if (operation === 'session.configuration.update') {
        if (input.expectedRevision < 2) {
          revision = 2;
          return { kind: 'revision_conflict' };
        }
        return { kind: 'committed', session: { id: input.sessionId, revision: 3, permissionMode: 'explore' } };
      }
      throw new Error(`unexpected ${operation}`);
    },
  };
  const client = createHostSessionClient(connection, (await maka()).protocol);
  const session = await client.updateSessionConfiguration('s', { permissionMode: 'explore', name: undefined });
  assert.equal(session.permissionMode, 'explore');
  assert.deepEqual(
    requests.filter(([operation]) => operation === 'session.configuration.update').map(([, input]) => input),
    [
      { sessionId: 's', expectedRevision: 1, patch: { permissionMode: 'explore' } },
      { sessionId: 's', expectedRevision: 2, patch: { permissionMode: 'explore' } },
    ],
  );
});
