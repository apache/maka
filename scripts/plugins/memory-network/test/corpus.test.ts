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
import { NetworkStore } from '../src/store.js';
const msg = (id: string, text: string) => ({ id, type: 'user', text });
const sync = (s: CorpusStore, messages: any[]) => {
  s.ingest('s', messages);
  s.rememberRecord(
    { key: 's', source: 'maka', id: 's', revision: JSON.stringify(messages) },
    messages,
  );
  return s.capture(['maka'], ['s']);
};

test('old database keeps evidence and entries but legacy coverage is not trusted as a cursor', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-upgrade-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const old = new NetworkStore(dir);
  old.ingest('s', [msg('a', 'Original')]);
  const index = old.create('Events', 'Timeline', []);
  const batch = old.batch(index.id, ['s']);
  const ref = String(batch.items[0].ref);
  old.commit(batch.batchId, [{ id: 'event', body: 'Legacy event', refs: [ref] }], [], ['s']);
  old.saveWorker(index.id, { sessionId: 'old-worker', ownerSessionId: 'owner' });
  old.close();
  let s = new CorpusStore(dir);
  assert.equal(s.boundary(index.id), null);
  assert.equal(s.worker(index.id).protocol, undefined);
  assert.equal(s.entries(index.id, ['s']).items[0].body, 'Legacy event');
  assert.ok(
    s.db
      .prepare('SELECT session_id FROM memory_worker_sessions WHERE session_id=?')
      .get('old-worker'),
  );
  const cursor = sync(s, [msg('a', 'Original')]);
  const work = s.begin(index.id, cursor.id, ['s']);
  s.checkpoint(index.id, work.id, s.index(index.id).revision, 'Organized old content', true, ['s']);
  s.close();
  s = new CorpusStore(dir);
  t.after(() => s.close());
  assert.equal(s.boundary(index.id), cursor.id);
  assert.equal(s.original(ref, ['s']).backlinks.length, 1);
});

test('immutable cursors preserve removed/edited versions, and stale writes cannot advance coverage', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-range-'));
  const s = new CorpusStore(dir);
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = sync(s, [msg('a', 'Before'), msg('b', 'Removed')]);
  const index = s.create('Events', 'Timeline', []);
  const work = s.begin(index.id, a.id, ['s']);
  const ref = `${a.records[0].documents[0]}:0`;
  const write = s.write(
    index.id,
    'anything.md',
    `Free structure [evidence](memory-original:${ref})`,
    0,
    ['s'],
  );
  assert.equal(s.boundary(index.id), null);
  assert.throws(
    () => s.write(index.id, 'x', '[bad](memory-original:invalid)', write.revision, ['s']),
    /Original/,
  );
  assert.throws(() => s.checkpoint(index.id, work.id, 0, '', true, ['s']), /changed/);
  const b = sync(s, [msg('a', 'After')]);
  s.checkpoint(index.id, work.id, write.revision, 'Done', true, ['s']);
  assert.equal(s.boundary(index.id), a.id, 'new arrivals cannot be folded into old range');
  const delta = s.describe(a.id, b.id, ['s']);
  assert.equal(delta.sources[0].newOrChangedMessages, 1);
  assert.equal(delta.sources[0].removedMessages, 2);
  assert.equal(s.cursor(a.id).records[0].documents.length, 2);
  assert.equal(s.original(ref, ['s']).isLatestRevision, false);
  const next = s.begin(index.id, b.id, ['s']);
  assert.throws(
    () => s.checkpoint(index.id, work.id, write.revision, '', true, ['s']),
    /superseded/,
  );
  s.checkpoint(index.id, next.id, write.revision, 'Working', false, ['s']);
  assert.equal(s.boundary(index.id), a.id);
  assert.equal(s.notes(index.id), 'Working');
});
