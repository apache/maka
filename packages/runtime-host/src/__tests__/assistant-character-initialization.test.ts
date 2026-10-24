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
    enabled = false;
  const visible: any[] = [];
  const posts: any[] = [];
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
    invocation: () => ({ sessionId: owner }),
  };
  const ctx = {
    sessionQuery: { read: async () => ({ id: owner }) },
    petPacks: { status: async () => ({ configured: false }) },
    agents: { withInvocation: (_: any, fn: any) => fn() },
    tools: {
      resolve: () => ({
        tools: [
          {
            name: 'MatterDelegate',
            parameters: z.any(),
            impl: async (input: any) => {
              calls++;
              init.taskCreated(owner!, input.taskKey, 'worker');
              assert.equal(
                init.isWorker('worker'),
                input.taskKey.includes('character'),
                'permission is persisted before scheduling',
              );
              if (fail) throw Error('lost response after creation');
              return { id: 'matter', sessionId: 'worker' };
            },
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
  f.ctx.sessionQuery.read = async () => {
    throw Error('Session Query is not active yet');
  };
  await f.init.tick();
  assert.equal(f.init.state(), undefined);
  assert.deepEqual(f.posts, []);
  f.ctx.sessionQuery.read = async () => ({ id: 'owner' });
  await f.init.tick();
  assert.equal(f.init.state()?.phase, 'offered');
  assert.equal(f.posts.length, 1);
});
