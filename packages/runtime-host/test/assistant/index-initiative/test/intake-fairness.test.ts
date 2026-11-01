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
import { intakeFixture } from './intake-fixture.js';
import { QUICK_DISCOVERY_TASK } from '../../../../src/assistant/index-initiative/quick-prompt.js';

const response = (_input: any, action = 'retain') => ({
  text: JSON.stringify(action === 'retain' ? '' : '安排可能有变化'),
});

test('busy threads cannot hide another thread or their own newest reply; every original eventually settles', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  for (let i = 0; i < 400; i++) f.add('noise' + i, '日常闲聊 ' + i + ' 内容'.repeat(25), 'busy');
  f.add('latest', '客户改到明天九点', 'busy');
  f.add('urgent', '明天九点需要陪同复诊', 'family');
  await f.q.intake.collect();
  f.advance();
  let calls = 0;
  f.ctx.llm.generate = async (input: any) => {
    const groups = JSON.parse(input.prompt).events;
    if (!calls++) {
      assert.equal(groups.length, 2);
      assert.ok(
        groups.flatMap((g: any) => g.records).some((e: any) => e.content === '客户改到明天九点'),
      );
      assert.ok(groups.some((g: any) => g.group === 'family'));
    }
    return response(input);
  };
  for (
    let i = 0;
    i < 20 && f.q.intake.status().counts.some((r: any) => r.status === 'pending');
    i++
  ) {
    await f.q.intake.judge();
    f.advance();
  }
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE status='screened'").get()?.n,
    402,
  );
  assert.ok(calls > 1);
  assert.ok(calls < 20);
});
test('a failed group backs off while other groups continue and retries survive restart', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  for (let i = 0; i < 10; i++) f.add('e' + i, 'message', 'thread' + i);
  await f.q.intake.collect();
  f.advance();
  let failed: string[] = [];
  f.ctx.llm.generate = async (input: any) => {
    failed = JSON.parse(input.prompt).events.map((g: any) => g.group);
    throw Error('offline');
  };
  await assert.rejects(f.q.intake.judge(), /offline/);
  await f.restart();
  f.ctx.llm.generate = async (input: any) => {
    assert.ok(JSON.parse(input.prompt).events.every((g: any) => !failed.includes(g.group)));
    return response(input);
  };
  await f.q.intake.judge();
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE status='screened'").get()?.n,
    2,
  );
  f.advance(31000);
  f.ctx.llm.generate = async (input: any) => response(input);
  await f.q.intake.judge();
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE status='screened'").get()?.n,
    10,
  );
});
test('screening reads only current event bodies, never owner history, indexes or task context', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const forbidden = async () => {
    throw Error('screening must not read global context');
  };
  f.ctx.sessionQuery.read = forbidden;
  f.ctx.memoryContext = { read: forbidden };
  f.ctx.tools = {
    resolve: () => {
      throw Error('screening must not query tasks');
    },
  };
  await f.q.intake.collect();
  f.add('x', '白鹭演示改时间，引用：原定周五下午');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async (input: any) => {
    const p = JSON.parse(input.prompt);
    assert.deepEqual(Object.keys(p).sort(), ['events', 'now']);
    assert.match(p.events[0].records[0].content, /引用：原定周五下午/);
    return response(input, 'investigate');
  };
  await f.q.intake.judge();
  assert.ok(await f.q.intake.next());
});
test('unrelated owner changes do not invalidate screening or requeue already screened inputs', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('x', '白鹭演示明天九点');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async (input: any) => {
    f.messages.push({ type: 'user', text: '新的聊天要求' });
    return response(input);
  };
  await f.q.intake.judge();
  await f.q.intake.collect();
  assert.equal(f.q.intake.status().counts[0].status, 'screened');
});
test('first event installs the discovery instructions and never postpones the periodic deadline', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('x');
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  await f.q.dispatch();
  await f.q.running;
  assert.ok(f.prompts[0].includes(QUICK_DISCOVERY_TASK));
  assert.equal(f.q.state().lastPeriodicFinishedAt, undefined);
  f.q.store.update((s: any) => {
    s.idleMs = 1000;
    s.intervalMs = 1000;
  });
  f.advance(2000);
  f.add('unscreened', '新的客户安排');
  await f.q.intake.collect();
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.prompts.length, 2);
  assert.match(f.prompts[1], /全局信息探索/);
  assert.doesNotMatch(f.prompts[1], /新的客户安排/);
  assert.ok(f.q.state().lastPeriodicFinishedAt);
});

test('screening more records cannot back off an already approved investigation in the same thread', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('ready', '客户改期');
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  f.add('later', '其他讨论');
  await f.q.intake.collect();
  f.advance();
  let release: any;
  f.ctx.llm.generate = async (input: any) => {
    await new Promise((r) => {
      release = r;
    });
    return response(input);
  };
  const screening = f.q.intake.judge();
  while (!release) await new Promise((r) => setTimeout(r, 1));
  try {
    assert.ok(await f.q.intake.next());
  } finally {
    release();
    await screening;
  }
});

test('ongoing investigation does not inflate the screening prompt', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.q.store.update((s: any) => {
    s.active = {
      eventWake: {
        id: 'active',
        events: [
          {
            source: 'mail',
            group: 'earlier',
            reason: 'time conflict',
            content: 'x'.repeat(100000),
          },
        ],
        context: { older: 'y'.repeat(100000) },
      },
    };
  });
  f.add('new', '别的消息', 'new-thread');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async (input: any) => {
    assert.equal(JSON.parse(input.prompt).context, undefined);
    assert.ok(input.prompt.length < 1000);
    return response(input);
  };
  await f.q.intake.judge();
});

test('a batch reserves room for each eligible thread instead of filling its budget from the first chats', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  for (let g = 0; g < 6; g++)
    for (let i = 0; i < 50; i++) f.add(`noise-${g}-${i}`, '群聊'.repeat(100), 'group' + g);
  f.add('critical', '客户临时改时间', 'group6');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async (input: any) => {
    const groups = JSON.parse(input.prompt).events;
    assert.equal(groups.length, 7);
    assert.ok(groups.some((g: any) => g.records.some((e: any) => e.content === '客户临时改时间')));
    return response(input);
  };
  await f.q.intake.judge();
});

test('screening packs all short messages without repeating opaque receipt and locator metadata', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  for (let i = 0; i < 301; i++) {
    f.add('id-' + i, '聊天内容' + i, 'room' + (i % 7));
    f.feed.at(-1).object.title = '日常消息';
    f.feed.at(-1).object.locator.opaque = 'opaque-routing-' + 'x'.repeat(2000);
  }
  await f.q.intake.collect();
  f.advance();
  let calls = 0;
  f.ctx.llm.generate = async (input: any) => {
    calls++;
    const p = JSON.parse(input.prompt);
    assert.equal(p.events.flatMap((g: any) => g.records).length, 301);
    assert.ok(p.events.flatMap((g: any) => g.records).every((r: any) => !('id' in r)));
    assert.doesNotMatch(input.prompt, /opaque-routing/);
    assert.ok(input.prompt.length < 40000);
    assert.ok(
      p.events
        .flatMap((g: any) => g.records)
        .every((e: any) => e.kind === 'message' && e.title === '日常消息'),
    );
    return response(input);
  };
  await f.q.intake.judge();
  assert.equal(calls, 1);
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE status='screened'").get()?.n,
    301,
  );
  assert.match(
    String(f.q.store.db.prepare('SELECT payload FROM intake_events LIMIT 1').get()?.payload),
    /opaque-routing/,
  );
});
test('queued investigations are not repeated as background, and remain authorization checked', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('approved', '演示改期', 'docs');
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  f.add('later', '演示群新消息', 'chat');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async (input: any) => {
    assert.doesNotMatch(input.prompt, /演示改期|related change/);
    return response(input);
  };
  await f.q.intake.judge();
  f.ctx.sources.authorize = async (_source: string, objects: any[]) =>
    objects.filter((o) => o.id !== 'approved').map((o) => o.id);
  assert.equal(await f.q.intake.next(), undefined);
});
test('successful screening dispatches without waiting for another periodic tick', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('ready');
  await f.q.intake.collect();
  f.advance();
  let wakes = 0;
  f.q.tick = async () => {
    wakes++;
  };
  await f.q.intake.tick();
  assert.equal(wakes, 1);
  await f.q.intake.tick();
  assert.equal(wakes, 1);
});

test('unused group allocation is reused without postponing another readable group', async (t) => {
  const f = await intakeFixture();
  f.ctx.llm.budget = async () => ({
    modelId: 'large-fixture',
    maxInputTokens: 128000,
    maxOutputTokens: 2048,
  });
  t.after(() => f.close());
  await f.q.intake.collect();
  for (let g = 0; g < 5; g++)
    for (let i = 0; i < 60; i++) f.add(`n-${g}-${i}`, '信息'.repeat(50) + i, 'g' + g);
  f.add('small-1', '消息', 'g5');
  f.add('small-2', '关键新消息', 'g6');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async (input: any) => {
    const groups = JSON.parse(input.prompt).events;
    assert.equal(groups.length, 7);
    assert.equal(groups.flatMap((g: any) => g.records).length, 302);
    return response(input);
  };
  await f.q.intake.judge();
});
