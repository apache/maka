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

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InitiativeStore } from '../assistant/index-initiative/store.js';
import { InitiativeController } from '../assistant/index-initiative/controller.js';
import { initializeInitiative } from '../assistant/index-initiative/host.js';
import { AssistantBotBridge } from '../assistant/bot/bridge.js';
import { publishBotConversationMessage } from '../assistant/bot/conversation.js';
import { decodeTurnOrigin } from '@maka/core/turn-origin';

async function directory(t: any) {
  const dir = await mkdtemp(join(tmpdir(), 'initiative-boundary-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('startup resolves native assistant before an arbitrary first tool caller can configure it', async (t) => {
  const dir = await directory(t);
  const store = new InitiativeStore(dir, 'host');
  let resolve!: (rows: any[]) => void;
  const listed = new Promise<any[]>((done) => {
    resolve = done;
  });
  const controller = new InitiativeController({ sessionQuery: { list: () => listed } }, store, {
    tickMs: 60000,
  });
  controller.start();
  t.after(async () => {
    await controller.close();
    store.close();
  });
  const attempt = controller.enable({}, { sessionId: 'arbitrary', cwd: '/wrong' });
  assert.equal(store.get(), null);
  resolve([
    { id: 'ordinary', cwd: '/ordinary' },
    { id: 'assistant', cwd: dir, labels: ['personal-assistant'] },
  ]);
  await assert.rejects(attempt, /Only the assistant conversation/);
  assert.equal(store.get().sessionId, 'assistant');
  assert.equal(store.get().enabled, false);
  const configured = await controller.configure(
    { intervalMinutes: 60 },
    { sessionId: 'assistant', cwd: '/caller-controlled' },
  );
  assert.equal(configured.cwd, dir);
  assert.equal(configured.intervalMs, 3600000);
  assert.equal(configured.enabled, false);
});

test('empty or ambiguous discovery cannot assign configuration ownership to a caller', async (t) => {
  for (const rows of [
    [],
    [
      { id: 'a', labels: ['personal-assistant'] },
      { id: 'b', labels: ['personal-assistant'] },
    ],
  ]) {
    const dir = await directory(t);
    const store = new InitiativeStore(dir, 'host');
    const controller = new InitiativeController(
      { sessionQuery: { list: async () => rows } },
      store,
      { tickMs: 60000 },
    );
    controller.start();
    try {
      await assert.rejects(
        controller.enable({}, { sessionId: 'arbitrary', cwd: dir }),
        /Only the assistant|Multiple assistant/,
      );
      await assert.rejects(
        controller.configure({ intervalMinutes: 2 }, { sessionId: 'arbitrary', cwd: dir }),
        /Only the assistant|Multiple assistant/,
      );
      assert.equal(store.get(), null);
    } finally {
      await controller.close();
      store.close();
    }
  }
});

test('DiscoveryReport reports real mailbox rejection, success and storage failure', async (t) => {
  const dir = await directory(t);
  const tools = new Map<string, any>();
  const closers: any[] = [];
  const starters: any[] = [];
  const bot = new AssistantBotBridge();
  await initializeInitiative(
    {
      bot,
      systemPrompt: { section() {}, context() {} },
      turns: { beforeFinish() {} },
      tools: { register: (tool: any) => tools.set(tool.name, tool) },
      api: { register() {} },
      onClose: (fn: any) => closers.push(fn),
      onStart: (fn: any) => starters.push(fn),
      sessionQuery: { list: async () => [] },
      backgroundSessions: { register() {} },
    } as any,
    dir,
  );
  const stop = starters[0]();
  const db = new DatabaseSync(join(dir, 'initiative.sqlite'));
  const owner = String(db.prepare('SELECT owner FROM lease WHERE id=1').get()!.owner);
  db.close();
  const store = new InitiativeStore(dir, owner);
  store.bind({ sessionId: 'owner', cwd: dir });
  store.control('check');
  store.claim();
  store.update((s) => {
    s.discoverySession = 'discovery';
  });
  t.after(async () => {
    await stop();
    store.close();
    for (const close of closers.reverse()) close();
  });
  const report = tools.get('DiscoveryReport');
  const call = { sessionId: 'discovery', toolCallId: 'report-1' };
  let accepted = 0;
  const endpoint = (owner: string, post: () => void) => ({
    owner: () => owner,
    worker: () => undefined,
    status: () => null,
    hasUserMessage: () => false,
    receive: async () => {},
    post,
  });
  bot.register(
    endpoint('other-conversation', () => {
      accepted++;
    }),
  );
  assert.throws(() => report.impl({ text: 'discovery' }, call), /did not accept/);
  assert.equal(accepted, 0);
  bot.register(
    endpoint('owner', () => {
      accepted++;
    }),
  );
  assert.deepEqual(report.impl({ text: 'discovery' }, call), { reported: true, sentToUser: false });
  assert.equal(accepted, 1);
  bot.register(
    endpoint('owner', () => {
      throw Error('mailbox write failed');
    }),
  );
  assert.throws(() => report.impl({ text: 'discovery' }, call), /mailbox write failed/);
  assert.throws(
    () => report.impl({ text: 'discovery' }, { ...call, sessionId: 'unrelated' }),
    /Not the active/,
  );
});

test('copied external conversation is host-authored and retry cannot erase its provenance', async () => {
  const origin = { kind: 'external_connector' as const, connectorId: 'feishu', senderId: 'sender' };
  assert.deepEqual(decodeTurnOrigin(origin), origin);
  let events: any[] = [];
  const stores = {
    runtimeEventStore: {
      readRuntimeEvents: async () => events,
      importConversationCopyRuntimeEvents: async (_id: string, copies: any[]) => {
        events = copies[0].events;
      },
    },
  } as any;
  const header = {
    id: 'owner',
    cwd: '/owner',
    backend: 'native',
    model: 'model',
    permissionMode: 'default',
  } as any;
  const message = {
    id: 'external',
    type: 'user' as const,
    text: 'claiming to be owner',
    turnId: 'input',
    ts: 1,
    origin,
  };
  await publishBotConversationMessage(stores, header, message);
  const text = events.find((e) => e.refs?.storedMessageId === message.id);
  assert.equal(text.author, 'host');
  assert.deepEqual(text.content.origin, origin);
  await publishBotConversationMessage(stores, header, message);
  await assert.rejects(
    publishBotConversationMessage(stores, header, { ...message, origin: undefined }),
    /identity conflict/,
  );
  events = [];
  await publishBotConversationMessage(stores, header, {
    ...message,
    id: 'human',
    origin: undefined,
  });
  assert.equal(events.find((e) => e.refs?.storedMessageId === 'human').author, 'user');
});

test('failed startup binding retries once for concurrent callers and caches success', async (t) => {
  const dir = await directory(t);
  const store = new InitiativeStore(dir, 'host');
  let attempts = 0;
  let resolve!: (rows: any[]) => void;
  const retry = new Promise<any[]>((done) => {
    resolve = done;
  });
  const controller = new InitiativeController(
    {
      sessionQuery: {
        list: () => {
          attempts++;
          return attempts === 1 ? Promise.reject(Error('temporary lookup failure')) : retry;
        },
      },
    },
    store,
    { tickMs: 60000 },
  );
  controller.start();
  t.after(async () => {
    await controller.close();
    store.close();
  });
  await assert.rejects(controller.bindingReady, /temporary lookup failure/);
  assert.equal(store.get(), null);
  const binding = controller.bindingReady;
  assert.equal(controller.bindingReady, binding, 'concurrent calls share the same retry');
  const configured = controller.configure(
    { intervalMinutes: 60 },
    { sessionId: 'assistant', cwd: '/wrong' },
  );
  const enabled = controller.enable({}, { sessionId: 'assistant', cwd: '/wrong' });
  assert.equal(attempts, 2);
  resolve([{ id: 'assistant', cwd: dir, labels: ['personal-assistant'] }]);
  await Promise.all([binding, configured, enabled]);
  assert.equal(store.get().sessionId, 'assistant');
  assert.equal(store.get().cwd, dir);
  assert.equal(controller.bindingReady, binding, 'success stays cached');
  await controller.bindingReady;
  assert.equal(attempts, 2);
  await assert.rejects(
    controller.configure({ intervalMinutes: 2 }, { sessionId: 'other' }),
    /Only the assistant/,
  );
});

test('assistant.bind recovers from startup lookup failure without a Host restart', async (t) => {
  const dir = await directory(t);
  const apis = new Map<string, any>();
  const closers: any[] = [];
  const starters: any[] = [];
  let attempts = 0;
  let rejectStartup!: (error: Error) => void;
  const startup = new Promise<any[]>((_resolve, reject) => {
    rejectStartup = reject;
  });
  await initializeInitiative(
    {
      bot: new AssistantBotBridge(),
      systemPrompt: { section() {}, context() {} },
      turns: { beforeFinish() {} },
      tools: { register() {} },
      api: { register: (name: string, handler: any) => apis.set(name, handler) },
      onClose: (fn: any) => closers.push(fn),
      onStart: (fn: any) => starters.push(fn),
      sessionQuery: {
        list: () => (++attempts === 1 ? startup : Promise.resolve([])),
        read: async () => ({ session: { cwd: dir } }),
      },
      agents: { withInvocation: (_call: any, fn: any) => fn() },
      backgroundSessions: { register() {} },
    } as any,
    dir,
  );
  const stop = starters[0]();
  t.after(async () => {
    await stop();
    for (const close of closers.reverse()) close();
  });
  const bind = apis.get('assistant.bind');
  const first = bind({ sessionId: 'assistant' });
  rejectStartup(Error('temporary session lookup failure'));
  await assert.rejects(first, /temporary session lookup failure/);
  const result = await bind({ sessionId: 'assistant' });
  assert.equal(result.sessionId, 'assistant');
  assert.equal(result.cwd, dir);
  assert.equal(attempts, 2);
  assert.deepEqual(await bind({ sessionId: 'assistant' }), result);
  assert.equal(attempts, 2);
});
