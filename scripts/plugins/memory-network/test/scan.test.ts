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
import { CorpusStore } from '../src/corpus.js';
import { MemoryController } from '../src/controller.js';
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
