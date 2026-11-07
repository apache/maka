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
import { INTAKE_SYSTEM } from '../../../../src/assistant/index-initiative/intake.js';

async function configure(f: any, patch: any) {
  const idle = f.agent.whenIdle;
  f.agent.whenIdle = async () => {
    f.q.setNext({ key: 'next', ...patch }, 'worker');
  };
  await f.q.control({ action: 'check' });
  await f.q.tick();
  await f.q.running;
  f.agent.whenIdle = idle;
  assert.equal(f.q.state().lastError, null);
}
async function incoming(f: any, id: string, text = id) {
  f.add(id, text);
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
}

test('next is optional, worker-only, idempotent and committed only on successful completion', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  assert.throws(() => f.q.setNext({ key: 'x', screeningPrompt: 'test' }, 'worker'), /active/);
  const at = new Date(f.q.now() + 60000).toISOString();
  f.agent.whenIdle = async () => {
    assert.throws(() => f.q.setNext({ key: 'x', screeningPrompt: 'test' }, 'other'), /active/);
    assert.throws(() => f.q.setNext({ key: 'empty' } as any, 'worker'), /Provide/);
    assert.throws(
      () => f.q.setNext({ key: 'past', nextAt: new Date(f.q.now() - 1).toISOString() }, 'worker'),
      /future/,
    );
    const input = { key: 'plan', nextAt: at, screeningPrompt: '关注需要用户决定的新信息' };
    f.q.setNext(input, 'worker');
    f.q.setNext(input, 'worker');
    assert.throws(
      () => f.q.setNext({ ...input, screeningPrompt: 'changed' }, 'worker'),
      /different content/,
    );
    assert.equal(f.q.state().screeningPrompt, undefined);
    assert.equal(f.q.state().wakeAt, undefined);
    throw Error('connection lost');
  };
  await f.q.control({ action: 'check' });
  await f.q.tick();
  await f.q.running;
  assert.match(f.q.state().lastError, /connection lost/);
  assert.equal(f.q.state().screeningPrompt, undefined);
  await f.restart();
  f.advance(120000);
  f.agent.whenIdle = async () => {
    // A retry after the time passed is still the same accepted submission.
    f.q.setNext({ key: 'plan', nextAt: at, screeningPrompt: '关注需要用户决定的新信息' }, 'worker');
  };
  await f.q.control({ action: 'check' });
  await f.q.tick();
  await f.q.running;
  assert.equal(f.q.state().screeningPrompt, '关注需要用户决定的新信息');
  assert.equal(f.q.state().wakeAt, Date.parse(at));
  assert.equal(f.q.state().screeningRevision, 1);
  f.agent.whenIdle = async () => {};
  await f.q.tick();
  await f.q.running;
  assert.equal(f.q.state().wakeAt, null, 'elapsed timer is admitted after execution ends');
  assert.equal(f.q.state().screeningRevision, 1, 'omission preserves policy');
});

test('custom timer and policy survive restart; event wake does not consume a future timer', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  const at = f.q.now() + 2 * 3600000;
  await configure(f, {
    nextAt: new Date(at).toISOString(),
    screeningPrompt: '关注家庭和工作的重要事项',
  });
  await f.restart();
  f.advance(3600000);
  await f.q.tick();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1, 'custom timer replaces default fallback for this wait');
  f.ctx.llm.generate = async (input: any) => {
    assert.match(input.system, /关注家庭和工作的重要事项/);
    assert.match(input.system, /只返回一个 JSON 字符串/);
    return { text: '"家人需要帮忙"' };
  };
  await incoming(f, 'family');
  await f.q.tick();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 2);
  assert.equal(f.q.state().wakeAt, at);
  assert.match(f.prompts.at(-1)!, /QuickDiscoveryNext/);
  f.advance(at - f.q.now());
  await f.q.tick();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 3);
  assert.equal(f.q.state().wakeAt, null);
  await f.q.tick();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 3);
});

test('timer wakes even when screening says no; due timer and positive screen coalesce', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  await configure(f, { nextAt: new Date(f.q.now() + 60000).toISOString() });
  f.ctx.llm.generate = async () => ({ text: '""' });
  await incoming(f, 'noise');
  await f.q.tick();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  f.advance(60000);
  await f.q.tick();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 2);
  await configure(f, { nextAt: new Date(f.q.now() + 60000).toISOString() });
  f.advance(60000);
  f.ctx.llm.generate = async () => ({ text: '"needs attention"' });
  await incoming(f, 'important');
  await Promise.all([f.q.tick(), f.q.tick()]);
  await f.q.running;
  assert.equal(f.counts().workerCalls, 4);
  assert.equal(await f.q.intake.next(), undefined);
  assert.equal(f.q.state().wakeAt, null);
});

test('reset restores default screening; pause still prevents both wake mechanisms', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  await configure(f, {
    screeningPrompt: 'custom',
    nextAt: new Date(f.q.now() + 60000).toISOString(),
  });
  await configure(f, { screeningPrompt: null, nextAt: null });
  f.ctx.llm.generate = async (input: any) => {
    assert.equal(input.system, INTAKE_SYSTEM);
    return { text: '"attention"' };
  };
  await incoming(f, 'new');
  await f.q.control({ action: 'pause' });
  f.advance(3600000);
  await f.q.tick();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 2);
  assert.equal(
    f.q.store.db.prepare("SELECT count(*) n FROM intake_wakes WHERE status='pending'").get()?.n,
    1,
  );
});

test('policy change invalidates in-flight screening without consuming pending originals', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('one');
  await f.q.intake.collect();
  f.advance();
  let release!: (x: any) => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  f.ctx.llm.generate = async () => {
    started();
    return new Promise((r) => {
      release = r;
    });
  };
  const judging = f.q.intake.judge();
  await ready;
  await configure(f, { screeningPrompt: 'new policy' });
  release({ text: '"old decision"' });
  await judging;
  assert.equal(await f.q.intake.next(), undefined);
  assert.equal(
    f.q.store.db.prepare("SELECT count(*) n FROM intake_events WHERE status='pending'").get()?.n,
    1,
  );
  f.ctx.llm.generate = async (input: any) => {
    assert.match(input.system, /new policy/);
    return { text: '"new decision"' };
  };
  await f.q.intake.judge();
  const wake = await f.q.intake.next();
  assert.ok(wake);
  assert.deepEqual(await f.q.intake.directions(wake!), ['new decision']);
});

test('new policy restarts unfinished long-event context but preserves receipts and originals', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('long', '这是很长的原文。'.repeat(10000));
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.budget = async () => ({ maxInputTokens: 5000, maxOutputTokens: 2048 });
  f.ctx.llm.generate = async () => ({
    text: JSON.stringify({ context: 'old summary', direction: '' }),
  });
  await f.q.intake.judge();
  assert.equal(f.q.store.db.prepare('SELECT count(*) n FROM intake_long_events').get()?.n, 1);
  const cursor = f.q.store.db.prepare('SELECT cursor FROM intake_sources').get()?.cursor;
  await configure(f, { screeningPrompt: 'custom long policy' });
  assert.equal(f.q.store.db.prepare('SELECT count(*) n FROM intake_long_events').get()?.n, 0);
  assert.equal(f.q.store.db.prepare('SELECT cursor FROM intake_sources').get()?.cursor, cursor);
  f.ctx.llm.generate = async (input: any) => {
    assert.match(input.system, /custom long policy/);
    assert.match(input.system, /final=true/);
    const data = JSON.parse(input.prompt);
    assert.equal(data.offsetChars, 0);
    assert.equal(data.earlierContext, '');
    return { text: JSON.stringify({ context: 'new summary', direction: '' }) };
  };
  await f.q.intake.judge();
  assert.equal(await f.q.intake.next(), undefined);
});

test('user cadence configuration after next submission overrides the worker timer', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  f.agent.whenIdle = async () => {
    f.q.setNext({ key: 'next', nextAt: new Date(f.q.now() + 60000).toISOString() }, 'worker');
    await f.q.control({ action: 'configure', intervalMinutes: 30 });
    f.q.setNext({ key: 'policy', screeningPrompt: 'new policy' }, 'worker');
  };
  await f.q.control({ action: 'check' });
  await f.q.tick();
  await f.q.running;
  assert.equal(f.q.state().wakeAt, null);
  assert.equal(f.q.state().intervalMs, 1800000);
});

test('in-flight long-event summaries cannot overwrite a newly selected policy', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('long', 'Long original text. '.repeat(10000));
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.budget = async () => ({ maxInputTokens: 5000, maxOutputTokens: 2048 });
  let release!: (x: any) => void;
  let start!: () => void;
  const started = new Promise<void>((r) => {
    start = r;
  });
  f.ctx.llm.generate = async () => {
    start();
    return new Promise((r) => {
      release = r;
    });
  };
  const call = f.q.intake.judge();
  await started;
  await configure(f, { screeningPrompt: 'revised policy' });
  release({ text: JSON.stringify({ context: 'obsolete summary', direction: '' }) });
  await call;
  assert.equal(f.q.store.db.prepare('SELECT count(*) n FROM intake_long_events').get()?.n, 0);
  assert.equal(
    f.q.store.db.prepare("SELECT count(*) n FROM intake_events WHERE status='pending'").get()?.n,
    1,
  );
});

test('settings and screening progress roll back together if completion commit fails', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const log = f.q.store.log.bind(f.q.store);
  f.q.store.log = (kind: string, payload: any) => {
    if (kind === 'quick-next') throw Error('commit unavailable');
    log(kind, payload);
  };
  f.agent.whenIdle = async () => {
    f.q.setNext({ key: 'policy', screeningPrompt: 'atomic policy' }, 'worker');
  };
  await f.q.control({ action: 'check' });
  await f.q.tick();
  await f.q.running;
  assert.match(f.q.state().lastError, /commit unavailable/);
  assert.equal(f.q.state().screeningPrompt, undefined);
  assert.equal(f.q.state().screeningRevision, undefined);
  f.q.store.log = log;
  await f.q.control({ action: 'check' });
  await f.q.tick();
  await f.q.running;
  assert.equal(f.q.state().screeningPrompt, 'atomic policy');
  assert.equal(f.counts().workerCalls, 1, 'commit retry does not repeat model execution');
});

test('bounded factual background is independent, persistent, replaceable and never truncated', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  await configure(f, { screeningPrompt: '关注用户相关机会' });
  const background = '10月26日白鹭演示已改为15点，用户已知。字体验收通过；主持人尚未确认。';
  await configure(f, { screeningContext: background });
  const stamp = f.q.state().screeningContextUpdatedAt;
  assert.ok(stamp);
  await f.restart();
  f.ctx.llm.generate = async (input: any) => {
    assert.match(input.system, /关注用户相关机会/);
    assert.match(input.system, /未被背景提及的新事情仍正常判断/);
    assert.ok(!input.system.includes(background), 'facts are input data, not policy');
    assert.deepEqual(JSON.parse(input.prompt).screeningContext, {
      text: background,
      updatedAt: stamp,
    });
    return { text: '"爸爸发来新消息"' };
  };
  await incoming(f, 'unrelated', '爸爸：今天能帮忙看看吗？');
  assert.ok(await f.q.intake.next());
  f.agent.whenIdle = async () => {
    const active = JSON.stringify(f.q.state().active.next);
    assert.throws(
      () => f.q.setNext({ key: 'oversized', screeningContext: '中'.repeat(2000) }, 'worker'),
      /exceeds.*2000/,
    );
    assert.equal(JSON.stringify(f.q.state().active.next), active);
    f.q.setNext({ key: 'shorter', screeningContext: '10月26日主持人已确认。' }, 'worker');
    assert.equal(f.q.state().screeningContext, background);
  };
  await f.q.control({ action: 'check' });
  await f.q.tick();
  await f.q.running;
  f.agent.whenIdle = async () => {};
  assert.equal(f.q.state().screeningContext, '10月26日主持人已确认。');
  assert.equal(f.q.state().screeningPrompt, '关注用户相关机会');
  const revision = f.q.state().screeningRevision;
  await configure(f, { screeningContext: '10月26日主持人已确认。' });
  assert.equal(
    f.q.state().screeningRevision,
    revision,
    'identical context does not invalidate screening',
  );
  await configure(f, { screeningContext: null });
  assert.equal(f.q.state().screeningContext, null);
  assert.equal(f.q.state().screeningContextUpdatedAt, null);
  assert.equal(f.q.state().screeningPrompt, '关注用户相关机会');
  f.ctx.llm.generate = async (input: any) => {
    assert.equal(JSON.parse(input.prompt).screeningContext, undefined);
    return { text: '""' };
  };
  await incoming(f, 'after-clear');
});

test('failed run retains background submission for restart without publishing it early', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  f.agent.whenIdle = async () => {
    f.q.setNext(
      { key: 'context', screeningContext: '已告知用户扩展停用；原因尚待确认。' },
      'worker',
    );
    throw Error('offline');
  };
  await f.q.control({ action: 'check' });
  await f.q.tick();
  await f.q.running;
  assert.equal(f.q.state().screeningContext, undefined);
  await f.restart();
  f.agent.whenIdle = async () => {};
  await f.q.control({ action: 'check' });
  await f.q.tick();
  await f.q.running;
  assert.equal(f.q.state().screeningContext, '已告知用户扩展停用；原因尚待确认。');
});

for (const long of [false, true]) {
  test(`background change invalidates ${long ? 'chunked' : 'ordinary'} in-flight screening`, async (t) => {
    const f = await intakeFixture();
    t.after(() => f.close());
    await f.q.intake.collect();
    await configure(f, { screeningContext: '原定上午9点。' });
    f.add('event', long ? '旧消息和后续更正。'.repeat(10000) : '新消息');
    await f.q.intake.collect();
    f.advance();
    f.ctx.llm.budget = async () => ({ maxInputTokens: 6000, maxOutputTokens: 2048 });
    let release!: (x: any) => void;
    let start!: () => void;
    const started = new Promise<void>((r) => {
      start = r;
    });
    f.ctx.llm.generate = async (input: any) => {
      assert.equal(JSON.parse(input.prompt).screeningContext.text, '原定上午9点。');
      start();
      return new Promise((r) => {
        release = r;
      });
    };
    const pending = f.q.intake.judge();
    await started;
    await configure(f, { screeningContext: '客户已更正为下午15点，用户已知。' });
    release({
      text: long ? JSON.stringify({ context: '旧摘要', direction: '旧结论' }) : '"旧结论"',
    });
    await pending;
    assert.equal(await f.q.intake.next(), undefined);
    assert.equal(
      f.q.store.db.prepare("SELECT count(*) n FROM intake_events WHERE status='pending'").get()?.n,
      1,
    );
    assert.equal(f.q.store.db.prepare('SELECT count(*) n FROM intake_long_events').get()?.n, 0);
    f.ctx.llm.generate = async (input: any) => {
      const payload = JSON.parse(input.prompt);
      assert.equal(payload.screeningContext.text, '客户已更正为下午15点，用户已知。');
      if (long) assert.equal(payload.offsetChars, 0);
      return { text: long ? JSON.stringify({ context: '新摘要', direction: '' }) : '""' };
    };
    await f.q.intake.judge();
  });
}

test('background is counted in request capacity and retained for every long-event chunk', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  const background = '10月26日客户已更正时间，尚待确认主持人。'.repeat(12);
  await configure(f, { screeningContext: background });
  f.ctx.llm.budget = async () => ({ maxInputTokens: 6000, maxOutputTokens: 2048 });
  f.add('large', '用户的原始长消息。'.repeat(1000));
  await f.q.intake.collect();
  f.advance();
  let count = 0;
  let previousEnd = 0;
  f.ctx.llm.generate = async (input: any) => {
    const { estimatePluginLlmInputTokens } = await import('@maka/runtime/plugin-llm-service');
    assert.ok(estimatePluginLlmInputTokens(input.system, input.prompt) <= 6000);
    const data = JSON.parse(input.prompt);
    assert.equal(data.screeningContext.text, background);
    assert.equal(data.offsetChars, previousEnd);
    previousEnd = data.endOffsetChars;
    count++;
    return { text: JSON.stringify({ context: '前文摘要', direction: '' }) };
  };
  await f.q.intake.judge();
  await f.q.intake.judge();
  assert.equal(count, 2);
  assert.ok(previousEnd > 0);
});
