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
  assert.match(f.prompts[0], /QuickDiscoveryEvents/);
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
test('malformed or partial model decisions keep all inputs pending', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('a');
  f.add('b');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async () => ({ text: '{"decisions":[],"context":""}' });
  await assert.rejects(f.q.intake.judge(), /every input/);
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE status='pending'").get()?.n,
    2,
  );
  assert.throws(
    () =>
      parseIntake(
        '{"decisions":[{"id":"a","action":"retain","reason":"x"},{"id":"a","action":"retain","reason":"x"}],"context":""}',
        ['a', 'b'],
      ),
    /every input/,
  );
});
test('retained original is supplied again for related thread changes', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('a', '演示尚未验收');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async (input: any) => {
    const p = JSON.parse(input.prompt);
    return {
      modelId: 'small',
      text: JSON.stringify({
        decisions: p.events.map((e: any) => ({
          id: e.id,
          action: 'retain',
          reason: 'await context',
        })),
        context: '演示尚未验收',
      }),
    };
  };
  await f.q.intake.judge();
  assert.equal(await f.q.intake.next(), undefined);
  f.add('b', '客户提前');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async (input: any) => {
    const p = JSON.parse(input.prompt);
    assert.match(JSON.stringify(p.context.relatedEvents), /尚未验收/);
    return {
      modelId: 'small',
      text: JSON.stringify({
        decisions: p.events.map((e: any) => ({
          id: e.id,
          action: 'investigate',
          reason: '提前与验收关联',
        })),
        context: '提前与验收关联',
      }),
    };
  };
  await f.q.intake.judge();
  assert.ok(await f.q.intake.next());
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
      text: JSON.stringify({
        decisions: JSON.parse(input.prompt).events.map((e: any) => ({
          id: e.id,
          action: 'investigate',
          reason: 'x',
        })),
        context: 'secret',
      }),
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
  assert.equal((await f.q.intake.next())?.events[0].group, 'chat');
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
  assert.equal((await f.q.intake.next())?.events[0].source, 'healthy');
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
    assert.ok(input.prompt.length < 45000);
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
