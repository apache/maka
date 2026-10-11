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
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CorpusStore } from '../src/corpus.js';
import { MemoryController } from '../src/controller.js';

const backups = (root: string) => readdirSync(root).filter((x) => x.endsWith('.bak'));
function legacy(t: any, columns: 2 | 3) {
  const root = mkdtempSync(join(tmpdir(), 'memory-legacy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new CorpusStore(root);
  const messages = [{ id: 'message', type: 'user', text: 'Synthetic original' }];
  store.ingest('session', messages);
  store.rememberRecord({ key: 'session', source: 'maka', id: 'session', revision: 'v1' }, messages);
  const cursor = store.capture(['maka'], ['session']);
  const a = store.create('Events', 'Events', []);
  const b = store.create('Preferences', 'Preferences', []);
  const batch = store.batch(a.id, ['session']);
  const ref = String(batch.items[0].ref);
  store.commit(
    batch.batchId,
    [{ id: 'event', body: 'Synthetic event', refs: [ref] }],
    [],
    ['session'],
  );
  const range = store.begin(a.id, cursor.id, ['session']);
  store.checkpoint(a.id, range.id, store.index(a.id).revision, 'done', true, ['session']);
  store.rememberExternal(
    'external',
    [
      {
        id: 'external-original',
        revision: 'v1',
        kind: 'text',
        locator: { id: 'external-original' },
      },
    ],
    true,
  );
  const remoteRef = store.references('external')[0].ref;
  store.cacheEvidence(remoteRef, { text: 'Synthetic external evidence' });
  for (const [i, id] of [a.id, b.id].entries())
    store.saveWorker(id, {
      sessionId: 'same-session',
      groupIndexIds: [a.id, b.id],
      groupNumber: i + 7,
      protocol: 'cursor-v1',
    });
  store.db.exec(
    "DELETE FROM memory_meta WHERE key='scan-scope-v1'; DROP TABLE memory_source_scans;",
  );
  store.db.exec(
    columns === 3
      ? 'CREATE TABLE memory_source_scans(source TEXT PRIMARY KEY,scope TEXT NOT NULL,payload TEXT NOT NULL)'
      : 'CREATE TABLE memory_source_scans(source TEXT PRIMARY KEY,payload TEXT NOT NULL)',
  );
  if (columns === 3)
    store.db
      .prepare('INSERT INTO memory_source_scans VALUES(?,?,?)')
      .run('external', 'legacy-encoding', '{"cursor":"old-page"}');
  else
    store.db
      .prepare('INSERT INTO memory_source_scans VALUES(?,?)')
      .run('external', '{"cursor":"old-page"}');
  store.db
    .prepare('INSERT INTO memory_source_scan_items VALUES(?,?,?)')
    .run('external', 'unpublished', '{}');
  const preservedTables = [
    'documents',
    'fragments',
    'memory_references',
    'memory_evidence',
    'indexes',
    'entries',
    'links',
    'coverage',
    'memory_boundaries',
    'memory_cursors',
    'memory_work_ranges',
    'memory_source_records',
    'memory_source_sets',
  ];
  const saved = new Map(
    preservedTables.map((table) => [table, store.db.prepare('SELECT * FROM ' + table).all()]),
  );
  store.close();
  return { root, a, b, cursor, ref, remoteRef, saved };
}

for (const columns of [2, 3] as const)
  test(`upgrade ${columns}-column scans backs up and preserves published data, refs and groups; reopening is idempotent`, async (t) => {
    const f = legacy(t, columns);
    let store = new CorpusStore(f.root);
    for (const [table, rows] of f.saved)
      assert.deepEqual(store.db.prepare('SELECT * FROM ' + table).all(), rows, table);
    assert.equal(backups(f.root).length, 1);
    const old = new DatabaseSync(join(f.root, backups(f.root)[0]), { readOnly: true });
    assert.equal(old.prepare('PRAGMA table_info(memory_source_scans)').all().length, columns);
    assert.equal(old.prepare('SELECT COUNT(*) n FROM memory_source_scans').get()!.n, 1);
    old.close();
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM memory_source_scans').get()!.n, 0);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM memory_source_scan_items').get()!.n, 0);
    assert.equal(store.entries(f.a.id, ['session']).items[0].body, 'Synthetic event');
    assert.equal(store.original(f.ref, ['session']).backlinks.length, 1);
    assert.equal(store.boundary(f.a.id), f.cursor.id);
    assert.deepEqual(store.evidence(f.remoteRef)?.content, { text: 'Synthetic external evidence' });
    assert.deepEqual(store.worker(f.b.id).groupMembers, [f.a.id, f.b.id]);
    assert.equal(store.worker(f.b.id).groupNumber, 8);
    const ctx = {
      sessionQuery: { historyList: async () => [], historySources: () => [] },
      sources: {
        list: () => [{ id: 'external', scope: { startTime: 1 } }],
        enumerate: async (_: string, cursor?: string) => {
          assert.equal(cursor, undefined);
          return { items: [{ id: 'new', revision: 'v2', locator: { id: 'new' }, kind: 'text' }] };
        },
        authorize: async (_: string, objects: any[]) => objects.map((o) => o.id),
      },
    };
    await new MemoryController(ctx, store).sync(['external']);
    store.close();
    store = new CorpusStore(f.root);
    t.after(() => store.close());
    assert.equal(backups(f.root).length, 1);
    assert.equal(store.references('external').length, 2);
    assert.equal(store.boundary(f.a.id), f.cursor.id);
    assert.deepEqual(store.worker(f.a.id).groupMembers, [f.a.id, f.b.id]);
  });

test('unknown legacy group shape rolls back the entire migration, retaining scans and originals with backup', (t) => {
  const f = legacy(t, 3);
  const db = new DatabaseSync(join(f.root, 'network.sqlite'));
  db.prepare('UPDATE workers SET payload=? WHERE index_id=?').run(
    JSON.stringify({ groupIndexIds: { unexpected: true } }),
    f.a.id,
  );
  assert.throws(
    () => new CorpusStore(f.root),
    /upgrade failed.*original data retained.*backup:.*groupIndexIds/,
  );
  assert.equal(backups(f.root).length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM memory_source_scans').get()!.n, 1);
  for (const [table, rows] of f.saved)
    assert.deepEqual(db.prepare('SELECT * FROM ' + table).all(), rows);
  assert.equal(db.prepare("SELECT 1 FROM memory_meta WHERE key='scan-scope-v1'").get(), undefined);
  db.close();
});
