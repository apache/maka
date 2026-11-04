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

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

export class NotebookValidationError extends Error {}
const id = z.string().min(1).max(1000);
const text = z.string().trim().min(1).max(12000);
export const memoryKind = z.enum(['observation', 'hypothesis', 'question', 'connection', 'legacy']);
export const memoryUpdate = z
  .object({
    entryId: id,
    expectedRevision: z.number().int().positive(),
    text,
    kind: memoryKind.exclude(['legacy']),
    sources: z.array(text).min(1).max(50),
    occurredAt: z.string().min(1).max(500).nullable().default(null),
    reason: text,
  })
  .strict();
export const memoryCheckpoint = z
  .object({ topicId: id, text, entryIds: z.array(id).max(100).default([]) })
  .strict();
export const memoryRemember = z
  .object({
    key: z.string().min(1).max(200),
    executionId: id,
    expectedFeedbackRevision: z.number().int().nonnegative(),
    notes: z
      .array(
        z
          .object({
            topicId: id,
            title: text,
            text,
            occurredAt: z.string().min(1).max(500).nullable().default(null),
            sources: z.array(text).min(1).max(50),
            tags: z.array(id).max(50).default([]),
            related: z.array(id).max(50).default([]),
            kind: memoryKind.exclude(['legacy']).default('observation'),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    updates: z.array(memoryUpdate).max(100).default([]),
    checkpoints: z.array(memoryCheckpoint).max(100).default([]),
  })
  .strict();
export const memoryRead = z
  .object({
    view: z
      .enum(['catalog', 'topic', 'entry', 'history', 'feedback', 'rules', 'deliveries', 'event'])
      .default('catalog'),
    topicId: id.optional(),
    entryId: id.optional(),
    revision: z.number().int().positive().optional(),
    eventId: id.optional(),
    query: z.string().trim().min(1).max(200).optional(),
    limit: z.number().int().min(1).max(100).default(20),
    cursor: z.string().max(8000).optional(),
  })
  .strict();
export type MemoryRead = z.infer<typeof memoryRead>;
type Event = { seq: number; id: string; kind: string; at: string; payload: any };
type Position = { selection: string; through: number; after: number };
const parse = (row: any): Event => ({
  ...row,
  seq: Number(row.seq),
  payload: JSON.parse(row.payload),
});

/** Rebuildable read projections. The existing events table remains the durable authority. */
export class NotebookMemory {
  private readonly secret: string;
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE INDEX IF NOT EXISTS notebook_events_kind ON events(kind,seq);
      CREATE INDEX IF NOT EXISTS notebook_feedback_resolution ON events(json_extract(payload,'$.feedbackId')) WHERE kind='feedback-resolution';
      CREATE TABLE IF NOT EXISTS notebook_memory_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notebook_topics(id TEXT PRIMARY KEY,title TEXT NOT NULL,seq INTEGER NOT NULL,tags TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS notebook_entries(id TEXT PRIMARY KEY,topic TEXT NOT NULL,revision INTEGER NOT NULL,seq INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS notebook_entries_topic ON notebook_entries(topic,seq);
      CREATE TABLE IF NOT EXISTS notebook_versions(entry TEXT NOT NULL,topic TEXT NOT NULL,revision INTEGER NOT NULL,seq INTEGER NOT NULL UNIQUE,PRIMARY KEY(entry,revision));
      CREATE INDEX IF NOT EXISTS notebook_versions_topic ON notebook_versions(topic,seq);
      CREATE INDEX IF NOT EXISTS notebook_versions_entry_seq ON notebook_versions(entry,seq);
      CREATE TABLE IF NOT EXISTS notebook_topic_events(topic TEXT NOT NULL,seq INTEGER NOT NULL,PRIMARY KEY(topic,seq));
      CREATE VIRTUAL TABLE IF NOT EXISTS notebook_search USING fts5(text,tokenize='trigram');`);
    db.prepare('INSERT OR IGNORE INTO notebook_memory_meta VALUES(?,?)').run('schema', '1');
    if (
      db.prepare("SELECT value FROM notebook_memory_meta WHERE key='schema'").get()?.value !== '1'
    )
      throw new NotebookValidationError('Unsupported notebook memory projection version');
    db.prepare('INSERT OR IGNORE INTO notebook_memory_meta VALUES(?,?)').run(
      'cursor-secret',
      randomBytes(32).toString('hex'),
    );
    this.secret = String(
      db.prepare('SELECT value FROM notebook_memory_meta WHERE key=?').get('cursor-secret')!.value,
    );
    this.catchUp();
  }
  private transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  /** Also imports events appended by an older binary after rollback, without rewriting them. */
  catchUp() {
    const current = Number(
      this.db.prepare("SELECT value FROM notebook_memory_meta WHERE key='through'").get()?.value ??
        0,
    );
    const latest = Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get()!.n);
    if (current === latest) return;
    this.transaction(() => {
      let after = Number(
        this.db.prepare("SELECT value FROM notebook_memory_meta WHERE key='through'").get()
          ?.value ?? 0,
      );
      for (;;) {
        const rows = this.db
          .prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 500')
          .all(after);
        if (!rows.length) break;
        for (const row of rows) {
          const event = parse(row);
          this.project(event);
          after = event.seq;
        }
      }
    });
  }
  /** Maintenance only: rebuild projections from committed events, retaining cursor identity. */
  rebuild() {
    this.transaction(() => {
      this.db.exec(
        "DELETE FROM notebook_topics; DELETE FROM notebook_entries; DELETE FROM notebook_versions; DELETE FROM notebook_topic_events; DELETE FROM notebook_search; DELETE FROM notebook_memory_meta WHERE key='through';",
      );
      this.catchUp();
    });
  }
  private entry(event: Event) {
    const p = event.payload;
    return {
      ...p,
      id: event.kind === 'note' ? event.id : p.entryId,
      revision: event.kind === 'note' ? 1 : p.revision,
      kind: p.kind ?? 'legacy',
      eventId: event.id,
      recordedAt: event.at,
    };
  }
  project(event: Event) {
    const p = event.payload;
    if (['note', 'entry-update'].includes(event.kind)) {
      const entry = this.entry(event);
      const topic = this.topic(entry.topicId);
      const tags = [...new Set([...(topic?.tags ?? []), ...(entry.tags ?? [])])];
      this.db
        .prepare(
          `INSERT INTO notebook_topics VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET tags=excluded.tags`,
        )
        .run(entry.topicId, entry.title, event.seq, JSON.stringify(tags));
      this.db
        .prepare(
          `INSERT INTO notebook_entries VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,seq=excluded.seq,payload=excluded.payload`,
        )
        .run(entry.id, entry.topicId, entry.revision, event.seq, JSON.stringify(entry));
      this.db
        .prepare('INSERT OR IGNORE INTO notebook_versions VALUES(?,?,?,?)')
        .run(entry.id, entry.topicId, entry.revision, event.seq);
      this.db
        .prepare('INSERT OR REPLACE INTO notebook_search(rowid,text) VALUES(?,?)')
        .run(event.seq, `${entry.title}\n${entry.text}`);
    }
    const topics = new Set<string>([...(p.topicId ? [p.topicId] : []), ...(p.topicIds ?? [])]);
    for (const reference of [p.preparedId, p.replyTo]) {
      if (typeof reference !== 'string') continue;
      for (const row of this.db
        .prepare(
          'SELECT t.topic FROM notebook_topic_events t JOIN events e ON e.seq=t.seq WHERE e.id=?',
        )
        .all(reference))
        topics.add(String(row.topic));
    }
    if (event.kind === 'feedback-resolution')
      for (const rule of p.rules) for (const topic of rule.topicIds) topics.add(topic);
    for (const topic of topics)
      this.db
        .prepare('INSERT OR IGNORE INTO notebook_topic_events VALUES(?,?)')
        .run(topic, event.seq);
    this.db
      .prepare(
        "INSERT INTO notebook_memory_meta VALUES('through',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(String(event.seq));
  }
  topic(topicId: string): any {
    const row = this.db.prepare('SELECT * FROM notebook_topics WHERE id=?').get(topicId);
    return row ? { id: row.id, title: row.title, tags: JSON.parse(String(row.tags)) } : undefined;
  }
  current(entryId: string): any {
    const row = this.db.prepare('SELECT payload FROM notebook_entries WHERE id=?').get(entryId);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  topics() {
    const topics = new Map<string, any>();
    for (const row of this.db.prepare('SELECT * FROM notebook_topics ORDER BY seq').all()) {
      topics.set(String(row.id), {
        id: row.id,
        title: row.title,
        tags: JSON.parse(String(row.tags)),
        notes: [],
      });
    }
    for (const row of this.db
      .prepare('SELECT topic,payload FROM notebook_entries ORDER BY seq')
      .all()) {
      topics.get(String(row.topic))!.notes.push(JSON.parse(String(row.payload)));
    }
    return topics;
  }
  topicEvents(topicId: string, kind: string): Event[] {
    return this.db
      .prepare(
        'SELECT e.* FROM notebook_topic_events t JOIN events e ON e.seq=t.seq WHERE t.topic=? AND e.kind=? ORDER BY e.seq',
      )
      .all(topicId, kind)
      .map(parse);
  }
  private sign(value: string) {
    return createHmac('sha256', this.secret).update(value).digest('hex');
  }
  private encode(position: Position) {
    const body = Buffer.from(JSON.stringify(position)).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }
  private position(input: MemoryRead): Position {
    const selection = createHash('sha256')
      .update(
        JSON.stringify([
          input.view,
          input.topicId ?? null,
          input.entryId ?? null,
          input.revision ?? null,
          input.eventId ?? null,
          input.query ?? null,
        ]),
      )
      .digest('hex');
    if (!input.cursor)
      return {
        selection,
        through: Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get()!.n),
        after: 0,
      };
    try {
      const [body, signature, extra] = input.cursor.split('.');
      const expected = this.sign(body);
      if (
        extra ||
        signature?.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      )
        throw Error();
      const p = JSON.parse(Buffer.from(body, 'base64url').toString());
      if (
        p.selection !== selection ||
        !Number.isSafeInteger(p.through) ||
        p.through < 0 ||
        !Number.isSafeInteger(p.after) ||
        p.after < 0
      )
        throw Error();
      return p;
    } catch {
      throw new NotebookValidationError(
        'Invalid notebook cursor or changed query; start a new read',
      );
    }
  }
  private page(input: MemoryRead, position: Position, rows: { key: number; item: any }[]) {
    const items: any[] = [];
    let after = position.after;
    let more = false;
    for (const row of rows) {
      let item = row.item;
      if (Buffer.byteLength(JSON.stringify(item)) > 4200) {
        item = {
          id: item.id,
          topicId: item.topicId,
          revision: item.revision,
          kind: item.kind,
          text: String(item.text ?? item.title ?? '').slice(0, 200),
          truncated: true,
          read:
            item.read ??
            (item.revision
              ? { view: 'entry', entryId: item.id, revision: item.revision }
              : { view: 'event', eventId: item.id }),
        };
      }
      if (
        items.length >= input.limit ||
        Buffer.byteLength(JSON.stringify([...items, item])) > 5000
      ) {
        more = true;
        break;
      }
      items.push(item);
      after = row.key;
    }
    return {
      view: input.view,
      items,
      through: position.through,
      nextCursor: more ? this.encode({ ...position, after }) : null,
      readOnly: true,
    };
  }
  private body(input: MemoryRead, p: Position) {
    let row: any;
    if (input.view === 'event')
      row = this.db
        .prepare('SELECT * FROM events WHERE id=? AND seq<=?')
        .get(input.eventId ?? '', p.through);
    else {
      row = this.db
        .prepare(
          `SELECT e.* FROM notebook_versions v JOIN events e ON e.seq=v.seq WHERE v.entry=? AND v.seq<=? AND (? IS NULL OR v.revision=?) ORDER BY v.seq DESC LIMIT 1`,
        )
        .get(input.entryId ?? '', p.through, input.revision ?? null, input.revision ?? null);
    }
    if (!row) throw new NotebookValidationError('Unknown notebook record');
    const event = parse(row);
    const content = JSON.stringify(input.view === 'entry' ? this.entry(event) : event);
    if (
      p.after > content.length ||
      (p.after > 0 && /[\uDC00-\uDFFF]/u.test(content[p.after] ?? ''))
    )
      throw new NotebookValidationError('Invalid text offset');
    let text = '';
    for (const character of content.slice(p.after)) {
      if (Buffer.byteLength(JSON.stringify(text + character)) > 4800) break;
      text += character;
    }
    const after = p.after + text.length;
    return {
      view: input.view,
      text,
      offset: p.after,
      totalCharacters: content.length,
      through: p.through,
      nextCursor: after < content.length ? this.encode({ ...p, after }) : null,
      readOnly: true,
    };
  }
  read(raw: unknown) {
    const input = memoryRead.parse(raw);
    if (input.query && !['catalog', 'topic'].includes(input.view))
      throw new NotebookValidationError('query is supported only for catalog and topic reads');
    this.catchUp();
    const p = this.position(input);
    if (input.view === 'entry' || input.view === 'event') return this.body(input, p);
    const rows: { key: number; item: any }[] = [];
    if (input.view === 'catalog') {
      const topics = this.db
        .prepare(
          'SELECT * FROM notebook_topics WHERE seq<? AND seq<=? AND (? IS NULL OR instr(lower(title),lower(?))>0) ORDER BY seq DESC LIMIT ?',
        )
        .all(
          p.after || p.through + 1,
          p.through,
          input.query ?? null,
          input.query ?? null,
          input.limit + 1,
        );
      for (const topic of topics)
        rows.push({
          key: Number(topic.seq),
          item: { id: topic.id, title: topic.title, read: { view: 'topic', topicId: topic.id } },
        });
    } else if (input.view === 'topic') {
      if (!input.topicId || !this.topic(input.topicId))
        throw new NotebookValidationError('Unknown notebook topic');
      const query = input.query;
      const search = !query
        ? ''
        : [...query].length >= 3
          ? 'AND v.seq IN (SELECT rowid FROM notebook_search WHERE text MATCH ?)'
          : "AND instr(lower(json_extract(e.payload,'$.text')),lower(?))>0";
      const args: any[] = [input.topicId, p.after, p.through, p.through];
      if (query) args.push([...query].length >= 3 ? `"${query.replaceAll('"', '""')}"` : query);
      args.push(input.limit + 1);
      const versions = this.db
        .prepare(
          `SELECT v.seq,e.* FROM notebook_versions v JOIN events e ON e.seq=v.seq WHERE v.topic=? AND v.seq>? AND v.seq<=? AND NOT EXISTS(SELECT 1 FROM notebook_versions newer WHERE newer.entry=v.entry AND newer.seq>v.seq AND newer.seq<=?) ${search} ORDER BY v.seq LIMIT ?`,
        )
        .all(...args);
      for (const row of versions) rows.push({ key: Number(row.seq), item: this.entry(parse(row)) });
    } else {
      let sql = 'SELECT e.* FROM events e';
      const args: any[] = [];
      if (input.topicId) {
        sql += ' JOIN notebook_topic_events t ON t.seq=e.seq AND t.topic=?';
        args.push(input.topicId);
      }
      sql += ' WHERE e.seq>? AND e.seq<=?';
      args.push(p.after, p.through);
      if (input.view === 'feedback') {
        sql +=
          " AND e.kind='feedback' AND EXISTS(SELECT 1 FROM events d WHERE d.id=json_extract(e.payload,'$.replyTo') AND d.kind='delivery') AND NOT EXISTS(SELECT 1 FROM events r WHERE r.kind='feedback-resolution' AND json_extract(r.payload,'$.feedbackId')=e.id AND r.seq<=?)";
        args.push(p.through);
      } else if (input.view === 'rules')
        sql +=
          " AND e.kind='feedback-resolution' AND json_array_length(e.payload,'$.rules')>0 AND EXISTS(SELECT 1 FROM events f JOIN events d ON d.id=json_extract(f.payload,'$.replyTo') AND d.kind='delivery' WHERE f.id=json_extract(e.payload,'$.feedbackId') AND f.kind='feedback')";
      else if (input.view === 'deliveries') sql += " AND e.kind IN ('delivery','reported')";
      else
        sql +=
          " AND e.kind IN ('note','entry-update','research-checkpoint','withheld','feedback','feedback-resolution','reopen','delivery','reported')";
      sql += ' ORDER BY e.seq LIMIT ?';
      args.push(input.limit + 1);
      for (const raw of this.db.prepare(sql).all(...args)) {
        const event = parse(raw);
        const metadata = Object.fromEntries(
          [
            'topicId',
            'topicIds',
            'sources',
            'entryId',
            'entryIds',
            'revision',
            'previousEventId',
            'feedbackId',
            'replyTo',
            'preparedId',
            'messageIds',
            'rules',
          ]
            .filter((key) => event.payload[key] !== undefined)
            .map((key) => [key, event.payload[key]]),
        );
        rows.push({
          key: event.seq,
          item: {
            id: event.id,
            kind: event.kind,
            at: event.at,
            ...metadata,
            text: event.payload.text ?? event.payload.reason ?? event.payload.understanding ?? '',
            read: { view: 'event', eventId: event.id },
          },
        });
      }
    }
    return this.page(input, p, rows);
  }
}
