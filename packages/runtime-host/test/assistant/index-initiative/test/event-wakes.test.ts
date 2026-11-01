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
import { initializeQuickDiscovery } from '../../../../src/assistant/index-initiative/quick.js';

async function hint(f: any, id: string, direction: string) {
  f.add(id);
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async () => ({ text: JSON.stringify(direction) });
  await f.q.intake.judge();
}

test('pending hints coalesce into one wake, exact directions deduplicate, quiet completion consumes only captured hints', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  await hint(f, 'one', '卡片可能没生效');
  await hint(f, 'two', '卡片可能没生效');
  await hint(f, 'three', '明天安排可能有冲突');
  const wake = await f.q.intake.next();
  assert.equal(wake?.ids.length, 3);
  assert.deepEqual(await f.q.intake.directions(wake!), ['卡片可能没生效', '明天安排可能有冲突']);
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  assert.equal(f.delivered.size, 0);
  assert.equal(await f.q.intake.next(), undefined);
  assert.equal(f.q.state().lastError, null);
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_wakes WHERE status='delivered'").get()?.n,
    3,
  );
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE status='investigated'").get()
      ?.n,
    0,
  );
});

test('hints survive restart and failed worker execution; retry uses the same activation without rescreening', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  await hint(f, 'one', '卡片可能没生效');
  const wake = await f.q.intake.next();
  await f.restart();
  assert.deepEqual(await f.q.intake.next(), wake);
  const follow = f.agent.followup;
  f.agent.followup = async () => {
    throw Error('worker unavailable');
  };
  await f.q.dispatch();
  await f.q.running;
  assert.match(f.q.state().lastError, /worker unavailable/);
  assert.deepEqual(f.q.state().pending.eventWake, wake);
  assert.deepEqual(await f.q.intake.next(), wake);
  f.agent.followup = follow;
  f.advance(3600000);
  await f.q.dispatch();
  await f.q.running;
  assert.equal(await f.q.intake.next(), undefined);
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE status='screened'").get()?.n,
    1,
  );
});

test('hint permissions are rechecked; authorization outages retry and revocation drops a hint', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  await hint(f, 'one', '敏感变化');
  const wake = await f.q.intake.next();
  const authorize = f.ctx.sources.authorize;
  f.ctx.sources.authorize = async () => {
    throw Error('offline');
  };
  assert.equal(await f.q.intake.next(), undefined);
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_wakes WHERE status='pending'").get()?.n,
    1,
  );
  f.ctx.sources.authorize = authorize;
  f.advance(31000);
  assert.deepEqual(await f.q.intake.next(), wake);
  f.allow(false);
  assert.deepEqual(await f.q.intake.directions(wake!), []);
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_wakes WHERE status='discarded'").get()?.n,
    1,
  );
});

test('new hints arriving during a wake are not consumed by that activation', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  await hint(f, 'one', '卡片可能没生效');
  const follow = f.agent.followup;
  f.agent.followup = async (text: string) => {
    await hint(f, 'two', '明天安排有变化');
    return follow(text);
  };
  await f.q.dispatch();
  await f.q.running;
  const next = await f.q.intake.next();
  assert.equal(next?.ids.length, 1);
  assert.deepEqual(await f.q.intake.directions(next!), ['明天安排有变化']);
  assert.doesNotMatch(f.prompts[0], /明天安排有变化/);
});

test('wake receipts and successful activation commit atomically', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  await hint(f, 'one', '卡片可能没生效');
  const complete = f.q.intake.complete.bind(f.q.intake);
  f.q.intake.complete = (wake: any) => {
    complete(wake);
    throw Error('commit failure');
  };
  await f.q.dispatch();
  await f.q.running;
  assert.match(f.q.state().lastError, /commit failure/);
  assert.ok(await f.q.intake.next());
  f.q.intake.complete = complete;
  f.advance(3600000);
  await f.q.dispatch();
  await f.q.running;
  assert.equal(await f.q.intake.next(), undefined);
});

test('legacy unfinished event queues rescreen without resetting sources or restoring a checklist', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  f.add('one');
  await f.q.intake.collect();
  f.q.store.db
    .prepare("UPDATE intake_events SET status='investigate',reason='old selected record'")
    .run();
  const cursor = f.q.store.db
    .prepare("SELECT cursor FROM intake_sources WHERE id='mail'")
    .get()?.cursor;
  f.q.store.update((s: any) => {
    s.workerSession = 'worker';
    s.active = {
      id: 'old',
      eventBatch: { id: 'old-batch', ids: ['one'] },
      reports: [],
      messageId: 'old-message',
    };
  });
  await f.restart();
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE status='pending'").get()?.n,
    1,
  );
  assert.equal(
    f.q.store.db.prepare("SELECT cursor FROM intake_sources WHERE id='mail'").get()?.cursor,
    cursor,
  );
  assert.equal(f.q.state().pending.eventBatch, undefined);
  assert.deepEqual(f.q.state().pending.eventWake, { ids: [] });
});

test('worker tools expose no event reader, per-event report fields or mandatory finish hook', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const registered: any[] = [];
  let hooks = 0;
  const q = initializeQuickDiscovery(
    {
      ...f.ctx,
      onStart: () => {},
      onClose: () => {},
      backgroundSessions: { register: () => {} },
      api: { register: () => {} },
      tools: { register: (tool: any) => registered.push(tool) },
      systemPrompt: { section: () => {} },
      turns: {
        beforeFinish: () => {
          hooks++;
        },
      },
    },
    f.parent,
    f.root + '/tools',
    3600000,
  );
  t.after(() => q.store.close());
  assert.equal(hooks, 0);
  assert.ok(!registered.some((t) => t.name === 'QuickDiscoveryEvents'));
  const report = registered.find((t) => t.name === 'QuickDiscoveryReport');
  assert.deepEqual(report.parameters.parse({ key: 'quiet', messages: [] }), {
    key: 'quiet',
    messages: [],
  });
  assert.throws(() =>
    report.parameters.parse({ key: 'old', messages: [], processedEventIds: ['a'] }),
  );
});
