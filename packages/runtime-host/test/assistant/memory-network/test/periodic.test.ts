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

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fixture } from './host-fixture.js';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => Promise<boolean>) {
  for (let n = 0; n < 150; n++) {
    if (await check()) return;
    await sleep(20);
  }
  throw Error('Timed out waiting for lifecycle');
}
async function setup(t: any, config: any = {}) {
  const f = await fixture({ tickMs: 10, retryMs: 999999, ...config });
  const range = await f.invoke('MemoryRange', {});
  const first = await f.invoke('MemoryIndexCreate', {
    name: 'Candidate Todo',
    instructions: 'Keep only unfinished tasks and cite originals',
    cursor: range.to,
  });
  const id = first.index.id,
    db = new DatabaseSync(join(f.root, 'data/network.sqlite'));
  t.after(async () => {
    db.close();
    await f.close();
  });
  const worker = () =>
    JSON.parse(String(db.prepare('select payload from workers where index_id=?').get(id)!.payload));
  const patch = (x: any) =>
    db
      .prepare('update workers set payload=? where index_id=?')
      .run(JSON.stringify({ ...worker(), ...x }), id);
  const read = () => f.invoke('MemoryIndexRead', { indexId: id });
  return { f, first, id, db, worker, patch, read };
}
test('all index reads refresh observations without organizing or consuming incremental history', async (t) => {
  const { f, first, id, read } = await setup(t, { threshold: 1 });
  assert.equal(first.freshness.intervalMs, 43200000);
  const reads = f.reads.length;
  let modelCalls = 0;
  f.setBeforeWorker(async () => {
    modelCalls++;
  });
  const entryPoints = [
    read,
    async () => (await f.invoke('MemoryIndexList', {})).find((x: any) => x.id === id),
    () => f.invoke('MemoryIndexContent', { indexId: id }),
    () => f.invoke('MemoryIndexContent', { indexId: id, key: 'vendor' }),
  ];
  for (const [i, entryPoint] of entryPoints.entries()) {
    const message = { id: `new-${i}`, type: 'user', text: `New update ${i}` };
    if (i === 1) f.sessions.set('new-session', [message]);
    else f.sessions.get('chat-b')!.push(message);
    await sleep(30);
    if (i === 0) assert.equal(f.reads.length, reads, 'scheduler does not scan before its due time');
    const observed = await entryPoint();
    assert.equal(observed.freshness.coveredCursor, first.coverage.cursor);
    assert.notEqual(observed.freshness.observedCursor, first.coverage.cursor);
    assert.equal(observed.freshness.lastOrganizedAt, first.freshness.lastOrganizedAt);
    assert.equal(observed.freshness.status, 'pending');
    assert.match(observed.freshness.notice, /索引读取会自动刷新来源范围/);
    assert.ok(observed.freshness.notice.includes(`coveredCursor="${first.coverage.cursor}"`));
    const request = {
      from: observed.freshness.coveredCursor,
      to: observed.freshness.observedCursor,
      mode: 'messages',
    };
    const delta = await f.invoke('MemoryHistory', request);
    assert.equal(delta.items.length, i + 1);
    assert.deepEqual((await f.invoke('MemoryHistory', request)).items, delta.items);
    const again = await entryPoint();
    assert.deepEqual(again.freshness.knownPending, observed.freshness.knownPending);
    assert.equal(again.freshness.observedCursor, observed.freshness.observedCursor);
    assert.equal((await read()).index.revision, first.index.revision);
  }
  assert.equal(modelCalls, 0);
  const content = await f.invoke('MemoryIndexContent', { indexId: id, key: 'vendor' });
  assert.ok(!content.text.includes('New update'));
});
test('no-change maintenance reviews time but need not rewrite valid content; reads remain model-free', async (t) => {
  const { f, first, id, patch, read } = await setup(t);
  let calls = 0;
  f.setWorkerRunner(async (worker, prompt) => {
    calls++;
    assert.match(prompt, /Current UTC:/);
    assert.match(prompt, /even when the source delta is empty/);
    const info = await f.invokeAs(worker, 'MemoryIndexRead', { indexId: id });
    assert.equal(info.range.from, first.coverage.cursor);
    assert.equal(info.range.to, first.coverage.cursor);
    assert.notEqual(info.range.rangeId, first.range.rangeId);
    await f.invokeAs(worker, 'MemoryIndexCheckpoint', {
      indexId: id,
      rangeId: info.range.rangeId,
      expectedRevision: info.index.revision,
      complete: true,
      notes: 'Still valid at current time; no rewrite needed',
    });
  });
  await sleep(15);
  await read();
  assert.equal(calls, 0);
  patch({ nextCheckAt: 0 });
  await until(async () => {
    const x = await read();
    return !x.maintenance.running && x.freshness.lastOrganizedAt > first.freshness.lastOrganizedAt;
  });
  const after = await read();
  assert.equal(after.freshness.observedCursor, first.coverage.cursor);
  assert.equal(after.coverage.cursor, first.coverage.cursor);
  assert.equal(calls, 1);
  assert.equal(after.index.revision, first.index.revision);
  await sleep(35);
  assert.equal(calls, 1, 'not due again');
  await f.invoke('MemoryIndexMaintain', { indexId: id });
  assert.equal(calls, 2, 'manual maintenance also reviews unchanged data');
});

for (const days of [1, 7])
  test(`last ${days} day index expires content when only time advances`, async (t) => {
    const start = Date.parse('2026-10-01T10:00:00Z');
    t.mock.timers.enable({ apis: ['Date'], now: start });
    const f = await fixture({ tickMs: 10, intervalMs: 43200000 });
    t.after(() => f.close());
    f.sessions.clear();
    f.sessions.set('window', [{ id: 'event', type: 'user', ts: start, text: 'Package delivered' }]);
    let calls = 0,
      id = '',
      ref = '';
    f.setWorkerRunner(async (worker, prompt) => {
      calls++;
      id = /Organize index ([^. ]+)/.exec(prompt)![1];
      assert.ok(prompt.includes(`Current UTC: ${new Date().toISOString()}`));
      const info = await f.invokeAs(worker, 'MemoryIndexRead', { indexId: id });
      const delta = await f.invokeAs(worker, 'MemoryHistory', {
        from: info.range.from,
        to: info.range.to,
        mode: 'messages',
      });
      if (calls === 1) ref = delta.items[0].ref;
      else {
        assert.equal(delta.items.length, 0);
        assert.equal(info.range.from, info.range.to);
        const existing = await f.invokeAs(worker, 'MemoryIndexContent', {
          indexId: id,
          key: 'window',
        });
        assert.match(existing.text, /Package delivered/);
      }
      // Controlled Agent uses the supplied clock, with no edits to source data.
      const now = Date.parse(/Current UTC: ([^ ]+)/.exec(prompt)![1].slice(0, -1));
      const written = await f.invokeAs(worker, 'MemoryIndexWrite', {
        indexId: id,
        key: 'window',
        expectedRevision: info.index.revision,
        text:
          now - start <= days * 86400000
            ? `Package delivered [original](memory-original:${ref})`
            : '',
      });
      await f.invokeAs(worker, 'MemoryIndexCheckpoint', {
        indexId: id,
        rangeId: info.range.rangeId,
        expectedRevision: written.revision,
        complete: true,
        notes: 'Applied rolling time window',
      });
    });
    const range = await f.invoke('MemoryRange', {});
    const first = await f.invoke('MemoryIndexCreate', {
      name: `Last ${days} days`,
      instructions: `Only events in the last ${days} days`,
      cursor: range.to,
    });
    assert.equal(first.contents.total, 1);
    t.mock.timers.tick((days + 1) * 86400000);
    await until(async () => {
      const info = await f.invoke('MemoryIndexRead', { indexId: id });
      return calls === 2 && !info.maintenance.running && info.range.completed;
    });
    const last = await f.invoke('MemoryIndexRead', { indexId: id });
    assert.equal(last.contents.total, 0);
    assert.equal(last.coverage.cursor, first.coverage.cursor);
    assert.equal(last.freshness.observedCursor, first.coverage.cursor);
    assert.ok(last.freshness.lastOrganizedAt > first.freshness.lastOrganizedAt);
    assert.ok(await f.invoke('MemoryOriginal', { ref }), 'original survives index expiration');
  });

test('timer corrects old task, retains mid-run arrivals, and does not duplicate a running worker', async (t) => {
  const { f, first, id, patch, read } = await setup(t);
  let calls = 0,
    release!: () => void,
    entered!: () => void;
  const gate = new Promise<void>((r) => (release = r)),
    start = new Promise<void>((r) => (entered = r));
  t.after(() => release());
  f.setBeforeWorker(async () => {
    calls++;
    entered();
    await gate;
  });
  f.sessions.get('chat-b')!.push({
    id: 'done',
    type: 'user',
    text: 'Vendor contacted yesterday. No further contact needed.',
  });
  patch({ nextCheckAt: 0 });
  await Promise.race([
    start,
    sleep(2500).then(() => {
      throw Error('not scheduled');
    }),
  ]);
  const during = await read();
  assert.equal(during.freshness.status, 'updating');
  assert.equal(during.freshness.partialUpdate, true);
  assert.equal(during.coverage.cursor, first.coverage.cursor);
  f.sessions
    .get('chat-b')!
    .push({ id: 'later', type: 'user', text: 'A new separate issue after this round began' });
  await sleep(50);
  assert.equal(calls, 1);
  release();
  await until(async () => !(await read()).maintenance.running);
  const done = await read();
  assert.equal(done.contents.total, 0);
  assert.notEqual(done.coverage.cursor, first.coverage.cursor);
  const next = await f.invoke('MemoryRange', { indexId: id });
  const delta = await f.invoke('MemoryHistory', {
    from: next.from,
    to: next.to,
    mode: 'messages',
  });
  assert.deepEqual(
    delta.items.map((x: any) => x.message.id),
    ['later'],
  );
});
test('failed source scan preserves coverage and last observation; retry then organizes the retained delta', async (t) => {
  const { f, first, id, patch, read } = await setup(t);
  f.sessions.get('chat-b')!.push({ id: 'new', type: 'user', text: 'A new update' });
  f.setHistoryError(true);
  patch({ nextCheckAt: 0 });
  await until(async () => !!(await read()).freshness.lastCheckError);
  const failed = await read();
  assert.equal(failed.freshness.status, 'check_failed');
  assert.equal(failed.freshness.knownPending, null);
  assert.equal(failed.freshness.observedCursor, first.freshness.observedCursor);
  assert.match(failed.freshness.notice, /不能据此判断当前没有增量/);
  assert.equal(failed.coverage.cursor, first.coverage.cursor);
  assert.equal(failed.freshness.lastCheckedAt, first.freshness.lastCheckedAt);
  f.setHistoryError(false);
  patch({ nextCheckAt: 0 });
  await until(async () => {
    const x = await read();
    return !x.maintenance.running && x.coverage.cursor !== first.coverage.cursor;
  });
  assert.equal((await read()).freshness.lastCheckError, null);
});
test('pause and interval survive plugin reload; explicit one-shot maintain does not unpause; resume restores scheduling', async (t) => {
  const { f, id, worker, patch, read } = await setup(t);
  await f.invoke('MemoryIndexControl', { indexId: id, action: 'pause', intervalMs: 123456 });
  const due = worker().nextCheckAt;
  assert.equal(due, null);
  const result = await f.restart({
    'memory-network': { tickMs: 10, intervalMs: 43200000, retryMs: 999999 },
  });

  const paused = await read();
  assert.equal(paused.freshness.maintenanceEnabled, false);
  assert.equal(paused.freshness.intervalMs, 123456);
  assert.equal(paused.freshness.nextCheckAt, null);
  f.sessions.get('chat-b')!.push({ id: 'more', type: 'user', text: 'Vendor contacted yesterday' });
  patch({ nextCheckAt: 0 });
  await sleep(70);
  assert.equal((await read()).maintenance.running, false);
  const one = await f.invoke('MemoryIndexMaintain', { indexId: id });
  assert.equal(one.contents.total, 0);
  assert.equal(one.freshness.maintenanceEnabled, false);
  const resumed = await f.invoke('MemoryIndexControl', {
    indexId: id,
    action: 'resume',
    intervalMs: 43200000,
  });
  assert.equal(resumed.freshness.maintenanceEnabled, true);
  assert.ok(resumed.freshness.nextCheckAt > Date.now());
});
test('unfinished failed model round resumes the same range after reload, without covering later arrivals', async (t) => {
  const { f, first, id, patch, read } = await setup(t);
  f.sessions.get('chat-b')!.push({ id: 'new', type: 'user', text: 'Required correction' });
  let attempts = 0;
  f.setWorkerRunner(async () => {
    attempts++; /* Simulate a model round ending without committing its range. */
  });
  patch({ nextCheckAt: 0 });
  await until(async () => {
    const x = await read();
    return !x.maintenance.running && !!x.maintenance.lastError;
  });
  const failed = await read();
  assert.equal(failed.freshness.status, 'maintenance_failed');
  assert.match(failed.freshness.lastMaintenanceError, /without completing/);
  assert.equal(failed.coverage.cursor, first.coverage.cursor);
  f.sessions.get('chat-b')!.push({ id: 'later', type: 'user', text: 'Arrived after failure' });
  await f.restart({ 'memory-network': { tickMs: 10, intervalMs: 43200000, retryMs: 999999 } });
  f.setWorkerRunner(async (worker) => {
    attempts++;
    const info = await f.invokeAs(worker, 'MemoryIndexRead', { indexId: id });
    assert.equal(info.range.rangeId, failed.range.rangeId);
    await f.invokeAs(worker, 'MemoryIndexCheckpoint', {
      indexId: id,
      rangeId: info.range.rangeId,
      expectedRevision: info.index.revision,
      notes: 'Recovered exact saved range',
      complete: true,
    });
  });
  patch({ nextCheckAt: 0 });
  await until(async () => {
    const x = await read();
    return !x.maintenance.running && x.range.completed;
  });
  assert.equal(attempts, 2);
  assert.equal((await read()).coverage.cursor, failed.range.to);
  const range = await f.invoke('MemoryRange', { indexId: id });
  const delta = await f.invoke('MemoryHistory', {
    from: range.from,
    to: range.to,
    mode: 'messages',
  });
  assert.deepEqual(
    delta.items.map((x: any) => x.message.id),
    ['later'],
  );
});
test('an unrelated unavailable provider does not block discovery, local indexing, updates or originals; privacy still applies', async (t) => {
  const { f, id, read } = await setup(t);
  let offline = false;
  const object = { id: 'note', locator: { id: 'note' }, revision: 'v1', kind: 'note' };
  f.sources.register({
    id: 'test.unavailable',
    description: 'Unrelated external provider',
    scope: {},
    enumerate: async () => ({ items: [object] }),
    query: async () => ({ items: [object] }),
    authorize: async (objects) => {
      if (offline) throw Error('Provider signed out');
      return objects.map((o) => o.id);
    },
    read: async () => ({ status: 'ok', object, content: 'external note' }),
  });
  await f.invoke('MemoryRange', { sources: ['test.unavailable'] });
  offline = true;
  assert.ok((await f.invoke('MemorySources', {})).some((s: any) => s.id === 'test.unavailable'));
  assert.ok(
    (await f.invoke('MemoryIndexList', {})).some((s: any) => s.id === id && !s.unavailable),
  );
  const range = await f.invoke('MemoryRange', { sources: ['maka'] });
  const history = await f.invoke('MemoryHistory', { to: range.to, mode: 'messages' });
  const original = await f.invoke('MemoryOriginal', { ref: history.items[0].ref });
  assert.ok(original.message);
  const second = await f.invoke('MemoryIndexCreate', {
    name: 'Independent',
    instructions: 'Keep vendor tasks',
    cursor: range.to,
  });
  assert.equal(second.backgroundFinished, true);
  await f.invoke('MemoryIndexMaintain', { indexId: id });
  assert.equal((await read()).maintenance.lastError, undefined);
  await assert.rejects(f.invoke('MemoryRange', { sources: ['test.unavailable'] }), /signed out/);
  f.setIncognito(true);
  await assert.rejects(f.invoke('MemorySources', {}), /Incognito/);
  await assert.rejects(f.invoke('MemoryIndexList', {}), /Incognito/);
  await assert.rejects(f.invoke('MemoryOriginal', { ref: history.items[0].ref }), /Incognito/);
});

test('repeated maintenance failure backs off without changing coverage and resets after recovery', async (t) => {
  const { f, first, id, worker } = await setup(t, { tickMs: 60000, retryMs: 100000 });
  f.sessions.get('chat-b')!.push({ id: 'late', type: 'user', text: 'New evidence' });
  f.setHistoryError(true);
  await f.invoke('MemoryIndexMaintain', { indexId: id });
  const firstRetry = worker();
  assert.equal(firstRetry.failures, 1);
  await f.invoke('MemoryIndexMaintain', { indexId: id });
  const second = worker();
  assert.equal(second.failures, 2);
  assert.ok(second.nextCheckAt > firstRetry.nextCheckAt + 99000);
  assert.equal(
    (await f.invoke('MemoryIndexRead', { indexId: id })).freshness.coveredCursor,
    first.coverage.cursor,
  );
  f.setHistoryError(false);
  await f.invoke('MemoryIndexMaintain', { indexId: id });
  assert.equal(worker().failures, 0);
});
