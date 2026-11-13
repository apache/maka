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

const count = (f: any, table: string) =>
  Number(f.q.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);

test('Maka work histories are never read or queued by event intake', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  f.ctx.sessionQuery.list = async () => [{ id: 'ordinary', status: 'running' }];
  f.ctx.sessionQuery.historyList = async () => {
    throw Error('event intake must not enumerate own history');
  };
  f.ctx.sessionQuery.historyRead = async () => {
    throw Error('event intake must not read own progress');
  };
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.collect();
  await f.q.intake.judge();
  assert.equal(count(f, 'intake_events'), 0);
  assert.equal(count(f, 'intake_wakes'), 0);
  assert.equal(f.counts().modelCalls, 0);
  assert.equal(f.delivered.size, 0);
  assert.equal(
    f.q.store.db.prepare("SELECT value FROM intake_meta WHERE key='makaBaseline'").get(),
    undefined,
  );
});

test('context sources skip changes and screening while external activity still wakes discovery', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const originalList = f.ctx.sources.list,
    originalChanges = f.ctx.sources.changes;
  const reads: string[] = [];
  f.ctx.sources.list = () => [
    ...originalList(),
    { id: 'codex.work.sessions', scope: {}, changes: true, changeRole: 'context' },
    { id: 'codex.memories', scope: {}, changes: true, changeRole: 'context' },
  ];
  f.ctx.sources.changes = async (source: string, ...args: any[]) => {
    reads.push(source);
    assert.equal(source, 'mail');
    return originalChanges(source, ...args);
  };
  await f.q.intake.collect();
  f.add('outside', '有人发来新的安排');
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  await f.q.dispatch();
  await f.q.running;
  assert.deepEqual(reads, ['mail', 'mail']);
  assert.equal(f.counts().modelCalls, 1);
  assert.equal(f.counts().workerCalls, 1);
});

test('existing self-history backlog and partial summaries cannot wake after upgrade/restart', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const list = f.ctx.sources.list;
  f.ctx.sources.list = () => [
    ...list(),
    { id: 'codex.work.sessions', scope: {}, changes: true, changeRole: 'context' },
  ];
  for (const source of ['maka', 'codex.work.sessions']) {
    const id = source + '-old';
    f.q.store.db.prepare('INSERT INTO intake_events(id,source,at,payload) VALUES(?,?,?,?)').run(
      id,
      source,
      0,
      JSON.stringify({
        id,
        source,
        group: 'work',
        content: '执行中',
        object: { id: 'old', revision: '1' },
      }),
    );
    f.q.store.db.prepare('INSERT INTO intake_long_events VALUES(?,?,?)').run(id, 1, '旧片段');
    f.q.store.db
      .prepare('INSERT INTO intake_wakes(id,at,payload) VALUES(?,?,?)')
      .run(id, 0, JSON.stringify({ direction: '看看工作进展', evidenceIds: [id] }));
  }
  await f.restart();
  await f.q.intake.judge();
  await f.q.dispatch();
  await f.q.running;
  assert.equal(await f.q.intake.next(), undefined);
  assert.equal(f.counts().workerCalls, 0);
  assert.equal(f.counts().modelCalls, 0);
  assert.equal(count(f, 'intake_long_events'), 0);
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_events WHERE status='ignored'").get().n,
    2,
  );
  assert.equal(
    f.q.store.db.prepare("SELECT COUNT(*) n FROM intake_wakes WHERE status='discarded'").get().n,
    2,
  );
});

test('mixed queued hint is withdrawn without losing its independent external event', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  for (const [id, source] of [
    ['self', 'maka'],
    ['external', 'mail'],
  ])
    f.q.store.db
      .prepare("INSERT INTO intake_events(id,source,at,payload,status) VALUES(?,?,?,?,'screened')")
      .run(
        id,
        source,
        0,
        JSON.stringify({ id, source, group: 'work', content: id, object: { id, revision: '1' } }),
      );
  f.q.store.db
    .prepare('INSERT INTO intake_wakes(id,at,payload) VALUES(?,?,?)')
    .run(
      'mixed',
      0,
      JSON.stringify({ direction: 'mixed with own progress', evidenceIds: ['self', 'external'] }),
    );
  assert.equal(await f.q.intake.next(), undefined);
  f.ctx.llm.generate = async (input: any) => {
    const p = JSON.parse(input.prompt);
    assert.equal(p.events.length, 1);
    assert.equal(p.events[0].source, 'mail');
    return { text: JSON.stringify('外部变化值得关注') };
  };
  await f.q.intake.judge();
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  assert.match(f.prompts[0], /外部变化值得关注/);
  assert.doesNotMatch(f.prompts[0], /mixed with own progress/);
});

test('switching a source to context during screening prevents its late hint', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const list = f.ctx.sources.list;
  await f.q.intake.collect();
  f.add('progress');
  await f.q.intake.collect();
  f.advance();
  f.ctx.llm.generate = async () => {
    f.ctx.sources.list = () => list().map((s: any) => ({ ...s, changeRole: 'context' }));
    return { text: JSON.stringify('late hint') };
  };
  await f.q.intake.judge();
  assert.equal(await f.q.intake.next(), undefined);
  assert.equal(count(f, 'intake_wakes'), 0);
});

test('scheduled discovery continues observing Maka and Codex context while event intake is enabled', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  let revision = 1,
    token = 1;
  const watched: string[] = [];
  const list = f.ctx.sources.list;
  f.ctx.sources.list = () => [
    ...list(),
    { id: 'codex.work.sessions', scope: {}, changes: true, changeRole: 'context' },
  ];
  f.ctx.sessionQuery.historyList = async () => [{ id: 'ordinary', historyRevision: revision }];
  f.ctx.sources.activityToken = async (id: string) => {
    watched.push(id);
    return String(token);
  };
  await f.q.intake.collect();
  f.advance(15 * 60000);
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  assert.deepEqual(watched, ['codex.work.sessions']);
  revision++;
  await f.q.intake.collect();
  await f.q.intake.judge();
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  assert.equal(f.counts().modelCalls, 0);
  f.advance(15 * 60000);
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 2);
  token++;
  f.advance(15 * 60000);
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 3);
  assert.equal(f.counts().modelCalls, 0);
  assert.equal(count(f, 'intake_events'), 0);
});

test('a source changed to context while fetching cannot refill the pruned queue', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  await f.q.intake.collect();
  const list = f.ctx.sources.list,
    changes = f.ctx.sources.changes;
  f.add('late-progress');
  f.ctx.sources.changes = async (...args: any[]) => {
    const result = await changes(...args);
    f.ctx.sources.list = () => list().map((s: any) => ({ ...s, changeRole: 'context' }));
    return result;
  };
  await f.q.intake.collect();
  f.advance();
  await f.q.intake.judge();
  assert.equal(count(f, 'intake_events'), 0);
  assert.equal(f.counts().modelCalls, 0);
});
