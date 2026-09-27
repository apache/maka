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

import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MatterFiles } from './files.js';
import { join, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  MATTER_REQUEST_MAX_LENGTH,
  MATTER_STATE_MAX_BYTES,
  type Matter,
  type MatterFileContext,
  type MatterCreateInput,
  type MatterEvent,
  type MatterRun,
  type MatterSettleInput,
  type MatterSnapshot,
  type MatterStore,
  type MatterUpdate,
} from './matter.js';

const require = createRequire(import.meta.url);
const terminal = (m: Matter) => m.status === 'completed' || m.status === 'cancelled';
function stateText(value: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > MATTER_STATE_MAX_BYTES) {
    throw new Error(
      `State must be text within ${MATTER_STATE_MAX_BYTES} bytes. Condense it explicitly; nothing was saved.`,
    );
  }
  return value;
}
function text(value: string, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`Invalid ${label}`);
  return value.trim();
}

/** Separate database, no dependency on Goal, Automation, Memory or task ledgers. */
export function createMatterStore(
  root: string,
  options: { now?: () => number; newId?: () => string } = {},
): MatterStore {
  mkdirSync(root, { recursive: true });
  const Database = (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
  return new SqliteMatterStore(
    new Database(join(root, 'matters.sqlite')),
    new MatterFiles(join(root, 'matters')),
    options.now ?? Date.now,
    options.newId ?? randomUUID,
  );
}

class SqliteMatterStore implements MatterStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly files: MatterFiles,
    private readonly now: () => number,
    private readonly newId: () => string,
  ) {
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS plugin_bindings (session_id TEXT PRIMARY KEY, cwd TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_authorized_sessions (session_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS plugin_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, until_ms INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS matters (id TEXT PRIMARY KEY, session_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS matter_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, matter_id TEXT NOT NULL REFERENCES matters(id),
        event_key TEXT NOT NULL, source TEXT NOT NULL, subject TEXT NOT NULL, text TEXT NOT NULL,
        created_at INTEGER NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, UNIQUE(matter_id,event_key));
      CREATE TABLE IF NOT EXISTS matter_operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS matter_runs (id TEXT PRIMARY KEY, matter_id TEXT NOT NULL, turn_id TEXT NOT NULL,
        started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT);
      CREATE TABLE IF NOT EXISTS matter_updates (id TEXT PRIMARY KEY, matter_id TEXT NOT NULL,
        text TEXT NOT NULL, created_at INTEGER NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS matter_revisions (matter_id TEXT NOT NULL, revision INTEGER NOT NULL,
        payload TEXT NOT NULL, PRIMARY KEY(matter_id, revision));
      CREATE TABLE IF NOT EXISTS matter_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        matter_id TEXT NOT NULL, record_key TEXT UNIQUE NOT NULL, document TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS matter_history_order ON matter_history(matter_id,sequence);
      CREATE INDEX IF NOT EXISTS matter_events_pending ON matter_events(matter_id,acknowledged,sequence);`);
    // Preserve existing revisions when opening a workspace created before the operation journal.
    this.transaction(() => {
      for (const row of db
        .prepare(`SELECT r.payload FROM matter_revisions r WHERE NOT EXISTS
        (SELECT 1 FROM matter_history h WHERE h.record_key='revision:' || r.matter_id || ':' || r.revision)
        ORDER BY r.matter_id,r.revision`)
        .all()) {
        const m = this.decode(String(row.payload));
        this.appendHistory(m, 'legacy_revision', {}, `revision:${m.id}:${m.revision}`, m.updatedAt);
      }
    });
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  authorizeSession(sessionId: string): void {
    const id = text(sessionId, 200, 'session');
    if (this.forSession(id)) throw new Error('This session already has a follow-up');
    this.db.prepare('INSERT OR IGNORE INTO plugin_authorized_sessions VALUES(?,?)').run(id, this.now());
  }
  isAuthorizedSession(sessionId: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM plugin_authorized_sessions WHERE session_id=?').get(sessionId));
  }
  consumeAuthorizedSession(sessionId: string): void {
    this.db.prepare('DELETE FROM plugin_authorized_sessions WHERE session_id=?').run(sessionId);
  }
  private read(id: string): Matter {
    const row = this.db.prepare('SELECT payload FROM matters WHERE id=?').get(id);
    if (!row) throw new Error('Matter does not exist');
    return this.decode(row.payload as string);
  }
  private encode(m: Matter): string {
    const { request, stateText, ...metadata } = m;
    return JSON.stringify({
      ...metadata,
      documents: {
        request: this.files.put(request),
        state: this.files.put(stateText),
      },
    });
  }
  private decode(value: string): Matter {
    const stored = JSON.parse(value);
    if (!stored.documents) return stored as Matter; // Read legacy records until their next commit.
    const { documents, ...metadata } = stored;
    return {
      ...metadata,
      request: this.files.get(documents.request),
      stateText: this.files.get(documents.state),
    };
  }
  private appendHistory(
    m: Matter,
    kind: string,
    detail: Record<string, unknown> = {},
    key = this.newId(),
    at = this.now(),
  ): void {
    const document = this.files.put(
      JSON.stringify({
        at,
        timestamp: new Date(at).toISOString(),
        kind,
        revision: m.revision,
        activationId: m.activation?.id ?? null,
        turnId: m.activation?.turnId ?? null,
        status: m.status,
        stateFile: this.files.objectPath(this.files.put(m.stateText)),
        ...detail,
      }),
    );
    this.db
      .prepare('INSERT INTO matter_history(matter_id,record_key,document) VALUES(?,?,?)')
      .run(m.id, key, document);
  }
  handoff(id: string): { summary: string; reason: string; next?: string; at: number } | null {
    const rows = this.db
      .prepare('SELECT document FROM matter_history WHERE matter_id=? ORDER BY sequence DESC')
      .iterate(id);
    for (const row of rows) {
      const entry = JSON.parse(this.files.get(String(row.document)));
      if (entry.kind === 'settle')
        return { summary: entry.summary, reason: entry.reason, next: entry.next, at: entry.at };
    }
    return null;
  }

  private history(id: string): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT sequence,document FROM matter_history WHERE matter_id=? ORDER BY sequence')
      .all(id)
      .map((row) => ({
        sequence: Number(row.sequence),
        ...JSON.parse(this.files.get(String(row.document))),
      }));
  }
  private write(m: Matter, kind: string, detail: Record<string, unknown> = {}): Matter {
    const previous = this.read(m.id);
    m.revision += 1;
    m.updatedAt = this.now();
    this.db.prepare('UPDATE matters SET payload=? WHERE id=?').run(this.encode(m), m.id);
    this.db
      .prepare('INSERT INTO matter_revisions VALUES(?,?,?)')
      .run(m.id, m.revision, this.encode(m));
    this.appendHistory(
      m,
      kind,
      {
        previousStateFile: this.files.objectPath(this.files.put(previous.stateText)),
        observedThrough: m.activation?.eventCursor ?? null,
        ...detail,
      },
      `revision:${m.id}:${m.revision}`,
      m.updatedAt,
    );
    return m;
  }
  create(input: MatterCreateInput): Matter {
    if (typeof input.cwd !== 'string' || !isAbsolute(input.cwd))
      throw new Error('cwd must be absolute');
    const m: Matter = {
      id: this.newId(),
      sessionId: text(input.sessionId, 200, 'session'),
      title: text(input.title, 120, 'title'),
      request: text(input.request, MATTER_REQUEST_MAX_LENGTH, 'request'),
      stateText: '',
      revision: 0,
      status: 'active',
      wakes: [],
      waitingFor: null,
      activation: null,
      runCount: 0,
      maxRuns: input.maxRuns ?? 100,
      lastError: null,
      lastUpdate: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    if (!Number.isInteger(m.maxRuns) || m.maxRuns < 1 || m.maxRuns > 1000)
      throw new Error('Invalid run budget');
    return this.transaction(() => {
      this.db.prepare('INSERT INTO matters VALUES(?,?,?)').run(m.id, m.sessionId, this.encode(m));
      this.insertEvent(m.id, {
        key: 'created',
        source: 'user',
        text: m.request,
      });
      // Enrollment and recovery authority must commit together, including the initial event/history.
      this.db.prepare('INSERT INTO plugin_bindings VALUES(?,?)').run(m.sessionId, input.cwd);
      return this.write(m, 'create');
    });
  }
  list(): Matter[] {
    return this.db
      .prepare('SELECT payload FROM matters')
      .all()
      .map((r) => this.decode(r.payload as string))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  get(id: string): MatterSnapshot {
    return { matter: this.read(id), ...this.eventBatch(id) };
  }
  workspace(id: string, activationId: string): MatterFileContext {
    const snapshot = this.get(id);
    const m = snapshot.matter;
    if (m.activation?.id !== activationId)
      throw new Error('This activation no longer owns the matter');
    const directory = this.files.directory(id, activationId);
    const paths = {
      request: join(directory, 'request.md'),
      state: join(directory, 'state.md'),
      changes: join(directory, 'changes.jsonl'),
      inbox: join(directory, 'inbox.json'),
      draft: join(directory, 'draft.md'),
    };
    const userInputs = this.db
      .prepare(
        "SELECT created_at,text FROM matter_events WHERE matter_id=? AND source='user' AND event_key<>'created' ORDER BY sequence",
      )
      .all(id);
    const amendments = userInputs
      .map((row) => {
        const raw = String(row.text);
        const body = raw.startsWith('@file:') ? this.files.get(raw.slice(6)) : raw;
        return `\n\n## User input at ${new Date(Number(row.created_at)).toISOString()}\n${body}`;
      })
      .join('');
    this.files.write(
      paths.request,
      `# Original delegation\nCreated at: ${new Date(m.createdAt).toISOString()}\n\n${m.request}${amendments}`,
    );
    this.files.write(paths.state, m.stateText);
    const changes = this.history(id).map((entry) => JSON.stringify(entry));
    this.files.write(paths.changes, changes.length ? changes.join('\n') + '\n' : '');
    this.files.write(
      paths.inbox,
      JSON.stringify(
        {
          events: snapshot.events,
          pendingEventCount: snapshot.pendingEventCount,
        },
        null,
        2,
      ),
    );
    if (!existsSync(paths.draft)) this.files.write(paths.draft, m.stateText, 0o600);
    const previous = this.db
      .prepare(
        'SELECT ended_at FROM matter_runs WHERE matter_id=? AND id<>? ORDER BY started_at DESC,rowid DESC LIMIT 1',
      )
      .get(id, activationId);
    const causes = [...new Set(snapshot.events.map((event) => event.source))];
    if (m.runCount === 1) causes.unshift('created');
    return {
      matterId: id,
      activationId,
      revision: m.revision,
      status: m.status,
      now: this.now(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      createdAt: m.createdAt,
      activationStartedAt: m.activation.startedAt,
      wake: {
        causes,
        previousRunEndedAt: previous?.ended_at == null ? null : Number(previous.ended_at),
      },
      pendingEventCount: snapshot.pendingEventCount,
      files: paths,
    };
  }
  readDraft(id: string, activationId: string, path: string): string {
    const m = this.read(id);
    if (m.activation?.id !== activationId)
      throw new Error('This activation no longer owns the matter');
    return this.files.draft(join(this.files.directory(id, activationId), 'draft.md'), path);
  }
  writeDraft(id: string, activationId: string, path: string, content: string): void {
    this.transaction(() => {
      const m = this.assertActive(id, activationId);
      stateText(content);
      const draft = join(this.files.directory(id, activationId), 'draft.md');
      if (path !== draft) throw new Error('Only this activation’s draft.md is editable');
      const before = this.files.draft(draft, path); // Reject links before replacing the draft atomically.
      this.appendHistory(m, 'draft', {
        published: false,
        previousDraftFile: this.files.objectPath(this.files.put(before)),
        draftFile: this.files.objectPath(this.files.put(content)),
      });
      this.files.write(draft, content, 0o600);
    });
  }
  readFile(id: string, activationId: string, path: string) {
    this.assertActive(id, activationId);
    const directory = this.files.directory(id, activationId);
    const allowed = ['request.md', 'state.md', 'inbox.json', 'changes.jsonl', 'draft.md'].map(
      (name) => join(directory, name),
    );
    for (const entry of this.history(id)) {
      for (const key of ['stateFile', 'previousStateFile', 'draftFile', 'previousDraftFile']) {
        if (typeof entry[key] === 'string') allowed.push(entry[key] as string);
      }
    }
    if (!allowed.includes(path) || realpathSync(path) !== path)
      throw new Error(
        'Read only this matter’s manifest files or state versions referenced in changes.jsonl',
      );
    return {
      path,
      content: readFileSync(path, 'utf8'),
      observedAt: this.now(),
    };
  }
  private eventBatch(id: string): Pick<MatterSnapshot, 'events' | 'pendingEventCount'> {
    const pending = this.events(id);
    const events: MatterEvent[] = [];
    let bytes = 0;
    for (const event of pending) {
      const size = Buffer.byteLength(JSON.stringify(event));
      if (events.length >= 32 || (events.length > 0 && bytes + size > 64 * 1024)) break;
      events.push(event);
      bytes += size;
    }
    return { events, pendingEventCount: pending.length };
  }
  private events(id: string): MatterEvent[] {
    return this.db
      .prepare('SELECT * FROM matter_events WHERE matter_id=? AND acknowledged=0 ORDER BY sequence')
      .all(id)
      .map((r) => ({
        id: r.id as string,
        matterId: id,
        sequence: Number(r.sequence),
        source: r.source as string,
        subject: r.subject as string,
        text: String(r.text).startsWith('@file:')
          ? this.files.get(String(r.text).slice(6))
          : String(r.text),
        createdAt: Number(r.created_at),
      }));
  }
  forSession(sessionId: string): Matter | undefined {
    const row = this.db.prepare('SELECT payload FROM matters WHERE session_id=?').get(sessionId);
    return row ? this.decode(row.payload as string) : undefined;
  }
  private insertEvent(
    id: string,
    input: { key: string; source: string; subject?: string; text: string },
  ): boolean {
    return (
      Number(
        this.db
          .prepare(
            'INSERT OR IGNORE INTO matter_events(id,matter_id,event_key,source,subject,text,created_at) VALUES(?,?,?,?,?,?,?)',
          )
          .run(
            this.newId(),
            id,
            text(input.key, 1000, 'event key'),
            text(input.source, 120, 'event source'),
            input.subject ?? '',
            `@file:${this.files.put(text(input.text, 8000, 'event text'))}`,
            this.now(),
          ).changes,
      ) > 0
    );
  }
  ingest(
    id: string,
    input: { key: string; source: string; subject?: string; text: string },
  ): boolean {
    return this.transaction(() => {
      const m = this.read(id);
      if (input.source !== 'user')
        throw new Error(
          'External event subscriptions are not supported; only user input and scheduled time',
        );
      if (terminal(m)) return false;
      // Events are wake signals. Never rewrite agent-authored state here.
      return this.insertEvent(id, input);
    });
  }
  enqueueDue(): void {
    this.transaction(() => {
      for (const m of this.list()) {
        if (terminal(m) || m.status === 'paused') continue;
        for (const wake of m.wakes) {
          if (wake.kind === 'at' && wake.at <= this.now()) {
            this.insertEvent(m.id, {
              key: `timer:${m.revision}:${wake.at}`,
              source: 'time',
              text: `Scheduled check due at ${new Date(wake.at).toISOString()}. Reassess the current situation.`,
            });
          }
        }
      }
    });
  }
  claim(id: string): MatterSnapshot | null {
    return this.transaction(() => {
      const m = this.read(id);
      if (terminal(m) || m.status === 'paused' || m.activation) return null;
      const batch = this.eventBatch(id);
      const { events } = batch;
      if (!events.length) return null;
      if (m.runCount >= m.maxRuns) {
        m.status = 'paused';
        m.lastError = '已达到事项运行次数上限，请检查进展后继续。';
        this.publish(m, m.lastError, `budget:${m.id}:${m.maxRuns}`);
        this.write(m, 'run_limit');
        return null;
      }
      const activation = {
        id: this.newId(),
        turnId: `pending:${this.newId()}`,
        eventCursor: events.at(-1)!.sequence,
        startedAt: this.now(),
        settled: false,
      };
      m.activation = activation;
      m.runCount++;
      m.status = 'active';
      m.waitingFor = null;
      m.lastError = null;
      m.wakes = m.wakes.filter((w) => w.kind !== 'at' || w.at > this.now());
      this.db
        .prepare('INSERT INTO matter_runs(id,matter_id,turn_id,started_at) VALUES(?,?,?,?)')
        .run(activation.id, id, activation.turnId, activation.startedAt);
      return { matter: this.write(m, 'claim'), ...batch };
    });
  }
  bindTurn(id: string, activationId: string, turnId: string): Matter {
    return this.transaction(() => {
      const m = this.assertActive(id, activationId);
      if (m.activation!.turnId === turnId) return m;
      // Only the unbound dispatch marker may be replaced by a real Host turn.
      if (!m.activation!.turnId.startsWith('pending:'))
        throw new Error('Activation is already bound to another turn');
      m.activation!.turnId = turnId;
      this.db.prepare('UPDATE matter_runs SET turn_id=? WHERE id=?').run(turnId, activationId);
      return this.write(m, 'bind_turn', { activationId, turnId });
    });
  }
  binding(sessionId: string): string | undefined {
    return this.db.prepare('SELECT cwd FROM plugin_bindings WHERE session_id=?').get(sessionId)
      ?.cwd as string | undefined;
  }
  lease(owner: string, until: number): boolean {
    return this.transaction(() => {
      const current = this.db.prepare('SELECT * FROM plugin_lease WHERE id=1').get();
      if (current && current.owner !== owner && Number(current.until_ms) > this.now()) return false;
      this.db
        .prepare(
          'INSERT INTO plugin_lease VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,until_ms=excluded.until_ms',
        )
        .run(owner, until);
      return true;
    });
  }
  releaseLease(owner: string): void {
    this.db.prepare('DELETE FROM plugin_lease WHERE owner=?').run(owner);
  }
  assertActive(id: string, activationId: string): Matter {
    const m = this.read(id);
    if (m.activation?.id !== activationId || m.activation.settled || m.status !== 'active') {
      throw new Error('This activation no longer owns the matter. Do not perform more actions.');
    }
    return m;
  }
  observe(id: string, activationId: string): MatterSnapshot {
    return this.transaction(() => {
      const m = this.assertActive(id, activationId);
      const batch = this.eventBatch(id);
      const { events } = batch;
      const cursor = events.at(-1)?.sequence ?? m.activation!.eventCursor;
      if (cursor > m.activation!.eventCursor) {
        m.activation!.eventCursor = cursor;
        this.write(m, 'observe');
      }
      return { matter: m, ...batch };
    });
  }
  private mutate(
    id: string,
    activationId: string,
    revision: number,
    operationId: string,
    fingerprint: string,
    fn: (m: Matter) => void,
    kind = 'checkpoint',
    detail: Record<string, unknown> = {},
  ): Matter {
    fingerprint = createHash('sha256').update(fingerprint).digest('hex');
    return this.transaction(() => {
      const previous = this.db
        .prepare('SELECT fingerprint,result FROM matter_operations WHERE id=?')
        .get(operationId);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          throw new Error('Operation identity reused with different arguments');
        return this.decode(previous.result as string);
      }
      const m = this.assertActive(id, activationId);
      if (m.revision !== revision)
        throw new Error('State revision changed. Call MatterRead, reassess, and retry.');
      fn(m);
      this.write(m, kind, detail);
      this.db
        .prepare('INSERT INTO matter_operations VALUES(?,?,?)')
        .run(operationId, fingerprint, this.encode(m));
      return m;
    });
  }
  checkpoint(
    id: string,
    activationId: string,
    revision: number,
    body: string,
    operationId: string,
  ): Matter {
    const content = stateText(body);
    return this.mutate(
      id,
      activationId,
      revision,
      operationId,
      JSON.stringify(['checkpoint', id, activationId, revision, content]),
      (m) => {
        m.stateText = content;
      },
    );
  }
  settle(id: string, activationId: string, input: MatterSettleInput, operationId: string): Matter {
    const fingerprint = JSON.stringify(['settle', id, activationId, input]);
    return this.mutate(
      id,
      activationId,
      input.expectedRevision,
      operationId,
      fingerprint,
      (m) => {
        stateText(input.stateText);
        text(input.reason, 2000, 'reason');
        text(input.summary, 4000, 'summary');
        if (input.next !== undefined) text(input.next, 2000, 'next');
        if (!['continue', 'wait', 'complete'].includes(input.disposition))
          throw new Error('Invalid disposition');
        const wakes = input.wakes ?? [];
        if (wakes.length > 10) throw new Error('Too many wake conditions');
        for (const w of wakes) {
          if (w.kind !== 'at') throw new Error('Only time wakes are supported');
          if (!Number.isFinite(w.at) || w.at <= this.now() || w.at > this.now() + 366 * 86400000)
            throw new Error('Wake time must be in the next year');
        }
        if (input.disposition === 'wait' && !wakes.length)
          throw new Error('Waiting requires a future time wake');
        if (input.disposition !== 'wait' && wakes.length)
          throw new Error('Only wait dispositions accept wakes');
        if (input.disposition === 'wait') text(input.waitingFor, 1000, 'waiting condition');
        else if (input.waitingFor !== undefined)
          throw new Error('Only wait dispositions accept a waiting condition');
        const update = input.update ? text(input.update, 2000, 'update') : undefined;
        if (
          input.disposition === 'complete' &&
          this.events(id).some((e) => e.sequence > m.activation!.eventCursor)
        ) {
          throw new Error(
            'Unread events remain. Call MatterRead and reassess; if the batch is full, settle with continue to process the next batch before completing.',
          );
        }
        m.stateText = input.stateText;
        m.activation!.settled = true;
        m.wakes = wakes;
        m.waitingFor = input.disposition === 'wait' ? input.waitingFor!.trim() : null;
        m.status =
          input.disposition === 'complete'
            ? 'completed'
            : input.disposition === 'wait'
              ? 'waiting'
              : 'active';
        this.db
          .prepare('UPDATE matter_events SET acknowledged=1 WHERE matter_id=? AND sequence<=?')
          .run(id, m.activation!.eventCursor);
        if (input.disposition === 'continue') {
          this.insertEvent(id, {
            key: `continue:${activationId}`,
            source: 'continuation',
            text: input.reason,
          });
        }
        if (terminal(m))
          this.db.prepare('UPDATE matter_events SET acknowledged=1 WHERE matter_id=?').run(id);
        if (m.lastError || update || input.disposition === 'complete')
          this.publish(m, m.lastError ?? update ?? input.reason, operationId);
      },
      'settle',
      {
        summary: input.summary,
        reason: input.reason,
        ...(input.next ? { next: input.next } : {}),
        disposition: input.disposition,
        wakes: input.wakes ?? [],
        ...(input.waitingFor ? { waitingFor: input.waitingFor } : {}),
        operationId,
      },
    );
  }
  private publish(m: Matter, value: string, key: string): void {
    m.lastUpdate = value;
    this.db
      .prepare('INSERT OR IGNORE INTO matter_updates VALUES(?,?,?,?,0)')
      .run(key, m.id, value, this.now());
  }
  finish(id: string, activationId: string, error?: string): void {
    this.transaction(() => {
      const m = this.read(id);
      if (m.activation?.id !== activationId) return;
      if (!m.activation.settled) {
        m.status = 'paused';
        m.lastError = error || '本轮未提交等待或完成状态，请检查执行记录后继续。';
        this.publish(m, m.lastError, `failure:${activationId}`);
      }
      this.db
        .prepare('UPDATE matter_runs SET ended_at=?,outcome=? WHERE id=?')
        .run(this.now(), m.activation.settled ? m.status : m.lastError, activationId);
      const turnId = m.activation.turnId;
      const outcome = m.activation.settled ? m.status : m.lastError;
      m.activation = null;
      this.write(m, 'finish', { activationId, turnId, outcome });
    });
  }
  control(id: string, action: 'pause' | 'resume' | 'cancel' | 'check'): Matter {
    return this.transaction(() => {
      const m = this.read(id);
      if (!['pause', 'resume', 'cancel', 'check'].includes(action))
        throw new Error('Invalid action');
      if (terminal(m)) throw new Error('This matter has ended');
      const interrupted = m.activation;
      if (action === 'pause' || action === 'cancel') {
        m.status = action === 'pause' ? 'paused' : 'cancelled';
        m.wakes = [];
        m.waitingFor = null;
        if (m.activation)
          this.db
            .prepare('UPDATE matter_runs SET ended_at=?,outcome=? WHERE id=?')
            .run(this.now(), m.status, m.activation.id);
        m.activation = null;
      } else {
        if (m.activation) throw new Error('Matter is already running');
        if (m.runCount >= m.maxRuns) m.maxRuns += 100;
        m.status = 'active';
        m.lastError = null;
        m.waitingFor = null;
        this.insertEvent(id, {
          key: this.newId(),
          source: action,
          text: '用户要求根据最新情况继续检查。',
        });
      }
      return this.write(
        m,
        action,
        interrupted
          ? {
              activationId: interrupted.id,
              turnId: interrupted.turnId,
              outcome: interrupted.settled ? 'settled' : 'interrupted',
            }
          : {},
      );
    });
  }
  edit(id: string, revision: number, body: string): Matter {
    stateText(body);
    return this.transaction(() => {
      const m = this.read(id);
      if (terminal(m) || m.activation)
        throw new Error('Pause this matter before editing its state');
      if (m.revision !== revision) throw new Error('State changed. Reload before saving.');
      m.stateText = body;
      return this.write(m, 'edit');
    });
  }
  recover(): void {
    // Never replay an interrupted external effect merely because the process restarted.
    for (const m of this.list()) {
      if (m.activation)
        this.finish(m.id, m.activation.id, '上次执行被中断。请检查执行记录与外部结果后继续。');
      const current = this.read(m.id);
      if (!terminal(current) && current.wakes.some((w) => w.kind !== 'at'))
        this.transaction(() => {
          current.status = 'paused';
          current.wakes = [];
          current.lastError = '持续跟进现仅支持时间唤醒。请检查后继续，重新安排下次检查。';
          this.publish(
            current,
            current.lastError,
            `wake-migration:${current.id}:${current.revision}`,
          );
          this.write(current, 'wake_migration');
        });
    }
  }
  updates(id?: string): MatterUpdate[] {
    const rows = id
      ? this.db
          .prepare('SELECT * FROM matter_updates WHERE matter_id=? ORDER BY created_at DESC')
          .all(id)
      : this.db.prepare('SELECT * FROM matter_updates WHERE delivered=0 ORDER BY created_at').all();
    return rows.map((r) => ({
      id: r.id as string,
      matterId: r.matter_id as string,
      text: r.text as string,
      createdAt: Number(r.created_at),
      delivered: Boolean(r.delivered),
    }));
  }
  markDelivered(id: string): void {
    this.db.prepare('UPDATE matter_updates SET delivered=1 WHERE id=?').run(id);
  }
  runs(id: string): MatterRun[] {
    return this.db
      .prepare('SELECT * FROM matter_runs WHERE matter_id=? ORDER BY started_at DESC LIMIT 100')
      .all(id)
      .map((r) => ({
        id: r.id as string,
        matterId: id,
        turnId: r.turn_id as string,
        startedAt: Number(r.started_at),
        endedAt: r.ended_at === null ? null : Number(r.ended_at),
        outcome: r.outcome as string | null,
      }));
  }
  close(): void {
    this.db.close();
  }
}
