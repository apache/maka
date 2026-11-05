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
import { intakeChunkEnd } from '../../../../src/assistant/index-initiative/intake-chunks.js';
import { estimatePluginLlmInputTokens } from '@maka/runtime/plugin-llm-service';

const pending = (f: any) =>
  Number(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE status='pending'").get().n,
  );
const wakes = (f: any) =>
  Number(f.q.store.db.prepare('SELECT COUNT(*) n FROM intake_wakes').get().n);
const progress = (f: any) =>
  f.q.store.db.prepare('SELECT offset,context FROM intake_long_events').get();
const original = (ending: string) =>
  JSON.stringify({
    messages: [
      { text: '服务故障，需要修复' },
      ...Array.from({ length: 80 }, (_, i) => ({ text: `记录${i} ` + '无关背景。'.repeat(18) })),
      { text: ending },
    ],
  });
async function setup(t: any, text: string) {
  const f = await intakeFixture();
  t.after(() => f.close());
  f.ctx.llm.budget = async () => ({
    modelId: 'small',
    maxInputTokens: 5000,
    maxOutputTokens: 2048,
  });
  await f.q.intake.collect();
  f.add('single', text);
  await f.q.intake.collect();
  f.advance();
  return f;
}
async function drain(f: any) {
  for (let i = 0; pending(f) && i < 200; i++) {
    await f.q.intake.judge();
    await f.q.dispatch();
    await f.q.running;
  }
  assert.equal(pending(f), 0);
}

test('single long event is sequential, carries corrections, and never wakes before the final decision', async (t) => {
  const text = original('已经修复并验证通过');
  const f = await setup(t, text);
  let offset = 0,
    calls = 0;
  f.ctx.llm.generate = async (input: any) => {
    const p = JSON.parse(input.prompt),
      content = p.events[0].records[0].content;
    assert.equal(p.offsetChars, offset);
    assert.equal(content, text.slice(p.offsetChars, p.endOffsetChars));
    assert.equal(p.earlierContext, calls ? '此前服务故障；后续状态仍待原文确认' : '');
    assert.equal(wakes(f), 0);
    assert.equal(f.counts().workerCalls, 0);
    assert.ok(estimatePluginLlmInputTokens(input.system, input.prompt) <= 5000);
    offset = p.endOffsetChars;
    calls++;
    if (p.final) assert.ok(content.includes('已经修复并验证通过'));
    // Even an erroneous intermediate direction is not actionable until the original ends.
    return {
      text: JSON.stringify({
        context: '此前服务故障；后续状态仍待原文确认',
        direction: p.final ? '' : '服务故障需要关注',
      }),
    };
  };
  await drain(f);
  assert.ok(calls > 2);
  assert.equal(offset, text.length);
  assert.equal(wakes(f), 0);
  assert.equal(f.counts().workerCalls, 0);
  assert.equal(progress(f), undefined);
});

test('one long event creates at most one wake, including interleaved dispatch, restart and replay', async (t) => {
  const text = original('仍然故障，未修复');
  const f = await setup(t, text);
  let offset = 0,
    calls = 0;
  f.ctx.llm.generate = async (input: any) => {
    const p = JSON.parse(input.prompt);
    assert.equal(p.offsetChars, offset);
    offset = p.endOffsetChars;
    calls++;
    return { text: JSON.stringify({ context: '服务仍故障', direction: '关注服务故障' }) };
  };
  await f.q.intake.judge();
  assert.ok(progress(f).offset > 0);
  assert.equal(wakes(f), 0);
  await f.restart();
  await drain(f);
  assert.ok(calls > 2);
  assert.equal(wakes(f), 1);
  assert.equal(f.counts().workerCalls, 1);
  const receipt = JSON.parse(
    String(f.q.store.db.prepare('SELECT payload FROM intake_wakes').get().payload),
  );
  const root = f.q.store.db.prepare('SELECT id FROM intake_events').get().id;
  assert.deepEqual(receipt.evidenceIds, [root]);
  await f.restart();
  await f.q.intake.collect();
  await f.q.intake.judge();
  await f.q.dispatch();
  await f.q.running;
  assert.equal(wakes(f), 1);
  assert.equal(f.counts().workerCalls, 1);
});

test('failed or over-budget summaries retain offset; a smaller model continues without dropping text', async (t) => {
  const f = await setup(t, original('未修复'));
  const seen: string[] = [];
  let capacity = 5000,
    bad = '';
  f.ctx.llm.budget = async () => ({
    modelId: 'resize',
    maxInputTokens: capacity,
    maxOutputTokens: 2048,
  });
  f.ctx.llm.generate = async (input: any) => {
    assert.ok(estimatePluginLlmInputTokens(input.system, input.prompt) <= capacity);
    if (bad === 'network') throw Error('offline');
    if (bad === 'json') return { text: '{}' };
    if (bad === 'truncated')
      return { text: '{"context":"","direction":""}', finishReason: 'length' };
    if (bad === 'summary')
      return { text: JSON.stringify({ context: 'x'.repeat(capacity), direction: '' }) };
    const p = JSON.parse(input.prompt);
    seen.push(p.events[0].records[0].content);
    return { text: JSON.stringify({ context: '前文尚无修复记录', direction: '' }) };
  };
  await f.q.intake.judge();
  const saved = { ...progress(f) };
  for (const fault of ['network', 'json', 'truncated', 'summary']) {
    bad = fault;
    await assert.rejects(f.q.intake.judge());
    assert.deepEqual({ ...progress(f) }, saved);
    assert.equal(wakes(f), 0);
    f.advance(31000);
  }
  bad = '';
  capacity = 3500;
  await f.restart();
  await drain(f);
  assert.equal(seen.join(''), original('未修复'));
});

test('a short independent event can wake while a long original remains incomplete', async (t) => {
  const f = await setup(t, original('未修复'));
  f.ctx.llm.generate = async (input: any) => {
    const p = JSON.parse(input.prompt);
    return {
      text:
        p.offsetChars === undefined
          ? JSON.stringify('新消息值得关注')
          : JSON.stringify({ context: '服务故障', direction: '' }),
    };
  };
  await f.q.intake.judge();
  assert.ok(progress(f));
  f.add('other', '独立的新消息', 'other-group');
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  assert.ok(progress(f));
  await drain(f);
  assert.equal(f.counts().workerCalls, 1);
});

test('revocation during long-event screening cannot commit a summary or wake', async (t) => {
  const f = await setup(t, original('未修复'));
  f.ctx.llm.generate = async () => {
    f.allow(false);
    return { text: JSON.stringify({ context: 'secret', direction: 'secret' }) };
  };
  await f.q.intake.judge();
  assert.equal(wakes(f), 0);
  assert.equal(progress(f), undefined);
  assert.equal(f.q.store.db.prepare('SELECT status FROM intake_events').get().status, 'revoked');
});

test('natural boundaries preserve complete messages where possible; giant records remain lossless Unicode fragments', () => {
  const json = JSON.stringify({
    messages: [{ text: '第一条😀' }, { text: '第二条😀'.repeat(100) }, { text: '第三条' }],
  });
  const firstEnd = json.indexOf('},') + 2;
  assert.equal(intakeChunkEnd(json, 0, firstEnd + 20), firstEnd);
  const line = '第一段\n第二段😀\n第三段';
  assert.equal(intakeChunkEnd(line, 0, 7), 4);
  const raw = '😀'.repeat(10);
  assert.equal(intakeChunkEnd(raw, 0, 5), 4);
  let start = 0,
    rebuilt = '';
  while (start < json.length) {
    const end = intakeChunkEnd(json, start, Math.min(json.length, start + 35));
    assert.ok(end > start);
    assert.ok(json.slice(start, end).isWellFormed());
    rebuilt += json.slice(start, end);
    start = end;
  }
  assert.equal(rebuilt, json);
});

test('legacy unfinished fragments restart from the retained original and withdraw pending partial hints', async (t) => {
  const f = await setup(t, original('未修复'));
  const root = f.q.store.db.prepare('SELECT id,payload FROM intake_events').get();
  f.q.store.db.prepare("UPDATE intake_events SET status='split' WHERE id=?").run(root.id);
  for (const [id, status] of [
    ['old-one', 'screened'],
    ['old-two', 'pending'],
  ])
    f.q.store.db
      .prepare('INSERT INTO intake_events(id,source,at,payload,status) VALUES(?,?,?,?,?)')
      .run(
        id,
        'mail',
        0,
        JSON.stringify({
          ...JSON.parse(root.payload),
          id,
          fragmentOf: root.id,
          content: 'partial',
        }),
        status,
      );
  f.q.store.db
    .prepare('INSERT INTO intake_wakes(id,at,payload) VALUES(?,?,?)')
    .run('partial-wake', 0, JSON.stringify({ direction: '旧片段', evidenceIds: ['old-one'] }));
  f.q.store.db.prepare("DELETE FROM intake_meta WHERE key='long-event-v2'").run();
  await f.restart();
  assert.equal(pending(f), 1);
  assert.equal(
    f.q.store.db.prepare("SELECT status FROM intake_wakes WHERE id='partial-wake'").get().status,
    'discarded',
  );
  assert.equal(await f.q.intake.next(), undefined);
  f.ctx.llm.generate = async () => ({
    text: JSON.stringify({ context: '尚未修复', direction: '服务故障' }),
  });
  await drain(f);
  assert.equal(f.counts().workerCalls, 1);
  await f.restart();
  assert.equal(pending(f), 0);
});

test('shrinking the screening model restarts retained progress instead of retrying it forever', async (t) => {
  const text = original('最终已修复');
  const f = await setup(t, text);
  let capacity = 12000;
  f.ctx.llm.budget = async () => ({
    modelId: 'resize',
    maxInputTokens: capacity,
    maxOutputTokens: 2048,
  });
  const reads: { offset: number; content: string }[] = [];
  f.ctx.llm.generate = async (input: any) => {
    assert.ok(estimatePluginLlmInputTokens(input.system, input.prompt) <= capacity);
    const p = JSON.parse(input.prompt);
    reads.push({ offset: p.offsetChars, content: p.events[0].records[0].content });
    return {
      text: JSON.stringify({
        context: 'x'.repeat(Math.max(1, p.contextBudget.maxJsonUtf8Bytes - 20)),
        direction: p.final ? '服务已修复，可向用户确认' : '',
      }),
    };
  };
  await f.q.intake.judge();
  const accumulated = { ...progress(f) };
  assert.ok(accumulated.offset > 0);
  assert.ok(
    Buffer.byteLength(JSON.stringify(accumulated.context)) > Math.floor(3500 / 3),
    "the retained summary is larger than the smaller model's whole context budget",
  );
  capacity = 3500;
  await f.restart();
  reads.length = 0;
  // Previously threw "Configure a larger screening model" on every tick, forever.
  await assert.doesNotReject(f.q.intake.judge());
  assert.equal(reads.length, 1);
  assert.equal(reads[0].offset, 0, 'progress restarted from the beginning under the new budget');
  assert.ok(Number(progress(f).offset) < accumulated.offset);
  await drain(f);
  assert.equal(reads.map((read) => read.content).join(''), text, 'no text dropped by the restart');
  assert.equal(wakes(f), 1);
});

test('an event that cannot fit is backed off on its own row instead of blocking the queue', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  f.ctx.llm.budget = async () => ({
    modelId: 'small',
    maxInputTokens: 5000,
    maxOutputTokens: 2048,
  });
  await f.q.intake.collect();
  // Its screening metadata alone can never fit, so no chunk size makes it readable.
  f.feed.push({
    id: 'giant',
    group: 'chat',
    occurredAt: f.q.now(),
    object: {
      id: 'giant',
      revision: '1',
      kind: 'message',
      title: 'T'.repeat(60000),
      locator: { id: 'giant' },
    },
    content: '正文很长的一条消息',
  });
  f.add('short', '客户改期，需要助手确认', 'other');
  await f.q.intake.collect();
  f.advance();
  let longCalls = 0;
  f.ctx.llm.generate = async (input: any) => {
    if (JSON.parse(input.prompt).offsetChars !== undefined) longCalls++;
    return { text: JSON.stringify('客户改期需要关注') };
  };
  const retry = () =>
    f.q.store.db
      .prepare(
        "SELECT retry_at FROM intake_events WHERE json_extract(payload,'$.content')='正文很长的一条消息'",
      )
      .get();
  // The queue head cannot fit: this used to throw before any backoff was written.
  await assert.doesNotReject(f.q.intake.judge());
  assert.equal(longCalls, 0);
  assert.ok(Number(retry().retry_at) > f.q.now(), 'the unfittable event is backed off');
  assert.equal(pending(f), 2);
  // Within the same backoff window the queue moves on: the short event still screens.
  await assert.doesNotReject(f.q.intake.judge());
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  assert.equal(pending(f), 1);
  assert.equal(longCalls, 0, 'the deferred event is not retried on every tick');
  const deferred = Number(retry().retry_at);
  f.advance(31000);
  await assert.doesNotReject(f.q.intake.judge());
  assert.ok(Number(retry().retry_at) > deferred, 'it retries once the backoff expires');
  assert.equal(pending(f), 1);
});

test('an unfittable event rotates behind other groups even after its deferral expires', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  f.ctx.llm.budget = async () => ({
    modelId: 'small',
    maxInputTokens: 4000,
    maxOutputTokens: 2048,
  });
  let calls = 0;
  f.ctx.llm.generate = async (input: any) => {
    assert.ok(estimatePluginLlmInputTokens(input.system, input.prompt) <= 4000);
    calls++;
    return { text: JSON.stringify('') };
  };
  await f.q.intake.collect();
  // An already-screened group has a later checked position than a new bad event.
  f.add('healthy-before', 'Earlier update', 'healthy');
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  const title = 'T'.repeat(6000);
  f.feed.push({
    id: 'large',
    group: 'large',
    occurredAt: f.q.now(),
    object: { id: 'large', revision: '1', kind: 'message', title, locator: { id: 'large' } },
    content: 'A short body',
  });
  f.add('healthy-after', 'New update', 'healthy');
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  assert.equal(calls, 1, 'oversized metadata cannot reach the model');
  f.advance(31000);
  await f.q.intake.judge();
  assert.equal(calls, 2, 'the healthy group progresses even after the bad event is eligible again');
  assert.equal(pending(f), 1);

  f.advance(31000);
  await f.q.intake.judge();
  f.add('neighbour', 'A short message in the same group', 'large');
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  assert.equal(calls, 3, 'rotating the group must not put its healthy neighbours on backoff');
  assert.equal(pending(f), 1);
  await f.restart();
  f.advance(31000);
  await f.q.intake.judge();
  assert.equal(calls, 3);
  const retained = f.q.store.db
    .prepare("SELECT payload,retry_at FROM intake_events WHERE status='pending'")
    .get();
  assert.equal(JSON.parse(String(retained.payload)).object.title, title);
  assert.ok(Number(retained.retry_at) > f.q.now(), 'the original remains durable and retryable');
});
