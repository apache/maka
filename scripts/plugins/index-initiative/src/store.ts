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

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export class InitiativeStore {
  db: DatabaseSync;
  constructor(directory: string, readonly owner: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'initiative.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, until_at INTEGER NOT NULL);`);
  }
  get(): any { const row = this.db.prepare('SELECT payload FROM state WHERE id=1').get(); return row ? JSON.parse(String(row.payload)) : null; }
  save(state: any) { this.db.prepare('INSERT INTO state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload').run(JSON.stringify(state)); }
  log(kind: string, payload: any) { this.db.prepare('INSERT INTO journal(at,kind,payload) VALUES(?,?,?)').run(Date.now(), kind, JSON.stringify(payload)); }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  lease() {
    return this.transaction(() => {
      const now = Date.now(), row = this.db.prepare('SELECT * FROM lease WHERE id=1').get();
      if (row && row.owner !== this.owner && Number(row.until_at) > now) return false;
      this.db.prepare('INSERT INTO lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,until_at=excluded.until_at').run(this.owner, now + 30000);
      return true;
    });
  }
  fence() {
    const l = this.db.prepare('SELECT * FROM lease WHERE id=1').get();
    if (!l || l.owner !== this.owner || Number(l.until_at) <= Date.now()) throw Error('Initiative ownership changed');
  }
  update(fn: (s: any) => void) {
    return this.transaction(() => { this.fence(); const s = this.get(); fn(s); if (s) this.save(s); return s; });
  }
  configure(binding: any, instructions: string, intervalMs: number) {
    return this.transaction(() => {
      this.fence(); const old = this.get();
      if (old && (old.ownerSession !== binding.ownerSession || old.worker !== binding.worker)) throw Error('Initiative was configured concurrently');
      if (old?.active) throw Error('Pause the current check before changing its instructions');
      const state = { ...old, ...binding, instructions, intervalMs, enabled: true, revision: (old?.revision ?? 0) + 1,
        nextAt: Date.now(), nextReason: 'User enabled proactive checks', notebook: old?.notebook ?? '', bookmarks: old?.bookmarks ?? {}, active: null, lastError: null };
      this.save(state); this.log('configured', { revision: state.revision, instructions }); return state;
    });
  }
  recover() {
    return this.update(s => { if (s?.active) { s.enabled = false; s.active = null; s.revision++; s.lastError = 'Previous check was interrupted; inspect possible effects before resuming'; this.log('interrupted', { reason: s.lastError }); } });
  }
  claim() {
    return this.update(s => {
      if (!s?.enabled || s.active || s.nextAt > Date.now()) return;
      s.active = { id: randomUUID(), startedAt: Date.now(), turnId: null, settled: false };
      s.revision++; this.log('wake', { activation: s.active.id, reason: s.nextReason });
    });
  }
  bind(sessionId: string, activation: string, turnId: string) {
    return this.update(s => {
      this.assertWorker(s, sessionId, activation);
      if (s.active.turnId && s.active.turnId !== turnId) throw Error('Stale initiative turn');
      s.active.turnId = turnId;
    });
  }
  assertWorker(s: any, session: string, activation: string) {
    if (!s?.enabled || s.worker !== session || s.active?.id !== activation) throw Error('No matching active initiative check');
  }
  checkpoint(call: any, input: any) {
    return this.update(s => {
      this.assertWorker(s, call.sessionId, input.activationId);
      if (s.active.turnId !== call.turnId) throw Error('Read this activation before submitting');
      const payload = JSON.stringify(input);
      if (s.active.settled) {
        if (s.active.payload === payload) return;
        throw Error('This check already settled with different content');
      }
      if (s.revision !== input.revision) throw Error('Initiative changed; refresh before submitting');
      const at = Date.parse(input.nextCheckAt);
      if (!Number.isFinite(at) || at <= Date.now()) throw Error('nextCheckAt must be a future absolute timestamp with timezone');
      s.notebook = input.notebook; s.bookmarks = input.bookmarks;
      s.nextAt = at; s.nextReason = input.nextReason; s.lastUpdate = input.update;
      s.lastCheckedAt = Date.now(); s.revision++;
      s.active.settled = true; s.active.payload = payload;
      this.log('decision', { activation: input.activationId, ...input });
    });
  }
  finish(id: string, error?: string) {
    return this.update(s => {
      if (s?.active?.id !== id) return;
      if (error || !s.active.settled) {
        s.enabled = false; s.lastError = error ?? 'Agent ended without a checkpoint';
        this.log('interrupted', { activation: id, reason: s.lastError });
      }
      s.active = null; s.revision++;
    });
  }
  control(action: string) {
    return this.update(s => {
      if (!s) throw Error('Initiative is not configured');
      if (action === 'pause') { s.enabled = false; s.active = null; }
      else { if (s.active) throw Error('A check is already active'); s.enabled = true; s.nextAt = Date.now(); s.nextReason = 'User requested a check'; s.lastError = null; }
      s.revision++; this.log(action, {});
    });
  }
  history(before?: number, key?: string) {
    const rows = this.db.prepare('SELECT * FROM journal WHERE seq < ? ORDER BY seq DESC').all(before ?? Number.MAX_SAFE_INTEGER);
    const matches = rows.map(r => { const { notebook, bookmarks, ...record } = JSON.parse(String(r.payload)); return { seq: Number(r.seq), at: Number(r.at), kind: r.kind, ...record }; })
      .filter(r => !key || r.records?.some((item: any) => item.key === key));
    const items: any[] = []; let size = 0;
    for (const item of matches) { const n = JSON.stringify(item).length; if (items.length && (items.length >= 20 || size + n > 24000)) break; items.push(item); size += n; }
    return { items, next: matches.length > items.length ? items.at(-1)!.seq : null };
  }
  release() { this.db.prepare('DELETE FROM lease WHERE owner=?').run(this.owner); }
  close() { this.db.close(); }
}
