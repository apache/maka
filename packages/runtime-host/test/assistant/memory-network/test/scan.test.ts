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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorpusStore } from '../../../../src/assistant/memory-network/corpus.js';
import { MemoryController } from '../../../../src/assistant/memory-network/controller.js';
const object = (id: string) => ({ id, revision: 'v1', locator: { id }, kind: 'text' });
function fixture(
  t: any,
  enumerate: any,
  authorize: any = async (_: any, objects: any[]) => objects.map((o) => o.id),
) {
  const root = mkdtempSync(join(tmpdir(), 'memory-scan-'));
  let store = new CorpusStore(root);
  const ctx = {
    sources: { list: () => [{ id: 'external' }], enumerate, authorize },
    sessionQuery: { historyList: async () => [], historySources: () => [] },
  };
  let controller = new MemoryController(ctx, store);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    ctx,
    get store() {
      return store;
    },
    get controller() {
      return controller;
    },
    restart() {
      store.close();
      store = new CorpusStore(root);
      controller = new MemoryController(ctx, store);
    },
  };
}
test('pages survive restart; concurrent scans share work; publication preserves the prior snapshot until final authorization', async (t) => {
  let broken = false,
    reads: string[] = [];
  let first = true;
  let allow = true;
  const f = fixture(
    t,
    async (_: string, cursor?: string) => {
      reads.push(cursor ?? 'first');
      if (first) return { items: [object('old')] };
      if (!cursor) return { items: [object('new')], next: 'page2' };
      if (broken) throw Error('connection lost');
      await new Promise((r) => setTimeout(r, 10));
      return { items: [object('tail')] };
    },
    async (_: string, objects: any[]) => {
      if (!allow) throw Error('permission check failed');
      return objects.map((o) => o.id);
    },
  );
  await f.controller.sync(['external']);
  const before = f.store.db.prepare('SELECT payload FROM memory_source_sets').get()!.payload;
  first = false;
  broken = true;
  await assert.rejects(f.controller.sync(['external']), /connection lost/);
  assert.equal(f.store.db.prepare('SELECT payload FROM memory_source_sets').get()!.payload, before);
  assert.equal(
    f.store.references('external').some((r) => r.object.id === 'new'),
    false,
  );
  f.restart();
  reads = [];
  broken = false;
  allow = false;
  await assert.rejects(
    Promise.all([f.controller.sync(['external']), f.controller.sync(['external'])]),
    /permission/,
  );
  assert.deepEqual(reads, ['page2']);
  assert.equal(f.store.db.prepare('SELECT payload FROM memory_source_sets').get()!.payload, before);
  allow = true;
  reads = [];
  await f.controller.sync(['external']);
  assert.deepEqual(reads, [], 'completed staging only retries authorization');
  assert.notEqual(
    f.store.db.prepare('SELECT payload FROM memory_source_sets').get()!.payload,
    before,
  );
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_source_scans').get()!.n, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_boundaries').get()!.n, 0);
});
test('repeated pagination cursor fails without publishing half a scan', async (t) => {
  const f = fixture(t, async () => ({ items: [object('x')], next: 'same' }));
  await assert.rejects(f.controller.sync(['external']), /repeated/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_source_sets').get()!.n, 0);
});

for (const changed of [
  { startTime: 20, chats: ['a'] },
  { startTime: 10, chats: ['b'] },
]) {
  test(`scope changes discard interrupted staging, not published history: ${JSON.stringify(changed)}`, async (t) => {
    let scope = { startTime: 10, chats: ['a'] };
    let phase = 'initial';
    const cursors: (string | undefined)[] = [];
    const f = fixture(t, async (_: string, cursor?: string) => {
      cursors.push(cursor);
      if (phase === 'initial') return { items: [object('published')] };
      if (phase === 'interrupted') {
        if (cursor) throw Error('network unavailable');
        return { items: [object('stale')], next: 'old-scope-page2' };
      }
      assert.equal(cursor, undefined, 'changed scope must start on page one');
      return { items: [object('current')] };
    });
    f.ctx.sources.list = () => [{ id: 'external', scope }];
    await f.controller.sync(['external']);
    const original = f.store.references('external')[0];
    const old = f.store.capture(['external'], [original.recordKey]);
    phase = 'interrupted';
    await assert.rejects(f.controller.sync(['external']), /network/);
    f.restart();
    scope = changed;
    phase = 'changed';
    cursors.length = 0;
    await f.controller.sync(['external']);
    assert.deepEqual(cursors, [undefined]);
    assert.equal(
      f.store.references('external').some((r) => r.object.id === 'stale'),
      false,
    );
    assert.deepEqual(f.store.reference(original.ref), original);
    assert.deepEqual(f.store.cursor(old.id), old);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM memory_source_scan_items').get()!.n, 0);
    const published = JSON.parse(
      String(f.store.db.prepare('SELECT payload FROM memory_source_sets').get()!.payload),
    );
    assert.deepEqual(published, [JSON.stringify(['external', 'current'])]);
  });
}

test('scope change during final authorization cannot publish old staging; next call rescans', async (t) => {
  let scope = { chats: ['old'] };
  let change = true;
  const reads: any[] = [];
  const f = fixture(
    t,
    async (_: string, cursor?: string) => {
      reads.push(cursor);
      return { items: [object(scope.chats[0])] };
    },
    async (_: string, objects: any[]) => {
      if (change) {
        scope = { chats: ['new'] };
        change = false;
      }
      return objects.map((o) => o.id);
    },
  );
  f.ctx.sources.list = () => [{ id: 'external', scope }];
  await assert.rejects(f.controller.sync(['external']), /scope changed/);
  assert.equal(f.store.references().length, 0);
  await f.controller.sync(['external']);
  assert.deepEqual(reads, [undefined, undefined]);
  assert.deepEqual(
    f.store.references().map((r) => r.object.id),
    ['new'],
  );
});

test('concurrent replacement waits for old scoped I/O without publishing it or duplicating the new scan', async (t) => {
  let scope = { chats: ['old'] };
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const calls: string[] = [];
  const f = fixture(t, async () => {
    const id = scope.chats[0];
    calls.push(id);
    if (id === 'old') await gate;
    return { items: [object(id)] };
  });
  f.ctx.sources.list = () => [{ id: 'external', scope }];
  const old = assert.rejects(f.controller.sync(['external']), /scope changed/);
  scope = { chats: ['new'] };
  const next = f.controller.sync(['external']);
  const duplicate = f.controller.sync(['external']);
  release();
  await Promise.all([old, next, duplicate]);
  assert.deepEqual(calls, ['old', 'new']);
  assert.deepEqual(
    f.store.references().map((r) => r.object.id),
    ['new'],
  );
});
