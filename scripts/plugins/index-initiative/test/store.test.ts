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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InitiativeStore } from '../src/store.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'initiative-store-'));
  const store = new InitiativeStore(dir, 'first'); assert.equal(store.lease(), true);
  store.configure({ ownerSession: 'owner', worker: 'worker', cwd: dir }, 'Use relevant indexes', 60000);
  const active = store.claim(); store.bind('worker', active.active.id, 'turn');
  const input = { activationId: active.active.id, revision: active.revision, summary: 'Quiet', notebook: '', bookmarks: {}, records: [], update: '', nextCheckAt: new Date(Date.now() + 60000).toISOString(), nextReason: 'Fresh evidence' };
  return { dir, store, input, call: { sessionId: 'worker', turnId: 'turn' }, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('revision/turn/activation guards and exact replay do not duplicate decisions', () => {
  const f = setup(); try {
    assert.throws(() => f.store.checkpoint({ ...f.call, turnId: 'old' }, f.input), /Read this activation/);
    assert.throws(() => f.store.checkpoint(f.call, { ...f.input, revision: 0 }), /changed/);
    f.store.checkpoint(f.call, f.input); f.store.checkpoint(f.call, f.input);
    assert.equal(f.store.history().items.filter(i => i.kind === 'decision').length, 1);
    assert.throws(() => f.store.checkpoint(f.call, { ...f.input, summary: 'Other' }), /different content/);
    f.store.control('pause');
    assert.throws(() => f.store.checkpoint(f.call, f.input), /matching active/);
  } finally { f.close(); }
});

test('waiting schedule survives restart; interrupted execution requires inspection', () => {
  const f = setup(); let second: InitiativeStore | undefined;
  try {
    f.store.checkpoint(f.call, f.input); f.store.finish(f.input.activationId); f.store.release();
    second = new InitiativeStore(f.dir, 'second'); assert.equal(second.lease(), true); second.recover();
    assert.equal(second.get().enabled, true); assert.equal(second.get().nextAt, Date.parse(f.input.nextCheckAt));
    assert.equal(second.claim().active, null);
    second.control('check'); second.claim(); second.release();
    assert.equal(f.store.lease(), true); f.store.recover();
    assert.equal(f.store.get().enabled, false); assert.match(f.store.get().lastError, /interrupted/);
  } finally { second?.close(); f.close(); }
});

test('competing lease fences old writes, including late checkpoint', () => {
  const f = setup(); const second = new InitiativeStore(f.dir, 'second');
  try {
    assert.equal(second.lease(), false);
    f.store.db.prepare('UPDATE lease SET until_at=0').run();
    assert.equal(second.lease(), true);
    assert.throws(() => f.store.checkpoint(f.call, f.input), /ownership/);
    f.store.release(); second.fence();
  } finally { second.close(); f.close(); }
});

test('history pagination retains cursor when byte limit is reached before count limit', () => {
  const f = setup(); try {
    for (let i = 0; i < 5; i++) f.store.log('decision', { summary: 'x'.repeat(15000) });
    const first = f.store.history(); assert.equal(first.items.length, 1); assert.ok(first.next);
    const next = f.store.history(first.next); assert.ok(next.items[0].seq < first.items[0].seq);
  } finally { f.close(); }
});
