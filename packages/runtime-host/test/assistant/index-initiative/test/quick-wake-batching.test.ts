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
import { estimatePluginLlmInputTokens } from '@maka/runtime/plugin-llm-service';
import { decodeMessageContent } from '../../../../src/protocol/turn.js';

function hints(
  f: any,
  count: number,
  text = (i: number) => `Hint ${i}: ${'delivery update '.repeat(10)}`,
  start = 0,
) {
  const ids: string[] = [];
  f.q.store.update(() => {
    for (let i = start; i < start + count; i++) {
      const id = `hint-${i}`;
      ids.push(id);
      f.q.store.db
        .prepare(
          "INSERT INTO intake_events(id,source,at,payload,status) VALUES(?,?,?,?, 'screened')",
        )
        .run(
          id,
          'mail',
          i,
          JSON.stringify({
            id,
            source: 'mail',
            group: id,
            object: { id, revision: '1' },
            content: id,
          }),
        );
      f.q.store.db
        .prepare('INSERT INTO intake_wakes(id,at,payload) VALUES(?,?,?)')
        .run(id, i, JSON.stringify({ direction: text(i), evidenceIds: [id] }));
    }
  });
  return ids;
}
const status = (f: any, id: string) =>
  f.q.store.db.prepare('SELECT status FROM intake_wakes WHERE id=?').get(id)?.status;

for (const intakeEnabled of [true, false]) {
  test(`an unavailable captured hint cannot block healthy work or periodic checks (intake=${intakeEnabled})`, async (t) => {
    const f = await intakeFixture();
    t.after(() => f.close());
    const costs: any[] = [];
    f.ctx.runCost = {
      record: async (cost: any) => {
        costs.push(cost);
      },
    };
    hints(f, 1, () => 'offline direction');
    const authorize = f.ctx.sources.authorize;
    f.agent.snapshot = async () => {
      f.ctx.sources.authorize = async (source: string, objects: any[]) => {
        if (source === 'mail') throw Error('source offline');
        return authorize(source, objects);
      };
      return { agent: { status: 'idle' } };
    };
    await f.q.dispatch();
    await f.q.running;
    assert.equal(f.counts().workerCalls, 0);
    assert.equal(costs.length, 0, 'a deferred hint is not a model run');
    assert.equal(f.parent.coordinator.previous().outcome, 'interrupted');
    assert.equal(status(f, 'hint-0'), 'pending');
    // B arrives after A was captured and became unavailable.
    hints(f, 1, () => 'healthy direction', 1);
    f.q.store.db
      .prepare(
        "UPDATE intake_events SET source='healthy',payload=json_set(payload,'$.source','healthy') WHERE id='hint-1'",
      )
      .run();
    await f.restart();
    if (!intakeEnabled) await f.q.control({ action: 'configure', eventIntake: false });
    f.advance(3600000);
    await f.q.dispatch();
    await f.q.running;
    assert.equal(f.counts().workerCalls, 1);
    assert.doesNotMatch(f.prompts[0], /offline direction/);
    if (intakeEnabled) {
      assert.match(f.prompts[0], /healthy direction/);
      assert.equal(status(f, 'hint-1'), 'delivered');
    } else assert.equal(status(f, 'hint-1'), 'pending', 'disabled intake must not accept B');
    f.advance(3600000);
    await f.q.dispatch();
    await f.q.running;
    assert.equal(f.counts().workerCalls, 2, 'periodic discovery progresses during the outage');
    f.ctx.sources.authorize = authorize;
    f.agent.snapshot = async () => ({ agent: { status: 'idle' } });
    f.advance(31000);
    await f.q.dispatch();
    await f.q.running;
    assert.equal(
      status(f, 'hint-0'),
      'delivered',
      'captured A resumes even with new intake disabled',
    );
  });
}

test('a partially unreadable batch acknowledges only the hints sent to the worker', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  hints(f, 2, (i) => (i ? 'healthy direction' : 'offline direction'));
  f.q.store.db
    .prepare(
      "UPDATE intake_events SET source='healthy',payload=json_set(payload,'$.source','healthy') WHERE id='hint-1'",
    )
    .run();
  f.agent.snapshot = async () => {
    f.ctx.sources.authorize = async (source: string, objects: any[]) => {
      if (source === 'mail') throw Error('source offline');
      return objects.map((o) => o.id);
    };
    return { agent: { status: 'idle' } };
  };
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  assert.match(f.prompts[0], /healthy direction/);
  assert.doesNotMatch(f.prompts[0], /offline direction/);
  assert.equal(status(f, 'hint-0'), 'pending');
  assert.equal(status(f, 'hint-1'), 'delivered');
});

for (const capacity of [5500, 1000000]) {
  test(`a backlog drains in FIFO batches within worker capacity and Host message limits (${capacity})`, async (t) => {
    const f = await intakeFixture();
    t.after(() => f.close());
    const ids = hints(f, 1000, (i) => `Hint ${i}: ${'delivery "update" \\ '.repeat(30)}`);
    f.ctx.llm.budget = async () => ({
      modelId: 'investigator',
      maxInputTokens: capacity,
      maxOutputTokens: 2048,
    });
    const seen: string[] = [];
    const followup = f.agent.followup;
    f.agent.followup = async (text, options) => {
      assert.ok(estimatePluginLlmInputTokens('', text) <= Math.floor(capacity * 0.75));
      decodeMessageContent({ text });
      seen.push(...f.q.state().active.eventWake.ids);
      return followup(text, options);
    };
    for (let i = 0; seen.length < ids.length && i < 1001; i++) {
      await f.q.dispatch();
      await f.q.running;
      assert.equal(f.q.state().lastError, null);
      assert.ok(f.prompts.length > 0);
    }
    assert.deepEqual(seen, ids);
    assert.ok(f.prompts.length > 1);
    assert.equal(
      f.q.intake.status().wakes.find((x: any) => x.status === 'pending'),
      undefined,
    );
  });
}

test('an individually oversized hint stays visible and pending while smaller hints run', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  hints(f, 2, (i) => (i ? 'small direction' : 'x'.repeat(100000)));
  f.ctx.llm.budget = async () => ({
    modelId: 'small',
    maxInputTokens: 5500,
    maxOutputTokens: 2048,
  });
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  assert.match(f.prompts[0], /small direction/);
  assert.ok(Buffer.byteLength(f.prompts[0]) < 5500);
  assert.equal(status(f, 'hint-0'), 'pending');
  assert.equal(status(f, 'hint-1'), 'delivered');
  assert.ok([...f.delivered.values()].some((x: any) => x.type === 'system_event'));
  assert.equal(await f.q.intake.next(), undefined, 'capacity deferrals must not spin each tick');
});

test('old oversized captures recover on a fresh worker and retain the remaining hints', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const ids = hints(f, 1000);
  const sessions: any[] = [{ id: 'poisoned', labels: ['assistant-quick-discovery:owner'] }];
  const recovered = { ...f.agent, sessionId: 'recovered' };
  const followup = recovered.followup;
  recovered.followup = async (text, options) => {
    assert.notEqual(f.q.state().active.messageId, 'old-message');
    return followup(text, options);
  };
  const poisoned = {
    ...f.agent,
    sessionId: 'poisoned',
    followup: async () => {
      throw Error('old oversized anchor');
    },
  };
  let created = 0;
  f.ctx.sessionQuery.list = async () => sessions;
  f.ctx.agents.resume = async ({ sessionId }: any) =>
    sessionId === 'poisoned' ? poisoned : recovered;
  f.ctx.agents.create = async (input: any) => {
    created++;
    sessions.push({ id: 'recovered', ...input });
    return recovered;
  };
  let invocation: any;
  const budgetOwners: string[] = [];
  f.parent.asOwner = (state: any, fn: any) => {
    invocation = state;
    return fn();
  };
  f.ctx.llm.budget = async (input: any) => {
    assert.equal(input.modelKey, undefined, 'do not size the wake with the screening model');
    budgetOwners.push(invocation.sessionId);
    return { modelId: 'small-investigator', maxInputTokens: 5500, maxOutputTokens: 2048 };
  };
  f.q.store.bindWorker('poisoned', 'quick', 'legacy', 'legacy');
  f.q.store.update((s: any) => {
    s.intakeModelKey = 'screening::large';
    s.workerSession = 'poisoned';
    s.contextWake = { id: 'old-context', mode: 'legacy' };
    s.pending = {
      id: 'old-activation',
      from: s.startedAt,
      to: s.startedAt,
      tokens: {},
      messageId: 'old-message',
      reports: [],
      eventWake: { ids },
    };
  });
  // Simulate a persisted activation from the version before independent captures.
  f.q.store.db.exec('ALTER TABLE intake_wakes DROP COLUMN captured');
  await f.restart();
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.q.state().lastError, null);
  assert.equal(f.q.state().pending, null);
  assert.equal(f.q.state().workerSession, 'recovered');
  assert.equal(created, 1);
  assert.deepEqual(budgetOwners.slice(0, 2), ['poisoned', 'recovered']);
  assert.ok(estimatePluginLlmInputTokens('', f.prompts[0]) <= Math.floor(5500 * 0.75));
  assert.equal(f.q.store.worker('poisoned')?.contextKey, 'legacy');
  assert.ok(f.q.intake.status().wakes.find((x: any) => x.status === 'pending')?.count > 0);
  await f.q.control({ action: 'configure', eventIntake: false });
  await f.q.dispatch();
  await f.q.running;
  assert.equal(created, 1, 'normal legacy reuse continues on the recovered worker');
  assert.equal(f.counts().workerCalls, 2);
});

test('a hint captured hours ago cannot pass for a fresh discovery', async (t) => {
  const f = await intakeFixture();
  t.after(() => f.close());
  const base = Date.now();
  const insert = (id: string, at: number, direction: string) =>
    f.q.store.update(() => {
      f.q.store.db
        .prepare(
          "INSERT INTO intake_events(id,source,at,payload,status) VALUES(?,?,?,?, 'screened')",
        )
        .run(
          id,
          'mail',
          at,
          JSON.stringify({
            id,
            source: 'mail',
            group: id,
            object: { id, revision: '1' },
            content: id,
          }),
        );
      f.q.store.db
        .prepare('INSERT INTO intake_wakes(id,at,payload) VALUES(?,?,?)')
        .run(id, at, JSON.stringify({ direction, evidenceIds: [id] }));
    });
  // Both hints are still pending; only their capture time separates them.
  insert('stale-hint', base - 3 * 3600000, 'the deploy was already repaired');
  insert('fresh-hint', base - 60000, 'the deploy just broke again');
  await f.q.dispatch();
  await f.q.running;
  assert.equal(f.counts().workerCalls, 1);
  const prompt = f.prompts[0];
  // Ages are coarse buckets, so assert the scale rather than an exact string.
  const stale = prompt.match(/\[([^\]]+)\] the deploy was already repaired/);
  const fresh = prompt.match(/\[([^\]]+)\] the deploy just broke again/);
  assert.ok(stale, `a stale hint keeps its age: ${prompt}`);
  assert.ok(fresh, `a recent hint keeps its age: ${prompt}`);
  assert.match(stale[1], /^\d+[hd] ago$/, 'three hours of pending time is visible as hours');
  assert.match(fresh[1], /^(just now|\d+m ago)$/, 'a one-minute-old hint is minutes, not hours');
  assert.notEqual(stale[1], fresh[1], 'the two hints cannot read the same');
  assert.ok(
    prompt.indexOf(stale[0]) < prompt.indexOf(fresh[0]),
    'hints are ordered oldest first, so the stale one is not presented as the latest',
  );
  assert.ok(
    prompt.includes('年龄大的线索很可能早已处理过'),
    'the prompt tells the worker how to read an old hint',
  );
  assert.equal(status(f, 'stale-hint'), 'delivered');
  assert.equal(status(f, 'fresh-hint'), 'delivered');
});
