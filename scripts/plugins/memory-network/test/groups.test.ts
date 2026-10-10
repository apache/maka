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
async function until(fn: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await sleep(10);
  }
  throw Error('worker timeout');
}
function members(prompt: string) {
  return JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
}
async function checkpoint(f: any, session: string, id: string, complete: boolean) {
  const s = await f.invokeAs(session, 'MemoryIndexRead', { indexId: id });
  return f.invokeAs(session, 'MemoryIndexCheckpoint', {
    indexId: id,
    rangeId: s.range.rangeId,
    expectedRevision: s.index.revision,
    notes: 'Organized according to this criterion',
    complete,
  });
}

test('one group uses one Agent; independent checkpoints, numbers and complete=false continuation', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  const sessions = new Set();
  let turns = 0;
  let ids: string[] = [];
  f.setWorkerRunner(async (session, prompt) => {
    sessions.add(session);
    turns++;
    const list = members(prompt);
    if (turns === 1) {
      ids = list.map((x: any) => x.indexId);
      assert.deepEqual(
        list.map((x: any) => x.number),
        [8, 2],
      );
      await checkpoint(f, session, ids[1], true);
      await checkpoint(f, session, ids[0], false);
      const second = await f.invokeAs(session, 'MemoryIndexRead', { indexId: ids[1] });
      assert.ok(second.coverage.cursor);
      assert.equal(
        (await f.invokeAs(session, 'MemoryIndexRead', { indexId: ids[0] })).coverage.cursor,
        null,
      );
      f.sessions.get('chat-a')!.push({ id: 'new', type: 'user', text: 'arrived during work' });
    } else {
      assert.deepEqual(
        list.map((x: any) => x.indexId),
        [ids[0]],
      );
      await checkpoint(f, session, ids[0], true);
    }
  });
  const range = await f.invoke('MemoryRange', {});
  const group = await f.invoke('MemoryIndexCreateGroup', {
    cursor: range.to,
    indexes: [
      { number: 8, name: 'Events', instructions: 'All events' },
      { number: 2, name: 'Profile', instructions: 'Only preferences' },
    ],
    background: false,
  });
  assert.equal(sessions.size, 1);
  assert.equal(f.workers.size, 1);
  assert.equal(turns, 2);
  assert.ok(
    group.result.members.every((x: any) => x.coverage.cursor === range.to && x.range.completed),
  );
  const db = new DatabaseSync(join(f.root, 'data/network.sqlite'));
  t.after(() => db.close());
  const bindings = db
    .prepare('SELECT payload FROM workers')
    .all()
    .map((r) => JSON.parse(String(r.payload)));
  assert.deepEqual(
    bindings.map((b) => b.groupNumber),
    [8, 2],
  );
  assert.ok(bindings.every((b) => b.groupMembers.length === 2));
  assert.equal(
    (
      await f.invoke('MemoryHistory', {
        from: range.to,
        to: (await f.invoke('MemoryIndexRead', { indexId: ids[0] })).freshness.observedCursor,
        mode: 'messages',
      })
    ).items.length,
    1,
  );
});

test('group capacity counts one, duplicate member maintain reuses, excess creation returns IDs and explicit retry works', async (t) => {
  const f = await fixture(false, { maxConcurrentJobs: 1, tickMs: 10 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  t.after(async () => {
    release();
    await f.close();
  });
  f.setWorkerRunner(async (session, prompt) => {
    await gate;
    const list = prompt.startsWith('Organize these')
      ? members(prompt)
      : [{ indexId: /Organize index ([^. ]+)/.exec(prompt)![1] }];
    for (const x of list) await checkpoint(f, session, x.indexId, true);
  });
  const range = await f.invoke('MemoryRange', {});
  const group = await f.invoke('MemoryIndexCreateGroup', {
    cursor: range.to,
    indexes: [
      { number: 1, name: 'A', instructions: 'a' },
      { number: 2, name: 'B', instructions: 'b' },
    ],
  });
  assert.equal(group.job.status, 'started');
  const reused = await f.invoke('MemoryIndexMaintain', {
    indexId: group.members[1].indexId,
    background: true,
  });
  assert.equal(reused.job.status, 'reused');
  const extra = await f.invoke('MemoryIndexCreate', {
    name: 'C',
    instructions: 'c',
    cursor: range.to,
    background: true,
  });
  assert.equal(extra.job.status, 'capacity');
  assert.equal(extra.job.indexId, extra.index.id);
  assert.equal(extra.maintenance.running, false);
  release();
  await until(
    async () =>
      !(await f.invoke('MemoryIndexRead', { indexId: group.members[0].indexId })).maintenance
        .running,
  );
  assert.equal(
    (await f.invoke('MemoryIndexRead', { indexId: extra.index.id })).coverage.cursor,
    null,
  );
  const retried = await f.invoke('MemoryIndexMaintain', { indexId: extra.index.id });
  assert.equal(retried.range.completed, true);
});

test('restart retains group session, numbering and completed members; paused members do not auto-run', async (t) => {
  const f = await fixture(false, { maxConcurrentJobs: 1, tickMs: 10 });
  t.after(() => f.close());
  let groupSession = '',
    turns = 0;
  f.setWorkerRunner(async (session, prompt) => {
    turns++;
    groupSession = session;
    const list = members(prompt);
    await checkpoint(f, session, list[0].indexId, true);
    await checkpoint(f, session, list[1].indexId, false);
    f.workers.get(session)!.status = 'aborted';
  });
  const range = await f.invoke('MemoryRange', {});
  const created = await f.invoke('MemoryIndexCreateGroup', {
    cursor: range.to,
    indexes: [
      { number: 1, name: 'A', instructions: 'a' },
      { number: 2, name: 'B', instructions: 'b' },
    ],
    background: false,
  });
  const [a, b] = created.members.map((x: any) => x.indexId);
  for (const indexId of [a, b]) await f.invoke('MemoryIndexControl', { indexId, action: 'pause' });
  const revision = (await f.invoke('MemoryIndexRead', { indexId: a })).index.revision;
  f.workers.get(groupSession)!.status = 'active';
  f.setWorkerRunner(async (session, prompt) => {
    turns++;
    assert.equal(session, groupSession);
    const list = members(prompt);
    assert.deepEqual(
      list.map((x: any) => x.indexId),
      [b],
    );
    await checkpoint(f, session, b, true);
  });
  // Package reload creates a new controller against the same persisted workers/ranges.
  const { resolve } = await import('node:path');
  await f.platform.installPackage(resolve('release/memory-network.maka-extension'));
  await sleep(30);
  assert.equal(turns, 1);
  const done = await f.invoke('MemoryIndexMaintain', { indexId: b });
  assert.ok(done.members.every((x: any) => x.range.completed));
  assert.equal((await f.invoke('MemoryIndexRead', { indexId: a })).index.revision, revision);
  assert.equal(
    (await f.invoke('MemoryIndexRead', { indexId: a })).freshness.maintenanceEnabled,
    false,
  );
});

test('group rejects duplicate members/numbers and mismatched scopes before creating workers', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  const range = await f.invoke('MemoryRange', {});
  await assert.rejects(
    f.invoke('MemoryIndexCreateGroup', {
      cursor: range.to,
      indexes: [
        { number: 1, name: 'A', instructions: 'a' },
        { number: 1, name: 'B', instructions: 'b' },
      ],
    }),
    /Duplicate/,
  );
  assert.equal(f.workers.size, 0);
});

test('compact list omits internal structures but includes coverage, errors and navigation', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  const range = await f.invoke('MemoryRange', {});
  const created = await f.invoke('MemoryIndexCreate', {
    name: 'A',
    instructions: 'Summarize events',
    cursor: range.to,
  });
  const [entry] = await f.invoke('MemoryIndexList', {});
  assert.equal(entry.id, created.index.id);
  assert.equal(entry.instructions, 'Summarize events');
  for (const key of ['range', 'coverage', 'view', 'sessions', 'revision', 'sources'])
    assert.equal(entry[key], undefined);
  assert.equal(entry.freshness.knownPending.meaning, undefined);
  assert.equal(entry.freshness.coveredCursor, range.to);
  assert.equal(entry.read.tool, 'MemoryIndexRead');
  assert.match(entry.freshness.notice, /不是价值或推荐条件/);
  assert.match(entry.freshness.notice, /没有增量不代表/);
});

test('existing indexes can join one group without replacing their criteria or contents', async (t) => {
  const f = await fixture(false);
  t.after(() => f.close());
  const range = await f.invoke('MemoryRange', {});
  const old = await f.invoke('MemoryIndexCreate', {
    name: 'Existing',
    instructions: 'Keep events',
    cursor: range.to,
  });
  const before = await f.invoke('MemoryIndexContent', { indexId: old.index.id, view: 'full' });
  f.setWorkerRunner(async (session, prompt) => {
    for (const x of members(prompt)) await checkpoint(f, session, x.indexId, true);
  });
  const group = await f.invoke('MemoryIndexCreateGroup', {
    cursor: range.to,
    indexes: [
      { number: 5, indexId: old.index.id },
      { number: 9, name: 'New', instructions: 'Only preferences' },
    ],
    background: false,
  });
  assert.equal(group.result.members[0].index.instructions, 'Keep events');
  assert.deepEqual(
    (await f.invoke('MemoryIndexContent', { indexId: old.index.id, view: 'full' })).items,
    before.items,
  );
  assert.ok(group.result.members.every((x: any) => x.range.completed));
});

test('invalid concurrency bounds are rejected by plugin configuration', async () => {
  const { default: plugin } = await import('../src/host.js');
  for (const maxConcurrentJobs of [0, 6, 1.5])
    await assert.rejects(
      plugin.host.apply({ maka: { rootId: 'profile' } }, { maxConcurrentJobs }),
      /maxConcurrentJobs/,
    );
});
