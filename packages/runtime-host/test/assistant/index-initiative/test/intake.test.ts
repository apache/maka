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
import { parseIntake } from '../../../../src/assistant/index-initiative/intake.js';

test('baseline costs no model; new event starts investigation before 15 minutes', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  f.add('history');
  await f.q.intake.collect();
  await f.q.intake.judge();
  assert.deepEqual(f.counts(), { modelCalls: 0, workerCalls: 0 });
  f.add('new', '客户明早来，演示还未验收');
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  assert.equal(f.counts().modelCalls, 1);
  await f.q.tick();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  assert.match(f.prompts[0], /不局限于这些线索/);
  assert.doesNotMatch(f.prompts[0], /客户明早来/);
  assert.doesNotMatch(f.prompts[0], /这是定时唤醒/);
  await f.q.tick();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
});
test('durable receipt survives restart, replay is deduplicated and cursor is independent of model success', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('one');
  await f.q.intake.collect();
  const cursor = f.q.store.db
    .prepare('SELECT cursor FROM intake_sources WHERE id=?')
    .get('mail')?.cursor;
  await f.restart();
  f.advance();
  await f.q.intake.collect();
  assert.equal(f.q.store.db.prepare('SELECT COUNT(*) n FROM intake_events').get()?.n, 1);
  f.ctx.llm.generate = async () => {
    throw Error('model offline');
  };
  await assert.rejects(f.q.intake.judge(), /offline/);
  assert.equal(
    f.q.store.db.prepare('SELECT cursor FROM intake_sources WHERE id=?').get('mail')?.cursor,
    cursor,
  );
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE status='pending'").get()?.n,
    1,
  );
});
test('network failure preserves cursor; changed scope baselines separately', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('one');
  f.fail(true);
  await f.q.intake.collect();
  assert.equal(f.sourceCalls.at(-1), '0');
  assert.equal(f.delivered.size, 1);
  await f.q.intake.collect();
  assert.equal(f.delivered.size, 1);
  f.fail(false);
  await f.q.intake.collect();
  assert.equal(f.q.intake.status().counts[0].count, 1);
  f.scope();
  f.add('new-scope-history');
  await f.q.intake.collect();
  assert.equal(f.sourceCalls.at(-1), undefined);
  assert.equal(f.q.intake.status().counts[0].count, 1);
});
test('malformed or obsolete output remains pending; the only result is a direction string', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('a');
  await f.q.intake.collect();
  f.advance();
  for (const text of ['{}', 'null', '[]', '{"investigate":[]}', 'unquoted direction']) {
    f.ctx.llm.generate = async () => ({ text });
    await assert.rejects(f.q.intake.judge());
    f.advance(31000);
  }
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE status='pending'").get()?.n,
    1,
  );
  assert.equal(parseIntake('"  卡片部署可能没生效  "'), '卡片部署可能没生效');
  assert.equal(parseIntake('""'), '');
});
test('empty selection retains originals without waking or repeating them as background', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('a', '演示尚未验收');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async () => ({ text: '""' });
  await f.q.intake.judge();
  assert.equal(await f.q.intake.next(), undefined);
  f.add('b', '客户提前');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async (input: any) => {
    assert.doesNotMatch(input.prompt, /尚未验收/);
    return {
      text: JSON.stringify('客户提前可能影响安排'),
    };
  };
  await f.q.intake.judge();
  const batch = await f.q.intake.next();
  assert.equal(batch?.ids.length, 1);
  assert.match(
    String(
      f.q.store.db.prepare("SELECT payload FROM intake_events WHERE status='screened'").get()
        ?.payload,
    ),
    /尚未验收/,
  );
});
test('permission revocation blocks queued evidence before model and after model', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('a');
  await f.q.intake.collect();
  f.advance();
  f.allow(false);
  await f.q.intake.judge();
  assert.equal(f.counts().modelCalls, 0);
  f.allow(true);
  f.add('b');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async (input: any) => {
    f.allow(false);
    return {
      text: JSON.stringify('可能有变化'),
    };
  };
  await f.q.intake.judge();
  assert.equal(await f.q.intake.next(), undefined);
});
test('pause prevents admission; worker busy retains investigation queue', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('a');
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  f.agent.snapshot = async () => ({ agent: { status: 'running' } });
  await f.q.tick();
  assert.equal(f.counts().workerCalls, 0);
  assert.ok(await f.q.intake.next());
  await f.q.control({ action: 'pause' });
  await f.q.tick();
  assert.equal(f.counts().workerCalls, 0);
  assert.equal(f.counts().modelCalls, 1);
});
test('events arriving during investigation remain for the next batch', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('a');
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  let release: () => void = () => {};
  f.agent.whenIdle = () =>
    new Promise<void>((r) => {
      release = r;
    });
  await f.q.tick();
  await new Promise((r) => setTimeout(r, 30));
  f.add('b');
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  release();
  await f.q.running;
  assert.equal((await f.q.intake.next())?.ids.length, 1);
});

test('source authorization outage cannot block healthy source delivery or consume failed inputs', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  for (let i = 0; i < 13; i++) f.add('bad-' + i);
  await f.q.intake.collect();
  f.add('good');
  await f.q.intake.collect();
  f.q.store.db
    .prepare(
      "UPDATE intake_events SET source='healthy',payload=json_set(payload,'$.source','healthy') WHERE json_extract(payload,'$.content')='good'",
    )
    .run();
  const authorize = f.ctx.sources.authorize;
  f.ctx.sources.authorize = async (source: string, objects: any[]) => {
    if (source === 'mail') throw Error('permission service offline');
    return authorize(source, objects);
  };
  f.advance();
  await f.q.intake.judge();
  await f.q.intake.judge();
  assert.equal(f.counts().modelCalls, 1);
  assert.equal((await f.q.intake.next())?.ids.length, 1);
  assert.equal(
    f.q.store.db.prepare("SELECT count(*) n FROM intake_events WHERE status='pending'").get()?.n,
    13,
  );
  f.ctx.sources.authorize = authorize;
  f.advance(31000);
  await f.q.intake.judge();
  await f.q.intake.judge();
  assert.equal(
    f.q.store.db.prepare("SELECT count(*) n FROM intake_events WHERE status='pending'").get()?.n,
    0,
  );
});
test('large events are delivered in bounded calls with no total-work truncation', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('long', 'x'.repeat(60000));
  await f.q.intake.collect();
  f.advance();
  const generate = f.ctx.llm.generate;
  const contents: string[] = [];
  f.ctx.llm.generate = async (input: any) => {
    assert.ok(input.prompt.length < 64000);
    contents.push(
      ...JSON.parse(input.prompt).events.flatMap((e: any) => e.records.map((r: any) => r.content)),
    );
    return generate(input);
  };
  for (let i = 0; i < 5; i++) await f.q.intake.judge();
  assert.equal(contents.join(''), 'x'.repeat(60000));
  assert.equal(
    f.q.store.db.prepare("SELECT count(*) n FROM intake_events WHERE status='pending'").get()?.n,
    0,
  );
});

test('one batch produces one hint, without selected IDs or an investigation checklist', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  for (let i = 0; i < 100; i++) f.add('noise' + i, '闲聊' + i, 'busy');
  f.add('customer', '客户明天九点来', 'busy');
  f.add('family', '陪家人复诊', 'family');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async (input: any) => {
    const records = JSON.parse(input.prompt).events.flatMap((g: any) => g.records);
    assert.equal(records.length, 102);
    assert.ok(records.every((record: any) => !('id' in record)));
    return { text: JSON.stringify('明天的安排可能有冲突') };
  };
  await f.q.intake.judge();
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE status='screened'").get()?.n,
    102,
  );
  const wake = await f.q.intake.next();
  assert.equal(wake?.ids.length, 1);
  await f.restart();
  assert.deepEqual(await f.q.intake.next(), wake);
  f.agent.followup = async (text: string) => {
    assert.match(text, /明天的安排可能有冲突/);
    assert.match(text, /不准确.*不完整/);
    assert.match(text, /不局限于这些线索或最近的增量/);
    assert.doesNotMatch(text, /闲聊|processedEventIds|QuickDiscoveryEvents|batchId/);
    await f.q.report({ key: 'discovery', messages: ['核实后有个建议'] }, 'worker');
    return { disposition: 'turn_started' };
  };
  await f.q.dispatch();
  await f.q.running;
  assert.equal(await f.q.intake.next(), undefined);
  assert.equal(f.delivered.size, 1);
});
test('new arrivals cannot be consumed by a screening decision for an older batch', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('old');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async () => {
    f.add('new');
    await f.q.intake.collect();
    return { text: '""' };
  };
  await f.q.intake.judge();
  const pending = f.q.store.db
    .prepare("SELECT payload FROM intake_events WHERE status='pending'")
    .all();
  assert.equal(pending.length, 1);
  assert.equal(JSON.parse(String(pending[0].payload)).object.id, 'new');
});

test('a truncated but parseable response cannot silently retain omitted evidence', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('a');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async () => ({ text: '""', finishReason: 'length' });
  await assert.rejects(f.q.intake.judge(), /truncated/);
  assert.equal(f.q.intake.status().counts[0].status, 'pending');
});
