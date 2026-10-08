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
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'initiative-store-'));
  const store = new InitiativeStore(dir, 'first'); assert.equal(store.lease(), true);
  store.configure({ sessionId: 'owner', cwd: dir }, 'Explore', 60000);
  return { dir, store, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test('host cadence, natural completion, pause during a run does not re-enable', () => {
  const f = fixture(); try {
    assert.equal(f.store.claim().active, null);
    f.store.control('check'); const active = f.store.claim().active;
    f.store.control('pause'); f.store.finish(active.id);
    assert.equal(f.store.get().enabled, false);
    assert.equal(f.store.get().active, null);
    assert.ok(f.store.get().nextAt >= Date.now() + 59000);
    assert.equal(f.store.get().notebook, undefined);
  } finally { f.close(); }
});
test('restart preserves cadence, interrupted admission stops rather than replaying', () => {
  const f = fixture(); let other: InitiativeStore | undefined;
  try {
    f.store.release(); other = new InitiativeStore(f.dir, 'other'); assert.ok(other.lease()); other.recover();
    assert.equal(other.get().enabled, true);
    other.control('check'); other.claim(); other.release(); assert.ok(f.store.lease()); f.store.recover();
    assert.equal(f.store.get().enabled, false); assert.match(f.store.get().lastError, /interrupted/);
  } finally { other?.close(); f.close(); }
});
test('legacy notebook and worker are archived, upgrade never starts another task', () => {
  const f = fixture(); try {
    f.store.save({ ownerSession: 'owner', worker: 'old-worker', cwd: f.dir, instructions: 'Explore', intervalMs: 60000, enabled: true, notebook: 'D17 unknown', bookmarks: {}, active: null });
    f.store.recover(); const s = f.store.get();
    assert.equal(s.sessionId, 'owner'); assert.equal(s.enabled, false);
    assert.equal(s.worker, undefined); assert.equal(s.notebook, undefined);
    const archive = f.store.db.prepare("SELECT payload FROM journal WHERE kind='legacy-archive'").get();
    assert.equal(JSON.parse(String(archive!.payload)).notebook, 'D17 unknown');
  } finally { f.close(); }
});
test('competing host cannot finish old work or change cadence', () => {
  const f = fixture(), other = new InitiativeStore(f.dir, 'other'); try {
    f.store.control('check'); const id = f.store.claim().active.id;
    assert.equal(other.lease(), false); f.store.db.prepare('UPDATE lease SET until_at=0').run(); assert.ok(other.lease());
    assert.throws(() => f.store.finish(id), /ownership/);
    assert.throws(() => f.store.control('check'), /ownership/);
  } finally { other.close(); f.close(); }
});
