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
import { NetworkStore } from '../src/store.js';
function setup(t: any) {
  const root = mkdtempSync(join(tmpdir(), 'maka-memory-'));
  const store = new NetworkStore(root);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, root };
}
const msg = (id: string, text: string) => ({ id, type: 'user', text });

test('two indexes share originals, reverse links and independent coverage; removing a lead preserves evidence', (t) => {
  const { store } = setup(t);
  store.ingest('s', [msg('a', 'Need to contact vendor')]);
  const todo = store.create('Candidates', 'Potential follow-ups', []),
    timeline = store.create('Timeline', 'What happened', []);
  const a = store.batch(todo.id, ['s']),
    b = store.batch(timeline.id, ['s']);
  const ref = String(a.items[0].ref);
  store.commit(a.batchId, [{ id: 'vendor', body: 'Contact vendor?', refs: [ref] }], [], ['s']);
  assert.equal(store.index(timeline.id).covered, 0);
  store.commit(b.batchId, [{ id: 'event', body: 'Discussed vendor', refs: [ref] }], [], ['s']);
  assert.equal(store.original(ref, ['s']).backlinks.length, 2);
  store.ingest('s', [
    msg('a', 'Need to contact vendor'),
    msg('b', 'Vendor was contacted yesterday'),
  ]);
  const delta = store.batch(todo.id, ['s']);
  assert.equal(delta.items.length, 1);
  store.commit(delta.batchId, [], ['vendor'], ['s']);
  assert.equal(store.original(ref, ['s']).backlinks.length, 1);
  assert.match(String(store.original(ref, ['s']).item.text), /Need to contact/);
});

test('frozen paged batches cannot cover arrivals during organization; stale writes fail and replay is idempotent', (t) => {
  const { store } = setup(t);
  store.ingest('s', [msg('a', 'A'), msg('b', 'B')]);
  const i = store.create('Events', 'Events', []);
  const a = store.batch(i.id, ['s'], 1),
    stale = store.batch(i.id, ['s'], 1);
  assert.equal(a.hasMore, true);
  store.ingest('s', [msg('a', 'A'), msg('b', 'B'), msg('c', 'C')]);
  const receipt = store.commit(a.batchId, [], [], ['s']);
  assert.equal(receipt.index.covered, 1);
  assert.deepEqual(store.commit(a.batchId, [], [], ['s']), receipt);
  assert.throws(() => store.commit(a.batchId, [], ['other'], ['s']), /different content/);
  assert.throws(() => store.commit(stale.batchId, [], [], ['s']), /changed/);
  const next = store.batch(i.id, ['s']);
  assert.equal(next.items.length, 2);
  assert.equal(store.index(i.id).covered, 1, 'reading alone is not organization');
});

test('failed reference validation rolls back edits and coverage; unfinished batches survive restart', (t) => {
  const { store, root } = setup(t);
  store.ingest('s', [msg('a', 'A')]);
  const i = store.create('I', 'C', []);
  const batch = store.batch(i.id, ['s']);
  assert.throws(() =>
    store.commit(
      batch.batchId,
      [
        { id: 'ok', body: 'ok', refs: [String(batch.items[0].ref)] },
        { id: 'bad', body: 'bad', refs: ['missing'] },
      ],
      [],
      ['s'],
    ),
  );
  assert.equal(store.entries(i.id, ['s']).items.length, 0);
  assert.equal(store.index(i.id).covered, 0);
  const reopened = new NetworkStore(root);
  try {
    reopened.commit(batch.batchId, [], [], ['s']);
    assert.equal(reopened.index(i.id).covered, 1);
  } finally {
    reopened.close();
  }
});

test('all fragments are lossless, stable on reread, and changed originals remain separate versions', (t) => {
  const { store } = setup(t);
  const message = msg('long', '😀'.repeat(10000));
  store.ingest('s', [message]);
  const i = store.create('I', 'C', []);
  const batch = store.batch(i.id, ['s'], 20);
  const original = batch.items.map((r) => r.text).join('');
  assert.equal(original, JSON.stringify(message));
  assert.equal(store.ingest('s', [message]), 0);
  const ref = String(batch.items[0].ref);
  store.ingest('s', [msg('long', 'Corrected text')]);
  assert.equal(store.original(ref, ['s']).isLatestRevision, false);
  assert.equal(store.original(ref, ['s']).latestRevisionRefs.length, 1);
  assert.equal(store.original(ref, ['s']).item.text, batch.items[0].text);
});

test('scope visibility change invalidates issued batches and never exposes inaccessible references', (t) => {
  const { store } = setup(t);
  store.ingest('private', [msg('a', 'Private')]);
  store.ingest('public', [msg('b', 'Public')]);
  const i = store.create('I', 'C', []),
    batch = store.batch(i.id, ['public', 'private']);
  const ref = String(batch.items[0].ref);
  assert.throws(() => store.commit(batch.batchId, [], [], ['public']), /scope changed/);
  assert.throws(() => store.original(ref, ['public']), /visibility/);
  const safe = store.batch(i.id, ['public']);
  assert.equal(safe.items.length, 1);
  store.commit(safe.batchId, [], [], ['public']);
  const restored = store.batch(i.id, ['public', 'private']);
  assert.equal(restored.index.covered, 0);
  assert.equal(restored.items.length, 2);
});

test('a new Session is incremental and does not trigger a full historical rescan', (t) => {
  const { store } = setup(t);
  store.ingest('old', [msg('a', 'Existing history')]);
  const i = store.create('I', 'All events', []),
    first = store.batch(i.id, ['old']);
  store.commit(first.batchId, [], [], ['old']);
  store.ingest('new', [msg('b', 'New session history')]);
  const next = store.batch(i.id, ['old', 'new']);
  assert.equal(next.index.covered, 1);
  assert.equal(next.items.length, 1);
  assert.equal(next.items[0].session, 'new');
});
