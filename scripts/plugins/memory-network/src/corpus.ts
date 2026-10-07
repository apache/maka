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

import { createHash, randomUUID } from 'node:crypto';
import { NetworkStore, sourceOf, type Index } from './store.js';

type RecordHead = {
  key: string;
  source: string;
  id: string;
  revision: string;
  title?: string;
  updatedAt?: string | number;
  documents: string[];
};
export type Cursor = { id: string; createdAt: number; sources: string[]; records: RecordHead[] };
export type WorkRange = {
  id: string;
  indexId: string;
  from: string | null;
  to: string;
  visibility: string[];
  completed: boolean;
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Opaque snapshot boundaries, independent of read pagination and index content edits. */
export class CorpusStore extends NetworkStore {
  constructor(directory: string) {
    super(directory);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_worker_sessions(session_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS memory_source_records(key TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_cursors(id TEXT PRIMARY KEY,fingerprint TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_boundaries(index_id TEXT PRIMARY KEY,cursor_id TEXT,notes TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS memory_work_ranges(index_id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    `);
    for (const row of this.db.prepare('SELECT payload FROM workers').all()) {
      const worker = JSON.parse(String(row.payload));
      if (worker.sessionId)
        this.db
          .prepare('INSERT OR IGNORE INTO memory_worker_sessions VALUES(?)')
          .run(worker.sessionId);
    }
  }
  rememberRecord(head: Omit<RecordHead, 'documents'>, messages: readonly any[]) {
    this.transaction(() => {
      const ids = messages.map((m) => {
        const row = this.db
          .prepare(
            'SELECT id FROM documents WHERE session=? AND message=? AND hash=? ORDER BY rowid DESC LIMIT 1',
          )
          .get(head.key, m.id, digest(m));
        if (!row) throw Error('Original version not retained');
        return String(row.id);
      });
      this.db
        .prepare(
          'INSERT INTO memory_source_records VALUES(?,?) ON CONFLICT(key) DO UPDATE SET payload=excluded.payload',
        )
        .run(head.key, JSON.stringify({ ...head, documents: ids }));
    });
  }
  record(key: string): RecordHead | undefined {
    const row = this.db.prepare('SELECT payload FROM memory_source_records WHERE key=?').get(key);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  capture(sources: string[], visible: string[], sessions: string[] = []): Cursor {
    const records = visible
      .filter(
        (key) =>
          sources.includes(sourceOf(key)) &&
          (sourceOf(key) !== 'maka' || !sessions.length || sessions.includes(key)),
      )
      .sort()
      .map((key) => {
        const record = this.record(key);
        if (!record) throw Error('Source record has not been synchronized');
        return record;
      });
    const fingerprint = digest({ sources: [...sources].sort(), records });
    const old = this.db
      .prepare('SELECT payload FROM memory_cursors WHERE fingerprint=?')
      .get(fingerprint);
    if (old) return JSON.parse(String(old.payload));
    const cursor = {
      id: randomUUID(),
      createdAt: Date.now(),
      sources: [...sources].sort(),
      records,
    };
    this.db
      .prepare('INSERT INTO memory_cursors VALUES(?,?,?)')
      .run(cursor.id, fingerprint, JSON.stringify(cursor));
    return cursor;
  }
  cursor(id: string): Cursor {
    const row = this.db.prepare('SELECT payload FROM memory_cursors WHERE id=?').get(id);
    if (!row) throw Error('Unknown history cursor');
    return JSON.parse(String(row.payload));
  }
  assertVisible(cursor: Cursor, visible: string[]) {
    if (cursor.records.some((r) => !visible.includes(r.key)))
      throw Error('Cursor source visibility changed; refresh the range');
  }
  boundary(indexId: string): string | null {
    return (
      (this.db.prepare('SELECT cursor_id FROM memory_boundaries WHERE index_id=?').get(indexId)
        ?.cursor_id as string) ?? null
    );
  }
  range(from: string | null, to: string, visible: string[]) {
    const end = this.cursor(to);
    this.assertVisible(end, visible);
    const begin = from ? this.cursor(from) : undefined;
    // Hidden sources are never released even when mentioned by an older checkpoint.
    const old = new Map(begin?.records.map((r) => [r.key, r]) ?? []);
    const records = end.records.map((r) => {
      const previous = new Set(old.get(r.key)?.documents ?? []);
      return {
        ...r,
        delta: r.documents.filter((id) => !previous.has(id)),
        removed: (old.get(r.key)?.documents ?? []).filter((id) => !r.documents.includes(id)),
      };
    });
    const removedRecords = (begin?.records ?? []).filter(
      (r) => !end.records.some((e) => e.key === r.key) && visible.includes(r.key),
    );
    return { end, records, removedRecords };
  }
  describe(from: string | null, to: string, visible: string[]) {
    const r = this.range(from, to, visible);
    return {
      from,
      to,
      kind: from ? 'incremental' : 'existing',
      capturedAt: r.end.createdAt,
      sources: r.end.sources.map((source) => {
        const records = r.records.filter((x) => x.source === source);
        return {
          source,
          records: records.length,
          changedRecords: records.filter((x) => x.delta.length || x.removed.length).length,
          newOrChangedMessages: records.reduce((n, x) => n + x.delta.length, 0),
          removedMessages: records.reduce((n, x) => n + x.removed.length, 0),
          removedRecords: r.removedRecords.filter((x) => x.source === source).map((x) => x.id),
        };
      }),
      meaning:
        'Opaque immutable source snapshots. from=null is existing history; otherwise the difference is incremental. Reading and writing index text never advance this boundary. A checkpoint is the Agent declaration of organization, not proof that every log line was read.',
    };
  }
  pending(indexId: string, to: string, visible: string[]) {
    const r = this.range(this.boundary(indexId), to, visible);
    return (
      r.records.reduce((n, x) => n + x.delta.length + x.removed.length, 0) + r.removedRecords.length
    );
  }
  work(indexId: string): WorkRange | undefined {
    const row = this.db
      .prepare('SELECT payload FROM memory_work_ranges WHERE index_id=?')
      .get(indexId);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  begin(indexId: string, to: string, visible: string[]): WorkRange {
    const old = this.work(indexId);
    if (old && !old.completed) {
      this.assertVisible(this.cursor(old.to), visible);
      return old;
    }
    this.assertVisible(this.cursor(to), visible);
    const range: WorkRange = {
      id: randomUUID(),
      indexId,
      from: this.boundary(indexId),
      to,
      visibility: [...visible].sort(),
      completed: false,
    };
    this.db
      .prepare(
        'INSERT INTO memory_work_ranges VALUES(?,?) ON CONFLICT(index_id) DO UPDATE SET payload=excluded.payload',
      )
      .run(indexId, JSON.stringify(range));
    return range;
  }
  checkpoint(
    indexId: string,
    rangeId: string,
    expectedRevision: number,
    notes: string,
    complete: boolean,
    visible: string[],
    sessionId?: string,
  ) {
    return this.transaction(() => {
      const work = this.work(indexId);
      if (!work || work.id !== rangeId)
        throw Error('Range was superseded; read current index information');
      this.assertVisible(this.cursor(work.to), visible);
      if (work.completed) {
        if (this.boundary(indexId) !== work.to)
          throw Error('Coverage changed after this checkpoint');
        return { cursor: work.to, complete: true };
      }
      if (this.boundary(indexId) !== work.from) throw Error('Coverage changed; stale checkpoint');
      if (this.index(indexId).revision !== expectedRevision)
        throw Error('Index content changed; read it before checkpointing');
      this.db
        .prepare(
          'INSERT INTO memory_boundaries VALUES(?,?,?) ON CONFLICT(index_id) DO UPDATE SET cursor_id=excluded.cursor_id,notes=excluded.notes',
        )
        .run(indexId, complete ? work.to : work.from, notes);
      if (complete) {
        work.completed = true;
        this.db
          .prepare('UPDATE memory_work_ranges SET payload=? WHERE index_id=?')
          .run(JSON.stringify(work), indexId);
      }
      this.db
        .prepare('INSERT INTO commits(index_id,at,body) VALUES(?,?,?)')
        .run(
          indexId,
          Date.now(),
          JSON.stringify({ rangeId, complete, notes, from: work.from, to: work.to, sessionId }),
        );
      return { cursor: complete ? work.to : work.from, complete };
    });
  }
  latestCheckpoint(indexId: string, rangeId: string, sessionId: string) {
    const row = this.db
      .prepare(
        `SELECT id,body FROM commits WHERE index_id=?
       AND json_extract(body,'$.rangeId')=? AND json_extract(body,'$.sessionId')=?
       ORDER BY id DESC LIMIT 1`,
      )
      .get(indexId, rangeId, sessionId);
    return row
      ? { id: Number(row.id), complete: JSON.parse(String(row.body)).complete as boolean }
      : null;
  }
  notes(indexId: string) {
    return (
      this.db.prepare('SELECT notes FROM memory_boundaries WHERE index_id=?').get(indexId)?.notes ??
      ''
    );
  }
  history(
    from: string | null,
    to: string,
    visible: string[],
    input: any,
    select: (messages: unknown[], request: any) => any,
  ) {
    const r = this.range(from, to, visible);
    const request = {
      view: input.view,
      types: input.types,
      messageId: input.messageId,
      query: input.query,
      since: input.since,
      until: input.until,
      limit: 500,
    };
    const records = r.records.filter(
      (x) =>
        (!input.source || x.source === input.source) &&
        (!input.recordId || x.id === input.recordId) &&
        (!input.recordIds || input.recordIds.includes(x.id)),
    );
    const results: any[] = [];
    for (const record of records) {
      const ids = from ? record.delta : record.documents;
      const messages = ids.map((id) =>
        JSON.parse(String(this.db.prepare('SELECT body FROM documents WHERE id=?').get(id)!.body)),
      );
      // Projection uses the standard runtime filter, never an ingestion-time type policy.
      const pages: any[] = [];
      let after = -1;
      let summary: any;
      do {
        summary = select(messages, { ...request, after });
        pages.push(...summary.items);
        after = summary.next;
      } while (after !== null);
      if (input.mode === 'records') {
        if (!pages.length && !record.removed.length && (input.query || input.types || from))
          continue;
        results.push({
          source: record.source,
          recordId: record.id,
          title: record.title ?? record.id,
          revision: record.revision,
          matchedMessages: pages.length,
          typeCounts: summary.typeCounts,
          removedMessages: record.removed.length,
        });
      } else
        for (const item of pages) {
          results.push({
            source: record.source,
            recordId: record.id,
            ref: `${ids[item.position]}:0`,
            citation: `[source](memory-original:${ids[item.position]}:0)`,
            message: item.message,
          });
        }
    }
    const offset = input.offset ?? 0,
      limit = input.limit ?? 30;
    return {
      from,
      to,
      total: results.length,
      items: results.slice(offset, offset + limit),
      nextOffset: offset + limit < results.length ? offset + limit : null,
      notice:
        'Pagination is navigation only. All message types are included unless you explicitly choose types or view. Choose any records, searches, dates, or types; no batches must be consumed.',
    };
  }
  assertIndexVisible(indexId: string, visible: string[]) {
    const cursor = this.work(indexId)?.to ?? this.boundary(indexId);
    if (cursor) this.assertVisible(this.cursor(cursor), visible);
  }
  override entries(indexId: string, visible: string[], after = '', limit = 100) {
    this.assertIndexVisible(indexId, visible);
    return super.entries(indexId, visible, after, limit);
  }
  override overview(indexId: string, visible: string[]) {
    return { ...super.overview(indexId, visible), readFull: 'MemoryIndexContent' };
  }
  override original(ref: string, visible: string[]) {
    const original = super.original(ref, visible);
    return {
      ...original,
      backlinks: original.backlinks.filter((link) => {
        try {
          this.assertIndexVisible(String(link.index_id), visible);
          return true;
        } catch {
          return false;
        }
      }),
    };
  }
  content(indexId: string, key: string, visible: string[]) {
    this.assertIndexVisible(indexId, visible);
    this.index(indexId);
    const row = this.db
      .prepare('SELECT body FROM entries WHERE index_id=? AND id=?')
      .get(indexId, key);
    if (!row) return { key, text: '', revision: this.index(indexId).revision };
    const refs = this.db
      .prepare('SELECT ref FROM links WHERE index_id=? AND entry_id=?')
      .all(indexId, key);
    refs.forEach((r) => this.fragment(String(r.ref), visible));
    return { key, text: String(row.body), revision: this.index(indexId).revision };
  }
  write(indexId: string, key: string, text: string, expectedRevision: number, visible: string[]) {
    return this.transaction(() => {
      this.assertIndexVisible(indexId, visible);
      const index = this.index(indexId);
      if (index.revision !== expectedRevision)
        throw Error('Index content changed; read the current revision');
      const refs = [
        ...new Set([...text.matchAll(/memory-original:([^\s)\]]+)/g)].map((m) => m[1])),
      ];
      const scope = this.scope(index, visible);
      for (const ref of refs) {
        const original = this.fragment(ref, visible);
        if (!scope.includes(String(original.session)))
          throw Error(`Citation outside index scope: ${ref}`);
      }
      this.db.prepare('DELETE FROM links WHERE index_id=? AND entry_id=?').run(indexId, key);
      if (!text) this.db.prepare('DELETE FROM entries WHERE index_id=? AND id=?').run(indexId, key);
      else {
        this.db
          .prepare(
            'INSERT INTO entries VALUES(?,?,?) ON CONFLICT(index_id,id) DO UPDATE SET body=excluded.body',
          )
          .run(indexId, key, text);
        for (const ref of refs)
          this.db.prepare('INSERT INTO links VALUES(?,?,?)').run(indexId, key, ref);
      }
      index.revision++;
      this.save(index);
      this.db
        .prepare('INSERT INTO commits(index_id,at,body) VALUES(?,?,?)')
        .run(indexId, Date.now(), JSON.stringify({ key, text, refs, revision: index.revision }));
      return { key, revision: index.revision, coverageAdvanced: false };
    });
  }
}
