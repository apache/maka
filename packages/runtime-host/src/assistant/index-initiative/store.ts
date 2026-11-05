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
export type DiscoveryContextMode = 'legacy' | 'scoped';

/** Scheduler metadata only. Conversation history belongs to the ordinary Session. */
export class InitiativeStore {
  db: DatabaseSync;
  constructor(
    readonly directory: string,
    readonly owner: string,
  ) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'initiative.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS journal(seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS context_workers(session_id TEXT PRIMARY KEY, role TEXT NOT NULL, mode TEXT NOT NULL, context_key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, until_at INTEGER NOT NULL);`);
  }
  get(): any {
    const row = this.db.prepare('SELECT payload FROM state WHERE id=1').get();
    return row ? JSON.parse(String(row.payload)) : null;
  }
  save(s: any) {
    this.db
      .prepare(
        'INSERT INTO state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(JSON.stringify(s));
  }
  log(kind: string, payload: any) {
    this.db
      .prepare('INSERT INTO journal(at,kind,payload) VALUES(?,?,?)')
      .run(Date.now(), kind, JSON.stringify(payload));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  lease() {
    return this.transaction(() => {
      const now = Date.now(),
        row = this.db.prepare('SELECT * FROM lease WHERE id=1').get();
      if (row && row.owner !== this.owner && Number(row.until_at) > now) return false;
      this.db
        .prepare(
          'INSERT INTO lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,until_at=excluded.until_at',
        )
        .run(this.owner, now + 30000);
      return true;
    });
  }
  fence() {
    const l = this.db.prepare('SELECT * FROM lease WHERE id=1').get();
    if (!l || l.owner !== this.owner || Number(l.until_at) <= Date.now())
      throw Error('Initiative ownership changed');
  }
  update(fn: (s: any) => void) {
    return this.transaction(() => {
      this.fence();
      const s = this.get();
      fn(s);
      if (s) this.save(s);
      return s;
    });
  }
  configure(
    binding: { sessionId: string; cwd: string },
    intervalMs: number,
    enabled = true,
    contextMode?: DiscoveryContextMode,
  ) {
    return this.transaction(() => {
      this.fence();
      const old = this.get();
      if (old && old.sessionId !== binding.sessionId)
        throw Error('Initiative belongs to another conversation');
      if (old?.active) throw Error('A heartbeat is still running');
      if (
        contextMode &&
        contextMode !== (old?.contextMode ?? 'legacy') &&
        (old?.pendingDraft || old?.pendingJudgement || old?.contextWake)
      )
        throw Error('Finish or recover the pending discovery before changing context mode');
      const s = {
        version: 2,
        ...binding,
        discoverySession: old?.discoverySession,
        judgementSession: old?.judgementSession,
        candidateReport: old?.candidateReport,
        pendingJudgement: old?.pendingJudgement,
        pendingDraft: old?.pendingDraft,
        promptVersions: old?.promptVersions,
        contextMode: contextMode ?? old?.contextMode ?? 'legacy',
        contextWake: old?.contextWake,
        intervalMs,
        enabled,
        revision: (old?.revision ?? 0) + 1,
        nextAt:
          contextMode !== undefined && old?.intervalMs === intervalMs
            ? old.nextAt
            : enabled
              ? Date.now() + intervalMs
              : null,
        active: null,
        lastError: null,
        lastCheckedAt: old?.lastCheckedAt ?? null,
      };
      this.save(s);
      this.log('configured', { sessionId: s.sessionId, intervalMs });
      return s;
    });
  }
  bind(binding: { sessionId: string; cwd: string }) {
    return this.transaction(() => {
      this.fence();
      const old = this.get();
      if (old) return old; // One durable entry, including concurrent windows and upgrades.
      const s = {
        version: 2,
        ...binding,
        intervalMs: 1800000,
        enabled: false,
        revision: 1,
        nextAt: null,
        active: null,
        lastError: null,
        lastCheckedAt: null,
      };
      this.save(s);
      this.log('bound', { sessionId: s.sessionId });
      return s;
    });
  }
  recover(preserveActive = false) {
    return this.update((s) => {
      if (!s) return;
      if (s.version !== 2) {
        // Archive legacy decisions, but do not inject a private notebook into the user's chat.
        this.log('legacy-archive', s);
        const replacement = {
          version: 2,
          sessionId: s.ownerSession,
          cwd: s.cwd,
          intervalMs: s.intervalMs,
          enabled: false,
          nextAt: Date.now() + s.intervalMs,
          active: null,
          revision: (s.revision ?? 0) + 1,
          lastError:
            'Upgraded to conversation heartbeats. Previous worker history is preserved; explicitly enable in the conversation.',
          lastCheckedAt: null,
        };
        for (const key of Object.keys(s)) delete s[key];
        Object.assign(s, replacement);
      } else if (s.active && !preserveActive) {
        s.checkRequested = false;
        s.active = null;
        s.nextAt = Date.now() + s.intervalMs;
        s.revision++;
        s.lastError =
          'Previous heartbeat was interrupted; the next scheduled check will use the existing conversation';
        this.log('interrupted', { reason: s.lastError });
      }
      // Product instructions come from code, never from persisted configuration.
      delete s.instructions;
    });
  }
  claim() {
    return this.update((s) => {
      if ((!s?.enabled && !s?.checkRequested) || s.active || s.nextAt > Date.now()) return;
      s.active = {
        id: randomUUID(),
        startedAt: Date.now(),
        phase:
          s.pendingDraft?.phase ??
          (s.pendingJudgement || s.candidateReport ? 'judgement' : 'discovery'),
      };
      s.revision++;
      this.log('heartbeat', { id: s.active.id });
    });
  }
  reported(id: string) {
    this.update((s) => {
      if (s?.active?.id === id) s.active.reported = true;
    });
  }
  finish(id: string, error?: string) {
    return this.update((s) => {
      if (s?.active?.id !== id) return;
      s.lastRun = {
        id,
        finishedAt: Date.now(),
        outcome: error ? 'error' : s.active.reported ? 'reported' : 'quiet',
        contextMode: s.contextWake?.mode ?? s.contextMode ?? 'legacy',
      };
      s.active = null;
      if (!error) {
        delete s.candidateReport;
        delete s.pendingJudgement;
        delete s.pendingDraft;
        delete s.contextWake;
      }
      s.revision++;
      s.lastError = error ?? null;
      s.nextAt = Date.now() + s.intervalMs; // host cadence; never model-selected
      if (error) {
        s.failures = (s.failures ?? 0) + 1;
        // Keep the user’s cadence. Failure must neither enable a one-off check
        // nor permanently disable an explicitly enabled heartbeat.
      } else {
        s.failures = 0;
        s.lastCheckedAt = Date.now();
      }
      s.checkRequested = false;
      this.log(error ? 'interrupted' : 'finished', { id, error });
    });
  }
  worker(
    sessionId: string,
  ):
    | { role: 'discovery' | 'judgement' | 'quick'; mode: DiscoveryContextMode; contextKey: string }
    | undefined {
    if (!sessionId) return undefined;
    const row = this.db
      .prepare('SELECT role,mode,context_key FROM context_workers WHERE session_id=?')
      .get(sessionId);
    if (row)
      return {
        role: row.role as any,
        mode: row.mode as DiscoveryContextMode,
        contextKey: String(row.context_key),
      };
    const state = this.get();
    const role =
      state?.discoverySession === sessionId
        ? 'discovery'
        : state?.judgementSession === sessionId
          ? 'judgement'
          : state?.workerSession === sessionId
            ? 'quick'
            : undefined;
    return role ? { role, mode: 'legacy', contextKey: 'legacy' } : undefined;
  }
  bindWorker(
    sessionId: string,
    role: 'discovery' | 'judgement' | 'quick',
    mode: DiscoveryContextMode,
    contextKey: string,
  ) {
    this.transaction(() => {
      this.fence();
      const old = this.worker(sessionId);
      if (old && (old.role !== role || old.mode !== mode || old.contextKey !== contextKey))
        throw Error('Discovery worker identity conflict');
      this.db
        .prepare('INSERT OR IGNORE INTO context_workers VALUES(?,?,?,?)')
        .run(sessionId, role, mode, contextKey);
    });
  }
  prepareContext(mode: DiscoveryContextMode) {
    return this.update((state) => {
      if (state.contextWake) return;
      state.contextWake = { id: randomUUID(), mode };
    }).contextWake;
  }
  control(action: string) {
    return this.update((s) => {
      if (!s) throw Error('Initiative is not configured');
      if (action === 'pause') {
        s.enabled = false;
        s.checkRequested = false;
      } // never cancel a shared human conversation
      else {
        if (s.active) throw Error('A heartbeat is still running');
        if (action !== 'check') s.enabled = true;
        s.checkRequested = action === 'check';
        s.lastError = null;
        s.failures = 0;
        s.nextAt = Date.now() + (action === 'check' ? 0 : s.intervalMs);
      }
      s.revision++;
      this.log(action, {});
    });
  }
  release() {
    this.db.prepare('DELETE FROM lease WHERE owner=?').run(this.owner);
  }
  close() {
    this.db.close();
  }
}
