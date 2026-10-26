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

import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createMatterStore } from '../assistant/proactive-matters/store.js';
import { createMatterObserver } from '../assistant/proactive-matters/condition-observer.js';
import {
  runCondition,
  conditionReader,
  normalizeCondition,
  type ConditionDefinition,
} from '../assistant/proactive-matters/condition.js';
import { buildMatterTools } from '../assistant/proactive-matters/tools.js';
import type { MatterSettleInput } from '../assistant/proactive-matters/matter.js';
import { decodeEventWaitRecord } from '@maka/core/event-wait';

const definition = {
  code: `const facts = await tools.SourceQuery({source:"test",query:{}});
return {status:facts.ready ? "triggered" : "pending", reason:facts.ready ? "Supplier confirmed shipment" : "Awaiting shipment", checkpoint:{page:(checkpoint?.page ?? 0)+1}};`,
  input: {},
};
async function eventually(check: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.fail('Observation did not settle');
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'matter-conditions-'));
  let now = 1700000000000;
  let store = createMatterStore(root, { now: () => now });
  const m = store.create({
    cwd: root,
    title: 'Delivery',
    request: 'Wait for shipment confirmation then inspect it',
    sessionId: 'session-test',
  });
  let observer: ReturnType<typeof createMatterObserver> | undefined;
  const errors: unknown[] = [];
  t.after(async () => {
    await observer?.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const clock = { now: () => now, schedule: (_callback: () => void, _delay: number) => () => {} };
  const f = {
    m,
    root,
    errors,
    get store() {
      return store;
    },
    now: () => now,
    advance(ms: number) {
      now += ms;
      store.lease('owner', now + 3600000);
    },
    async reopen() {
      await observer?.close();
      observer = undefined;
      store.close();
      store = createMatterStore(root, { now: () => now });
      store.recover();
    },
    settle(code: ConditionDefinition = definition, fallback = 60000) {
      const active = store.claim(m.id)!.matter;
      store.bindTurn(m.id, active.activation!.id, 'turn-test');
      const live = store.get(m.id).matter;
      const tested = store.conditions.saveTest(m.id, code, {
        status: 'pending',
        reason: 'tested',
        evidence: [],
      });
      const input: MatterSettleInput = {
        expectedRevision: live.revision,
        stateText: 'Waiting for actual shipment',
        disposition: 'wait',
        reason: 'Supplier has not shipped',
        summary: 'Checked supplier',
        waitingFor: 'Shipment confirmed',
        wakes: [{ kind: 'at', at: now + fallback }],
        condition: { checkerId: tested.id, intervalMs: 1000 },
      };
      const settled = store.settle(m.id, live.activation!.id, input, 'settle-test');
      return { active: live, input, settled, id: settled.conditionWaitId! };
    },
    async start(read: (name: string, args: unknown, signal: AbortSignal) => Promise<unknown>) {
      store.lease('owner', now + 3600000);
      observer = createMatterObserver({} as any, store, 'owner', (e) => errors.push(e), {
        clock,
        reader: () => read,
        policy: { jitterRatio: 0, minIntervalMs: 1, pollIntervalMs: 1, readTimeoutMs: 1000 },
      });
      await observer.start();
      return observer;
    },
  };
  return f;
}

test('checker executes real sandbox code, returns evidence and persists its checkpoint', async () => {
  const result = await runCondition(
    definition,
    { page: 2 },
    async () => ({ ready: true }),
    new AbortController().signal,
  );
  assert.equal(result.status, 'triggered');
  assert.equal(result.checkpoint?.page, 3);
  for (const code of [
    'return process.env',
    'return await import("node:fs")',
    'return await tools.Shell({command:"true"})',
    'return {status:"complete",reason:"bad"}',
  ]) {
    await assert.rejects(
      runCondition({ code, input: {} }, null, async () => ({}), new AbortController().signal),
    );
  }
});

test('failed source permission cannot be caught by checker code and mistaken for satisfaction', async () => {
  await assert.rejects(
    runCondition(
      {
        code: 'try { await tools.SourceQuery({}); } catch {} return {status:"triggered",reason:"no permission"}',
        input: {},
      },
      null,
      async () => {
        throw new Error('permission denied');
      },
      new AbortController().signal,
    ),
    /permission denied/,
  );
});

test('source query authorization filters fail closed and raw reads recheck permissions', async () => {
  let authorized = 0,
    reads = 0;
  const ctx: any = {
    agents: { withInvocation: (_i: any, fn: any) => fn() },
    sources: {
      query: async () => ({ items: [{ id: 'secret' }] }),
      authorize: async () => {
        authorized++;
        return [];
      },
      read: async () => {
        reads++;
        throw Error('denied');
      },
    },
  };
  const reader = conditionReader(ctx, { sessionId: 's', cwd: '.', turnId: 't', toolCallId: 'c' });
  await assert.rejects(
    reader('SourceQuery', { source: 'test' }, new AbortController().signal),
    /permission/,
  );
  assert.equal(authorized, 1);
  assert.equal(reads, 0);
});

test('test tool pins code to this matter and testing alone does not register a wait', async (t) => {
  const f = fixture(t),
    active = f.store.claim(f.m.id)!.matter;
  f.store.bindTurn(f.m.id, active.activation!.id, 'turn-test');
  const tools = buildMatterTools({
    store: f.store,
    changed() {},
    review: async () => ({ approved: true, feedback: 'ok' }),
    testCondition: (d, c) => runCondition(d, null, async () => ({ ready: false }), c.abortSignal),
  });
  const tool = tools.find((t) => t.name === 'MatterConditionTest')!;
  const ctx: any = {
    sessionId: f.m.sessionId,
    turnId: 'turn-test',
    toolCallId: 'test',
    cwd: f.root,
    abortSignal: new AbortController().signal,
  };
  const result: any = await tool.impl(definition, ctx);
  assert.equal(result.result.status, 'pending');
  assert.equal(result.waiting, false);
  assert.equal(f.store.get(f.m.id).matter.conditionWaitId, undefined);
  assert.throws(() => f.store.conditions.checker(result.checkerId, 'another-matter'), /tested/);
  const changed: any = await tool.impl(
    { ...definition, code: definition.code + '\n// revision' },
    ctx,
  );
  assert.notEqual(result.checkerId, changed.checkerId);
});

test('condition is installed atomically, never observed during active settlement; triggers one normal activation', async (t) => {
  const f = fixture(t),
    w = f.settle();
  let reads = 0;
  const observer = await f.start(async () => {
    reads++;
    return { ready: true };
  });
  assert.equal(reads, 0);
  f.store.finish(f.m.id, w.active.activation!.id);
  await observer.reconcile();
  await eventually(() => f.store.get(f.m.id).events.some((e) => e.source === 'condition'));
  assert.equal(reads, 1);
  await observer.reconcile();
  f.advance(60000);
  f.store.enqueueDue();
  const snapshot = f.store.get(f.m.id);
  assert.equal(snapshot.events.length, 1);
  assert.match(snapshot.events[0]!.text, /Supplier confirmed shipment/);
  const active = f.store.claim(f.m.id)!;
  assert.equal(active.matter.status, 'active');
  assert.equal(active.matter.conditionWaitId, null);
  assert.deepEqual(active.matter.wakes, []);
  assert.equal(f.store.claim(f.m.id), null);
  assert.deepEqual(f.errors, []);
});

test('pending cursor survives restart and uses the configured interval without model calls', async (t) => {
  const f = fixture(t),
    w = f.settle();
  f.store.finish(f.m.id, w.active.activation!.id);
  const observer = await f.start(async () => ({ ready: false }));
  await eventually(() => f.store.conditions.read(w.id)?.record.observation?.outcome === 'pending');
  assert.equal(f.store.conditions.read(w.id)!.record.observation?.cursor, '{"page":1}');
  assert.equal(f.store.conditions.read(w.id)!.record.observation?.nextPollAt, f.now() + 1000);
  await f.reopen();
  f.advance(1001);
  await f.start(async () => ({ ready: false }));
  await eventually(
    () => f.store.conditions.read(w.id)?.record.observation?.cursor === '{"page":2}',
  );
  assert.deepEqual(f.errors, []);
});

test('fallback and late source response cannot deliver two wakes', async (t) => {
  const f = fixture(t),
    w = f.settle(definition, 1000);
  f.store.finish(f.m.id, w.active.activation!.id);
  let resolve!: (x: unknown) => void,
    started = false;
  await f.start(async () => {
    started = true;
    return new Promise((r) => (resolve = r));
  });
  await eventually(() => started);
  f.advance(1000);
  f.store.enqueueDue();
  resolve({ ready: true });
  await delay(100);
  f.store.enqueueDue();
  assert.equal(f.store.get(f.m.id).events.length, 1);
  assert.equal(f.store.conditions.read(w.id)?.record.status, 'expired');
  assert.equal(f.store.get(f.m.id).matter.status, 'waiting');
  assert.equal(f.store.claim(f.m.id)?.matter.status, 'active');
});

for (const action of ['cancel', 'pause', 'message'] as const)
  test(`${action} fences in-flight result and its fallback`, async (t) => {
    const f = fixture(t),
      w = f.settle();
    f.store.finish(f.m.id, w.active.activation!.id);
    let resolve!: (x: unknown) => void,
      started = false;
    await f.start(async () => {
      started = true;
      return new Promise((r) => (resolve = r));
    });
    await eventually(() => started);
    if (action === 'message')
      f.store.ingest(f.m.id, {
        key: 'new',
        source: 'user',
        text: 'Do not wait for shipment any more',
      });
    else f.store.control(f.m.id, action);
    resolve({ ready: true });
    await delay(100);
    f.advance(60000);
    f.store.enqueueDue();
    assert.equal(
      f.store.get(f.m.id).events.filter((e) => e.source === 'condition' || e.source === 'time')
        .length,
      0,
    );
    assert.equal(f.store.conditions.read(w.id)?.record.status, 'cancelled');
  });

test('repeated failures wake the worker for repair instead of pausing the task', async (t) => {
  const f = fixture(t),
    w = f.settle();
  f.store.finish(f.m.id, w.active.activation!.id);
  const observer = await f.start(async () => {
    throw Error('source temporarily unavailable');
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await eventually(() => {
      const r = f.store.conditions.read(w.id)!.record;
      return (
        r.status === 'resolved' ||
        (r.observation?.outcome === 'unknown' && r.observation.attempts === attempt)
      );
    });
    if (attempt < 3) {
      f.advance(5000);
      await observer.reconcile();
    }
  }
  const r = f.store.conditions.read(w.id)!.record;
  assert.equal(r.status, 'resolved');
  if (r.status === 'resolved') assert.equal(r.resolution.outcome, 'source_unavailable');
  assert.equal(f.store.get(f.m.id).matter.status, 'waiting');
  assert.equal(f.store.get(f.m.id).events.length, 1);
});

test('a failed check recovers without consuming its checkpoint; waiting remains until fallback', async (t) => {
  const f = fixture(t),
    w = f.settle();
  f.store.finish(f.m.id, w.active.activation!.id);
  let fail = true;
  const observer = await f.start(async () => {
    if (fail) throw Error('network');
    return { ready: false };
  });
  await eventually(() => f.store.conditions.read(w.id)?.record.observation?.outcome === 'unknown');
  assert.equal(f.store.conditions.read(w.id)?.record.observation?.cursor, null);
  fail = false;
  f.advance(5000);
  await observer.reconcile();
  await eventually(() => f.store.conditions.read(w.id)?.record.observation?.outcome === 'pending');
  assert.equal(f.store.conditions.read(w.id)?.record.observation?.consecutiveErrors, 0);
  f.advance(60000);
  f.store.enqueueDue();
  assert.equal(f.store.get(f.m.id).events.length, 1);
});

test('approved wait whose fallback passed during review is accepted then expires after finish', (t) => {
  const f = fixture(t);
  let active = f.store.claim(f.m.id)!.matter;
  active = f.store.bindTurn(f.m.id, active.activation!.id, 'turn-review');
  const checker = f.store.conditions.saveTest(f.m.id, definition, {
    status: 'pending',
    reason: 'tested',
    evidence: [],
  });
  const path = f.store.workspace(f.m.id, active.activation!.id).files.draft;
  f.store.writeDraft(f.m.id, active.activation!.id, path, 'waiting');
  const input: MatterSettleInput = {
    expectedRevision: active.revision,
    stateText: 'waiting',
    disposition: 'wait',
    reason: 'reply needed',
    summary: 'checked',
    waitingFor: 'reply',
    wakes: [{ kind: 'at', at: f.now() + 1000 }],
    condition: { checkerId: checker.id, intervalMs: 1000 },
  };
  const review = f.store.beginReview(f.m.id, active.activation!.id, input, 'op', path);
  f.advance(2000);
  f.store.recordReview(review, { approved: true, feedback: 'ok' });
  const m = f.store.settle(f.m.id, active.activation!.id, input, 'op', review);
  f.store.enqueueDue();
  assert.equal(f.store.get(f.m.id).events.length, 0);
  f.store.finish(f.m.id, active.activation!.id);
  f.store.enqueueDue();
  assert.equal(f.store.conditions.read(m.conditionWaitId!)?.record.status, 'expired');
  assert.equal(f.store.get(f.m.id).events.length, 1);
});

test('Matter conditions produce neutral observation records', (t) => {
  const f = fixture(t),
    w = f.settle(),
    record = f.store.conditions.read(w.id)!.record;
  assert.deepEqual(decodeEventWaitRecord(record), record);
});

test('unapproved or stale review cannot install a checker; rejected settlement is atomic', (t) => {
  const f = fixture(t);
  let active = f.store.claim(f.m.id)!.matter;
  active = f.store.bindTurn(f.m.id, active.activation!.id, 'review-turn');
  const checker = f.store.conditions.saveTest(f.m.id, definition, {
    status: 'pending',
    reason: 'tested',
    evidence: [],
  });
  const path = f.store.workspace(f.m.id, active.activation!.id).files.draft;
  f.store.writeDraft(f.m.id, active.activation!.id, path, 'waiting');
  const input: MatterSettleInput = {
    expectedRevision: active.revision,
    stateText: 'waiting',
    disposition: 'wait',
    reason: 'reply needed',
    summary: 'checked',
    waitingFor: 'reply',
    wakes: [{ kind: 'at', at: f.now() + 1000 }],
    condition: { checkerId: checker.id, intervalMs: 1000 },
  };
  const review = f.store.beginReview(f.m.id, active.activation!.id, input, 'op', path);
  f.store.recordReview(review, { approved: false, feedback: 'Need more evidence' });
  assert.throws(
    () => f.store.settle(f.m.id, active.activation!.id, input, 'op', review),
    /approval/,
  );
  assert.equal(f.store.get(f.m.id).matter.conditionWaitId, undefined);
  const next = f.store.beginReview(f.m.id, active.activation!.id, input, 'next', path);
  f.store.ingest(f.m.id, {
    key: 'amend',
    source: 'user',
    text: 'Actually wait for the second shipment',
  });
  assert.throws(
    () => f.store.recordReview(next, { approved: true, feedback: 'ok' }),
    /INVALIDATED/,
  );
  assert.equal(f.store.get(f.m.id).matter.status, 'active');
  assert.throws(
    () =>
      f.store.settle(
        f.m.id,
        active.activation!.id,
        { ...input, condition: { checkerId: 'untested', intervalMs: 1000 } },
        'bad',
      ),
    /tested/,
  );
  assert.equal(f.store.get(f.m.id).matter.activation?.settled, false);
});

test('lost owner lease fences late result; new owner can continue the persisted wait', async (t) => {
  const f = fixture(t),
    w = f.settle();
  f.store.finish(f.m.id, w.active.activation!.id);
  f.store.lease('owner', f.now() + 1000);
  const writer = f.store.conditions.observationStore('owner');
  const before = f.store.conditions.read(w.id)!;
  f.store.releaseLease('owner');
  f.store.lease('next-owner', f.now() + 10000);
  await assert.rejects(
    writer.commit({
      sessionId: f.m.sessionId,
      waitId: w.id,
      expectedAuthorityRevision: before.authorityRevision,
      record: before.record,
    }),
    /lease/,
  );
  assert.equal(f.store.get(f.m.id).events.length, 0);
  const next = f.store.conditions.observationStore('next-owner');
  assert.equal((await next.listForObservation({ now: f.now(), limit: 1 })).length, 1);
});

test('simultaneous independent matter waits share observer capacity without running Agents', async (t) => {
  const f = fixture(t),
    a = f.settle();
  f.store.finish(f.m.id, a.active.activation!.id);
  const b = f.store.create({
    cwd: f.root,
    title: 'Second',
    request: 'Watch another shipment',
    sessionId: 'second-session',
  });
  let active = f.store.claim(b.id)!.matter;
  active = f.store.bindTurn(b.id, active.activation!.id, 'second-turn');
  const checker = f.store.conditions.saveTest(b.id, definition, {
    status: 'pending',
    reason: 'tested',
    evidence: [],
  });
  f.store.settle(
    b.id,
    active.activation!.id,
    {
      ...a.input,
      expectedRevision: active.revision,
      condition: { checkerId: checker.id, intervalMs: 1000 },
    },
    'second-settle',
  );
  f.store.finish(b.id, active.activation!.id);
  let concurrent = 0,
    peak = 0;
  const releases: (() => void)[] = [];
  await f.start(async () => {
    concurrent++;
    peak = Math.max(peak, concurrent);
    await new Promise<void>((r) => releases.push(r));
    concurrent--;
    return { ready: true };
  });
  await eventually(() => releases.length === 2);
  releases.forEach((r) => r());
  await eventually(
    () => f.store.get(f.m.id).events.length === 1 && f.store.get(b.id).events.length === 1,
  );
  assert.equal(peak, 2);
  assert.deepEqual(f.errors, []);
});

test('a long absolute fallback is accepted without imposing an Agent execution deadline', async (t) => {
  const f = fixture(t),
    w = f.settle(definition, 100 * 86400000);
  f.store.finish(f.m.id, w.active.activation!.id);
  await f.start(async () => ({ ready: false }));
  await eventually(() => f.store.conditions.read(w.id)?.record.observation?.outcome === 'pending');
  assert.equal(f.store.get(f.m.id).events.length, 0);
  assert.deepEqual(f.errors, []);
});

test('presets use the same read-only runner and reject ambiguous custom definitions', async () => {
  assert.throws(
    () => normalizeCondition({ code: 'return {}', preset: 'source-appeared', input: {} }),
    /either/,
  );
  const preset = normalizeCondition({
    preset: 'source-appeared',
    input: { source: 'test', query: { status: 'done' } },
  });
  const result = await runCondition(
    preset,
    null,
    async (name, args) => {
      assert.equal(name, 'SourceQuery');
      assert.deepEqual(args, { source: 'test', query: { status: 'done' } });
      return { items: [{ id: 'matched-object' }] };
    },
    new AbortController().signal,
  );
  assert.equal(result.status, 'triggered');
  assert.deepEqual(result.evidence, ['matched-object']);
  const session = normalizeCondition({
    preset: 'session-revision',
    input: { id: 'another-session', revision: 'old' },
  });
  assert.equal(
    (
      await runCondition(
        session,
        null,
        async () => ({ session: { historyRevision: 'new' } }),
        new AbortController().signal,
      )
    ).status,
    'triggered',
  );
});

test('new input after settlement but before runtime completion retires the old condition', (t) => {
  const f = fixture(t),
    w = f.settle();
  f.store.ingest(f.m.id, { key: 'late', source: 'user', text: 'Wait for a different shipment' });
  assert.equal(f.store.conditions.read(w.id)?.record.status, 'cancelled');
  f.store.finish(f.m.id, w.active.activation!.id);
  f.advance(60000);
  f.store.enqueueDue();
  assert.equal(f.store.get(f.m.id).events.length, 1);
  assert.equal(f.store.get(f.m.id).events[0]!.source, 'user');
});
