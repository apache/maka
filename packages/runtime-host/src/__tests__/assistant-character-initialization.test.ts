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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CharacterPack } from '../assistant/bot/character-pack.js';
import {
  CharacterInitialization,
  CHARACTER_INITIALIZATION_REQUEST,
} from '../assistant/bot/character-initialization.js';
import { BotStore } from '../assistant/bot/store.js';

function fixture(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'character-init-'));
  const store = new BotStore(root),
    pack = new CharacterPack(root);
  let owner: string | undefined = 'owner';
  let calls = 0,
    fail = false,
    enabled = false,
    matterStatus = 'active';
  const visible: any[] = [];
  const posts: any[] = [];
  const invocation = new AsyncLocalStorage<{ sessionId: string }>();
  const bot = {
    owner: () => owner,
    ready() {},
    async flush() {
      for (const message of store.pendingVisible()) {
        visible.push(message);
        store.delivered(message.id);
      }
    },
    abort: new AbortController(),
    post: (input: any) => posts.push(input),
    invocation: (sessionId = owner) => ({ sessionId }),
  };
  const ctx = {
    sessionQuery: {
      list: async () => (invocation.getStore()?.sessionId === owner ? [{ id: owner }] : []),
    },
    petPacks: { status: async () => ({ configured: false }) },
    agents: { withInvocation: (call: any, fn: any) => invocation.run(call, fn) },
    tools: {
      resolve: () => ({
        tools: [
          {
            name: 'MatterDelegate',
            parameters: z.object({
              taskKey: z.string(),
              title: z.string(),
              request: z.string().trim().min(1).max(8000),
            }),
            impl: async (input: any) => {
              calls++;
              init.taskCreated(owner!, input.taskKey, 'worker');
              assert.equal(
                init.isWorker('worker'),
                input.taskKey.includes('character'),
                'permission is persisted before scheduling',
              );
              if (fail) throw Error('lost response after creation');
              return { id: 'matter', sessionId: 'worker', status: matterStatus };
            },
          },
          {
            name: 'MatterTasks',
            parameters: z.object({ id: z.string().optional() }),
            impl: async (input: any) => ({ id: input.id, status: matterStatus }),
          },
        ],
      }),
    },
  };
  let init = new CharacterInitialization(ctx as any, bot as any, store, pack, () => enabled);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    bot,
    ctx,
    store,
    pack,
    posts,
    visible,
    setDiscovery: (value: boolean) => (enabled = value),
    calls: () => calls,
    setOwner: (id?: string) => (owner = id),
    fail: (value: boolean) => (fail = value),
    setMatterStatus: (value: string) => (matterStatus = value),
    get init() {
      return init;
    },
    restart: () => {
      init = new CharacterInitialization(
        ctx as any,
        bot as any,
        store,
        new CharacterPack(root),
        () => enabled,
      );
    },
  };
}

test('startup asks first, persists the offer across restart, and starts only after user choice', async (t) => {
  const f = fixture(t);
  assert.equal(f.pack.readDocument('persona').content, '');
  f.setOwner(undefined);
  await f.init.tick();
  assert.equal(f.calls(), 0);
  f.setOwner('owner');
  await Promise.all([f.init.tick(), f.init.tick(), f.init.tick()]);
  assert.equal(f.calls(), 0);
  assert.equal(f.posts.length, 1);
  f.restart();
  await f.init.tick();
  assert.equal(f.posts.length, 1);
  await f.init.setup({ kind: 'assistant', action: 'create', preferences: '随机有趣' });
  assert.equal(f.calls(), 1);
  f.restart();
  await f.init.tick();
  assert.equal(f.calls(), 1);
  assert.equal(f.init.isWorker('other'), false);
  assert.equal(f.init.isWorker('worker'), true);
  assert.deepEqual(
    f.visible.map((message) => message.text),
    ['我在配置我自己，稍等一下。'],
  );
  assert.match(
    CHARACTER_INITIALIZATION_REQUEST,
    /先用 AssistantCharacterPack.*再通过可访问的历史、索引/,
  );
  assert.match(CHARACTER_INITIALIZATION_REQUEST, /找不到，就上网了解当下热梗/);
  assert.match(CHARACTER_INITIALIZATION_REQUEST, /有话题度/);
});

test('existing customized persona is preserved and never schedules a new initializer', async (t) => {
  const f = fixture(t);
  f.pack.writeDocument('persona', '# 用户选的人设', f.pack.readDocument('persona').revision);
  await f.init.tick();
  assert.equal(f.calls(), 0);
  assert.equal(f.init.state()?.adopted, true);
  assert.equal(f.visible.length, 0);
  assert.equal(f.pack.readDocument('persona').content, '# 用户选的人设');
});

test('a fenced Host does not mutate initialization or publish a failure during handoff', async (t) => {
  const f = fixture(t);
  f.bot.ready = () => {
    throw Error('Initiative ownership changed');
  };
  await f.init.tick();
  assert.equal(f.calls(), 0);
  assert.equal(f.init.state(), undefined);
  assert.equal(f.posts.length, 0);
});

test('ambiguous delegation retries its saved identity and request after restart; no retry storm', async (t) => {
  const f = fixture(t);
  f.fail(true);
  await f.init.setup({ kind: 'assistant', action: 'create', preferences: '茶摊' });
  const before = f.init.state()!;
  assert.equal(before.worker, 'worker');
  assert.match(before.error!, /lost response/);
  assert.equal(f.posts.length, 1);
  await f.init.tick();
  assert.equal(f.calls(), 1);
  f.restart();
  f.fail(false);
  f.store.set('characterInitialization', { ...before, retryAt: 0 });
  await f.init.tick();
  assert.equal(f.init.state()?.taskKey, before.taskKey);
  assert.equal(f.init.state()?.request, before.request);
  assert.equal(f.init.state()?.worker, before.worker);
  assert.equal(f.init.state()?.phase, 'running');
  assert.equal(f.visible.length, 1, 'ambiguous delegation must not repeat the opening message');
});

for (const user of [false, true])
  test(`completion is durable and feedback retries preserve greeting mode (${user})`, async (t) => {
    const f = fixture(t);
    await f.init.setup({ kind: 'assistant', action: 'create', preferences: '茶摊' });
    assert.throws(() => f.init.prepare('other'), /Only/);
    assert.throws(() => f.init.prepare('worker'), /persona/);
    f.pack.writeDocument('persona', '# 月球茶摊', f.pack.readDocument('persona').revision);
    assert.throws(() => f.init.prepare('worker'), /avatar/);
    f.store.set('avatar', { emoji: '🫖' });
    f.init.prepare('worker');
    const feedback = {
      id: 'finished',
      type: 'task_update' as const,
      source: 'worker',
      content: { status: 'completed' },
    };
    if (user)
      f.store.post({
        id: 'hello',
        type: 'user_message',
        source: 'user',
        content: { text: '你好' },
      });
    const input = f.init.feedback(feedback);
    assert.equal((input.content as any).introduction, user ? 'explain_change' : 'introduce');
    f.store.post(input);
    f.init.delivered(feedback);
    f.restart();
    assert.deepEqual(f.init.feedback(feedback), input);
    f.store.post(f.init.feedback(feedback));
    assert.equal(f.store.head(), user ? 2 : 1);
    await f.init.tick();
    assert.equal(f.calls(), 1);
    assert.equal(f.init.isWorker('worker'), false);
  });

for (const enabled of [false, true])
  test(`onboarding uses the actual discovery setting and saved sticker availability (${enabled})`, async (t) => {
    const f = fixture(t);
    f.setDiscovery(enabled);
    await f.init.setup({ kind: 'assistant', action: 'create', preferences: '橘子' });
    f.pack.writeDocument('persona', '# 阿橘', f.pack.readDocument('persona').revision);
    f.store.set('avatar', { emoji: '🍊' });
    if (enabled) {
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUNsAAAAASUVORK5CYII=',
        'base64',
      );
      f.pack.addImage({ title: '打招呼', kind: 'sticker', usage: '你好' }, png);
    }
    f.init.prepare('worker');
    const event = {
      id: 'complete',
      source: 'worker',
      type: 'task_update' as const,
      content: { status: 'completed' },
    };
    const first = f.init.feedback(event);
    const prompt = (first.content as any).characterIntroduction;
    if (enabled) {
      assert.match(prompt, /主动发现目前已开启/);
      assert.match(prompt, /token/);
      assert.match(prompt, /AssistantStickerSearch.*SendUser/);
    } else {
      assert.match(prompt, /主动发现目前未开启/);
      assert.match(prompt, /可以开启体验/);
      assert.doesNotMatch(prompt, /运行频率较高/);
      assert.match(prompt, /没有表情包/);
    }
    f.store.post(first);
    f.init.delivered(event);
    f.setDiscovery(!enabled);
    f.restart();
    assert.deepEqual(f.init.feedback(event), first, 'retry keeps the already posted envelope');
  });

test('assistant and pet opt-outs are separate and persisted; explicit pet consent starts one task', async (t) => {
  const f = fixture(t);
  await f.init.tick();
  assert.equal(f.posts.length, 1);
  assert.equal(f.posts[0].content.kind, 'assistant');
  await f.init.setup({ kind: 'assistant', action: 'skip' });
  assert.equal(f.posts.at(-1).content.kind, 'pet');
  assert.equal(f.calls(), 0);
  await f.init.setup({ kind: 'pet', action: 'skip' });
  f.restart();
  await f.init.tick();
  assert.equal(f.posts.length, 2);
  await f.init.setup({ kind: 'pet', action: 'create', preferences: '布偶猫，与助手无关' });
  assert.equal(f.calls(), 1);
  await f.init.setup({ kind: 'pet', action: 'create', preferences: '布偶猫' });
  assert.equal(f.calls(), 1);
  assert.equal(f.store.get<any>('petInitialization').phase, 'running');
  assert.equal(f.pack.hasPersona(), false);
});

test('matching pet receives the existing persona as reference without changing the character pack', async (t) => {
  const f = fixture(t);
  const persona = '# 月球茶摊老板';
  f.pack.writeDocument('persona', persona, f.pack.readDocument('persona').revision);
  await f.init.tick();
  await f.init.setup({ kind: 'pet', action: 'create', preferences: '和助手一样' });
  assert.match(f.store.get<any>('petInitialization').request, /月球茶摊老板/);
  assert.equal(f.pack.readDocument('persona').content, persona);
});

test('onboarding waits for the owner query boundary before posting an offer', async (t) => {
  const f = fixture(t);
  f.ctx.sessionQuery.list = async () => {
    throw Error('Session Query is not active yet');
  };
  await f.init.tick();
  assert.equal(f.init.state(), undefined);
  assert.deepEqual(f.posts, []);
  f.ctx.sessionQuery.list = async () => [{ id: 'owner' }];
  await f.init.tick();
  assert.equal(f.init.state()?.phase, 'offered');
  assert.equal(f.posts.length, 1);
});

test('timer onboarding scopes both offers to the owner without reading conversation history', async (t) => {
  const f = fixture(t);
  assert.deepEqual(await f.ctx.sessionQuery.list(), [], 'unscoped timers cannot see sessions');
  await f.init.tick();
  assert.equal(f.init.state()?.phase, 'offered');
  assert.equal(f.posts[0].content.kind, 'assistant');
  await f.init.setup({ kind: 'assistant', action: 'skip' });
  assert.equal(f.posts[1].content.kind, 'pet');
  f.restart();
  await f.init.tick();
  assert.equal(f.posts.length, 2, 'restarting does not duplicate either offer');
  assert.equal(f.calls(), 0, 'offers do not create appearance tasks without consent');
});

test('pet delegation budgets the complete escaped persona and maximum preferences', async (t) => {
  const f = fixture(t);
  f.pack.writeDocument('persona', '猫"\\'.repeat(4915), f.pack.readDocument('persona').revision);
  const preferences = '独立的布偶猫'.repeat(667).slice(0, 4000);
  await f.init.setup({ kind: 'pet', action: 'create', preferences });
  const state = f.store.get<any>('petInitialization');
  assert.equal(state.phase, 'running');
  assert.ok(state.request.length <= 8000);
  assert.ok(state.request.includes(preferences));
  assert.equal(f.pack.readDocument('persona').content, '猫"\\'.repeat(4915));
});

test('an old invalid unadmitted request can be skipped or replaced instead of retrying forever', async (t) => {
  const f = fixture(t);
  f.store.set('characterInitialization', { phase: 'skipped', owner: 'owner' });
  f.store.set('petInitialization', {
    phase: 'starting',
    owner: 'owner',
    taskKey: 'assistant-pet-initialization-v1',
    request: 'x'.repeat(8100),
  });
  await f.init.tick();
  assert.notEqual(f.store.get<any>('petInitialization').phase, 'starting');
  await f.init.setup({ kind: 'pet', action: 'skip' });
  assert.equal(f.store.get<any>('petInitialization').phase, 'skipped');
});

test('a completed settlement without finish_initialization adopts an existing persona', async (t) => {
  const f = fixture(t);
  await f.init.setup({ kind: 'assistant', action: 'create', preferences: '茶摊' });
  assert.equal(f.init.state()?.phase, 'running');
  f.pack.writeDocument('persona', '# 月球茶摊', f.pack.readDocument('persona').revision);
  f.init.delivered({
    id: 'settled',
    type: 'task_update',
    source: 'worker',
    content: { status: 'completed' },
  });
  assert.equal(f.init.state()?.phase, 'completed');
  assert.equal(f.init.state()?.adopted, true);
  assert.equal(f.init.isWorker('worker'), false);
});

test('a completed settlement without a persona reopens setup instead of sticking in running', async (t) => {
  const f = fixture(t);
  await f.init.setup({ kind: 'assistant', action: 'create', preferences: '茶摊' });
  f.init.delivered({
    id: 'settled',
    type: 'task_update',
    source: 'worker',
    content: { status: 'completed' },
  });
  assert.equal(f.init.state()?.phase, 'offered');
  assert.match(f.init.state()!.error!, /已结束/);
  await f.init.setup({ kind: 'assistant', action: 'skip' });
  assert.equal(f.init.state()?.phase, 'skipped');
});

test('setup skip is honored while the initialization task is running', async (t) => {
  const f = fixture(t);
  await f.init.setup({ kind: 'assistant', action: 'create', preferences: '茶摊' });
  assert.equal(f.init.state()?.phase, 'running');
  await f.init.setup({ kind: 'assistant', action: 'skip' });
  assert.equal(f.init.state()?.phase, 'skipped');
});

test('the periodic tick retires a running phase whose Matter was cancelled or settled silently', async (t) => {
  const f = fixture(t);
  f.setMatterStatus('active');
  await f.init.setup({ kind: 'assistant', action: 'create', preferences: '茶摊' });
  assert.equal(f.init.state()?.phase, 'running');
  f.setMatterStatus('cancelled');
  await f.init.tick();
  assert.equal(f.init.state()?.phase, 'offered');
  f.setMatterStatus('active');
  await f.init.setup({ kind: 'assistant', action: 'create', preferences: '橘子' });
  assert.equal(f.init.state()?.phase, 'running');
  f.setMatterStatus('completed');
  f.pack.writeDocument('persona', '# 阿橘', f.pack.readDocument('persona').revision);
  await f.init.tick();
  assert.equal(f.init.state()?.phase, 'completed');
  assert.equal(f.init.state()?.adopted, true);
});

test('a cancelled pet Matter retires the running pet phase', async (t) => {
  const f = fixture(t);
  f.setMatterStatus('active');
  await f.init.setup({ kind: 'assistant', action: 'skip' });
  await f.init.setup({ kind: 'pet', action: 'create', preferences: '布偶猫' });
  assert.equal(f.store.get<any>('petInitialization').phase, 'running');
  f.setMatterStatus('cancelled');
  await f.init.tick();
  assert.equal(f.store.get<any>('petInitialization').phase, 'offered');
});

test('a settled Matter identity is never resurrected by a repeated create', async (t) => {
  const f = fixture(t);
  f.setMatterStatus('active');
  await f.init.setup({ kind: 'assistant', action: 'create', preferences: '茶摊' });
  assert.equal(f.init.state()?.phase, 'running');
  f.setMatterStatus('completed');
  f.init.delivered({
    id: 'settled',
    type: 'task_update',
    source: 'worker',
    content: { status: 'completed' },
  });
  assert.equal(f.init.state()?.phase, 'offered');
  const before = f.calls();
  await f.init.setup({ kind: 'assistant', action: 'create', preferences: '茶摊' });
  assert.equal(f.init.state()?.phase, 'offered', 'a settled Matter must not re-enter running');
  assert.equal(f.calls(), before + 1);
  assert.match(f.init.state()!.error!, /已结束/);
  assert.ok(
    f.posts.some((post: any) => /已结束/.test(post.content?.message ?? '')),
    'the Bot is told why the retry bounced',
  );
});
