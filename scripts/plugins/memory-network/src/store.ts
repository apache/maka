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
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Index = {
  id: string;
  name: string;
  instructions: string;
  sessions: string[];
  sources?: string[];
  revision: number;
  covered: number;
  view: string;
};
export type Entry = { id: string; body: string; refs: string[] };
export const sourceKey = (source: string, record: string) =>
  source === 'maka' ? record : JSON.stringify([source, record]);
export const sourceOf = (key: string): string => {
  try {
    const v = JSON.parse(key);
    return Array.isArray(v) ? v[0] : 'maka';
  } catch {
    return 'maka';
  }
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class NetworkStore {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true });
    this.db = new DatabaseSync(join(directory, 'network.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,session TEXT NOT NULL,message TEXT NOT NULL,hash TEXT NOT NULL,position INTEGER NOT NULL,body TEXT NOT NULL,observed INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS document_source ON documents(session,message,observed);
      CREATE TABLE IF NOT EXISTS fragments(seq INTEGER PRIMARY KEY AUTOINCREMENT,ref TEXT UNIQUE NOT NULL,document TEXT NOT NULL REFERENCES documents(id),part INTEGER NOT NULL,text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS indexes(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries(index_id TEXT NOT NULL REFERENCES indexes(id),id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(index_id,id));
      CREATE TABLE IF NOT EXISTS links(index_id TEXT NOT NULL,entry_id TEXT NOT NULL,ref TEXT NOT NULL REFERENCES fragments(ref),PRIMARY KEY(index_id,entry_id,ref),FOREIGN KEY(index_id,entry_id) REFERENCES entries(index_id,id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS backlinks ON links(ref);
      CREATE TABLE IF NOT EXISTS batches(id TEXT PRIMARY KEY,index_id TEXT NOT NULL,revision INTEGER NOT NULL,through_seq INTEGER NOT NULL,refs TEXT NOT NULL,view TEXT NOT NULL,receipt TEXT);
      CREATE TABLE IF NOT EXISTS commits(id INTEGER PRIMARY KEY AUTOINCREMENT,index_id TEXT NOT NULL,at INTEGER NOT NULL,body TEXT NOT NULL);`);
    // Coverage v2 records exact immutable fragments. Legacy progress is translated once,
    // retaining old evidence/links; legacy issued batches are retired, not reused.
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS memory_meta(key TEXT PRIMARY KEY,value TEXT);
        CREATE TABLE IF NOT EXISTS coverage(index_id TEXT NOT NULL,ref TEXT NOT NULL REFERENCES fragments(ref),PRIMARY KEY(index_id,ref));
        CREATE TABLE IF NOT EXISTS source_heads(key TEXT PRIMARY KEY,revision TEXT NOT NULL,checked_at INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS workers(index_id TEXT PRIMARY KEY,payload TEXT NOT NULL);`);
      if (!this.db.prepare("SELECT 1 FROM memory_meta WHERE key='coverage-v2'").get()) {
        for (const index of this.list()) {
          const scope: string[] = index.view ? JSON.parse(index.view) : [];
          for (const session of scope)
            this.db
              .prepare(`INSERT OR IGNORE INTO coverage
            SELECT ?,f.ref FROM fragments f JOIN documents d ON d.id=f.document WHERE d.session=? AND f.seq<=?`)
              .run(index.id, session, index.covered);
        }
        this.db.exec(
          "DELETE FROM batches WHERE receipt IS NULL; INSERT INTO memory_meta VALUES('coverage-v2','1')",
        );
      }
    });
  }
  lease(owner: string, release = false) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT value FROM memory_meta WHERE key='owner'").get();
      const prior = row ? JSON.parse(String(row.value)) : null;
      if (prior && prior.owner !== owner && prior.until > Date.now()) return false;
      this.db
        .prepare(
          "INSERT INTO memory_meta VALUES('owner',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(JSON.stringify({ owner, until: release ? 0 : Date.now() + 60000 }));
      return true;
    });
  }
  close() {
    this.db.close();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  ingest(session: string, messages: readonly any[]) {
    return this.transaction(() => {
      let added = 0;
      messages.forEach((message, position) => {
        if (typeof message.id !== 'string')
          throw Error('History message has no stable ID; coverage was not advanced');
        const body = JSON.stringify(message),
          digest = hash(body);
        const prior = this.db
          .prepare(
            'SELECT hash FROM documents WHERE session=? AND message=? ORDER BY rowid DESC LIMIT 1',
          )
          .get(session, message.id);
        if (prior?.hash === digest) return;
        const id = randomUUID();
        this.db
          .prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?)')
          .run(id, session, message.id, digest, position, body, Date.now());
        for (let start = 0, part = 0; start < body.length; part++) {
          let end = Math.min(start + 8000, body.length);
          const code = body.charCodeAt(end - 1);
          if (end < body.length && code >= 0xd800 && code <= 0xdbff) end--;
          this.db
            .prepare('INSERT INTO fragments(ref,document,part,text) VALUES(?,?,?,?)')
            .run(`${id}:${part}`, id, part, body.slice(start, end));
          added++;
          start = end;
        }
      });
      return added;
    });
  }
  create(name: string, instructions: string, sessions: string[], sources = ['maka']): Index {
    const index = {
      id: randomUUID(),
      name,
      instructions,
      sources: [...new Set(sources)].sort(),
      sessions: [...new Set(sessions)].sort(),
      revision: 0,
      covered: 0,
      view: '',
    };
    this.db.prepare('INSERT INTO indexes VALUES(?,?)').run(index.id, JSON.stringify(index));
    return index;
  }
  list(): Index[] {
    return this.db
      .prepare('SELECT payload FROM indexes ORDER BY rowid')
      .all()
      .map((r) => JSON.parse(String(r.payload)));
  }
  index(id: string): Index {
    const row = this.db.prepare('SELECT payload FROM indexes WHERE id=?').get(id);
    if (!row) throw Error('Unknown index');
    return JSON.parse(String(row.payload));
  }
  save(index: Index) {
    this.db.prepare('UPDATE indexes SET payload=? WHERE id=?').run(JSON.stringify(index), index.id);
  }
  scope(index: Index, visible: string[]) {
    return visible
      .filter(
        (s) =>
          (index.sources ?? ['maka']).includes(sourceOf(s)) &&
          (sourceOf(s) !== 'maka' || !index.sessions.length || index.sessions.includes(s)),
      )
      .sort();
  }
  align(id: string, visible: string[]) {
    const index = this.index(id),
      view = JSON.stringify(this.scope(index, visible));
    if (index.view !== view) {
      index.view = view;
      index.revision++;
      this.save(index);
    }
    return index;
  }
  fragment(ref: string, visible: string[]) {
    const row = this.db
      .prepare(
        'SELECT f.*,d.session,d.message,d.position,d.observed,LENGTH(d.body) AS totalChars FROM fragments f JOIN documents d ON d.id=f.document WHERE ref=?',
      )
      .get(ref);
    if (!row || !visible.includes(String(row.session)))
      throw Error('Original is missing or outside current history visibility');
    return row;
  }
  entries(id: string, visible: string[], after = '', limit = 30) {
    const rows = this.db
      .prepare('SELECT id,body FROM entries WHERE index_id=? AND id>? ORDER BY id LIMIT ?')
      .all(id, after, limit + 1);
    const items = rows.slice(0, limit).flatMap((r) => {
      const refs = this.db
        .prepare('SELECT ref FROM links WHERE index_id=? AND entry_id=? ORDER BY ref')
        .all(id, r.id!)
        .map((l) => String(l.ref));
      try {
        refs.forEach((ref) => this.fragment(ref, visible));
        return [{ id: String(r.id), body: String(r.body), refs }];
      } catch {
        return [];
      }
    });
    return { items, next: rows.length > limit ? String(rows[limit - 1].id) : null };
  }
  allEntries(id: string, visible: string[]) {
    const items: ReturnType<NetworkStore['entries']>['items'] = [];
    let after = '';
    do {
      const page = this.entries(id, visible, after, 1000);
      items.push(...page.items);
      if (!page.next) break;
      after = page.next;
    } while (true);
    return items;
  }
  overview(id: string, visible: string[]) {
    const items = this.allEntries(id, visible);
    return {
      total: items.length,
      chars: items.reduce((n, e) => n + e.body.length, 0),
      items: items.map((entry) => ({
        id: entry.id,
        title:
          entry.body
            .split('\n')
            .find((line) => line.trim())
            ?.replace(/^#+\s*/, '')
            .slice(0, 200) ?? entry.id,
        chars: entry.body.length,
        citations: entry.refs.length,
      })),
      next: null,
      readFull: 'MemoryIndexEntries',
    };
  }
  coverage(id: string, visible: string[]) {
    const index = this.index(id),
      scope = this.scope(index, visible);
    const sources = (index.sources ?? ['maka']).map((source) => {
      let total = 0,
        processed = 0;
      for (const key of scope.filter((k) => sourceOf(k) === source)) {
        const row = this.db
          .prepare(`SELECT COUNT(*) total,COUNT(c.ref) processed FROM fragments f
          JOIN documents d ON d.id=f.document LEFT JOIN coverage c ON c.ref=f.ref AND c.index_id=? WHERE d.session=?`)
          .get(id, key)!;
        total += Number(row.total);
        processed += Number(row.processed);
      }
      return {
        source,
        observedFragments: total,
        processedFragments: processed,
        unprocessedFragments: total - processed,
      };
    });
    return {
      indexId: id,
      sources,
      unprocessed: sources.reduce((n, s) => n + s.unprocessedFragments, 0),
      meaning:
        'Processed under this index criterion, even if no entry was needed. Coverage is per original version, not event time. Source synchronization may lag.',
    };
  }
  uncovered(
    id: string,
    visible: string[],
    options: {
      source?: string;
      query?: string;
      after?: number;
      limit?: number;
      state?: 'unprocessed' | 'processed' | 'all';
      before?: number;
    } = {},
  ) {
    const index = this.index(id),
      scope = this.scope(index, visible).filter(
        (k) => !options.source || sourceOf(k) === options.source,
      );
    const limit = options.limit ?? 10;
    if (!scope.length) return { items: [], next: null };
    const state = options.state ?? 'unprocessed';
    const rows = this.db
      .prepare(`SELECT f.*,d.session,d.message,d.position,d.observed,LENGTH(d.body) totalChars,
      c.ref IS NOT NULL processed FROM fragments f JOIN documents d ON d.id=f.document
      LEFT JOIN coverage c ON c.ref=f.ref AND c.index_id=?
      WHERE d.session IN (${scope.map(() => '?')}) AND f.seq>? AND f.seq<=?
      ${state === 'unprocessed' ? 'AND c.ref IS NULL' : state === 'processed' ? 'AND c.ref IS NOT NULL' : ''}
      AND instr(lower(f.text),lower(?))>0 ORDER BY f.seq LIMIT ?`)
      .all(
        id,
        ...scope,
        options.after ?? 0,
        options.before ?? Number.MAX_SAFE_INTEGER,
        options.query ?? '',
        limit + 1,
      );
    return {
      items: rows
        .slice(0, limit)
        .map((row): any => ({ ...row, source: sourceOf(String(row.session)) })),
      next: rows.length > limit ? Number(rows[limit - 1].seq) : null,
    };
  }
  batch(
    id: string,
    visible: string[],
    limit = 5,
    before = Number.MAX_SAFE_INTEGER,
    maxChars = 64000,
  ) {
    return this.transaction(() => {
      const index = this.align(id, visible);
      const page = this.uncovered(id, visible, { limit, before });
      // Keep complete immutable fragments. A single fragment must always fit so
      // character limits cannot strand coverage at an oversized first item.
      const items: typeof page.items = [];
      let chars = 0;
      for (const item of page.items) {
        const size = String(item.text).length;
        if (items.length && chars + size > maxChars) break;
        items.push(item);
        chars += size;
      }
      const idBatch = randomUUID();
      this.db
        .prepare('INSERT INTO batches VALUES(?,?,?,?,?,?,NULL)')
        .run(idBatch, id, index.revision, 0, JSON.stringify(items.map((r) => r.ref)), index.view);
      return {
        index,
        batchId: idBatch,
        items,
        hasMore: items.length < page.items.length || page.next !== null,
        coverageNotice:
          'Commit marks only these exact original versions as processed; later arrivals and other sources remain pending.',
      };
    });
  }
  head(key: string) {
    return this.db.prepare('SELECT revision,checked_at FROM source_heads WHERE key=?').get(key);
  }
  setHead(key: string, revision: string) {
    this.db
      .prepare(
        'INSERT INTO source_heads VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,checked_at=excluded.checked_at',
      )
      .run(key, revision, Date.now());
  }
  worker(id: string): any {
    const row = this.db.prepare('SELECT payload FROM workers WHERE index_id=?').get(id);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  saveWorker(id: string, value: any) {
    this.db
      .prepare(
        'INSERT INTO workers VALUES(?,?) ON CONFLICT(index_id) DO UPDATE SET payload=excluded.payload',
      )
      .run(id, JSON.stringify(value));
  }
  highWater() {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) n FROM fragments').get()!.n);
  }
  commit(batchId: string, changes: Entry[], remove: string[], visible: string[]) {
    return this.transaction(() => {
      const batch = this.db.prepare('SELECT * FROM batches WHERE id=?').get(batchId);
      if (!batch) throw Error('Unknown batch');
      const signature = hash(JSON.stringify({ changes, remove }));
      if (batch.receipt) {
        const receipt = JSON.parse(String(batch.receipt));
        if (receipt.signature !== signature)
          throw Error('Batch already committed with different content');
        return receipt;
      }
      const index = this.index(String(batch.index_id));
      if (
        index.revision !== batch.revision ||
        JSON.stringify(this.scope(index, visible)) !== batch.view
      )
        throw Error('Index or source scope changed; read a fresh batch');
      const invalidRefs: { entryId: string; ref: string }[] = [];
      const scope = this.scope(index, visible);
      for (const entry of changes) {
        if (!entry.refs.length) throw Error('Every index entry must cite originals');
        for (const ref of entry.refs) {
          try {
            const original = this.fragment(ref, visible);
            if (!scope.includes(String(original.session))) throw Error('Outside index scope');
          } catch {
            invalidRefs.push({ entryId: entry.id, ref });
          }
        }
      }
      if (invalidRefs.length)
        throw Error(
          `Original is missing or outside current history visibility/index scope. Invalid submitted references: ${JSON.stringify(invalidRefs)}. Copy exact refs from the supplied originals; fetching a new batch does not repair a mistyped ref. No entries or coverage were committed. Re-submit all intended changes after correcting references.`,
        );
      for (const entry of changes) {
        this.db
          .prepare(
            'INSERT INTO entries VALUES(?,?,?) ON CONFLICT(index_id,id) DO UPDATE SET body=excluded.body',
          )
          .run(index.id, entry.id, entry.body);
        this.db
          .prepare('DELETE FROM links WHERE index_id=? AND entry_id=?')
          .run(index.id, entry.id);
        for (const ref of new Set(entry.refs))
          this.db.prepare('INSERT INTO links VALUES(?,?,?)').run(index.id, entry.id, ref);
      }
      for (const id of remove)
        this.db.prepare('DELETE FROM entries WHERE index_id=? AND id=?').run(index.id, id);
      for (const ref of JSON.parse(String(batch.refs))) {
        this.fragment(ref, visible);
        this.db.prepare('INSERT OR IGNORE INTO coverage VALUES(?,?)').run(index.id, ref);
      }
      // Kept only for legacy audit compatibility; public coverage is a query, not a scalar.
      index.covered = Number(
        this.db.prepare('SELECT COUNT(*) n FROM coverage WHERE index_id=?').get(index.id)!.n,
      );
      index.revision++;
      this.save(index);
      const receipt = { signature, index };
      this.db
        .prepare('UPDATE batches SET receipt=? WHERE id=?')
        .run(JSON.stringify(receipt), batchId);
      this.db
        .prepare('INSERT INTO commits(index_id,at,body) VALUES(?,?,?)')
        .run(
          index.id,
          Date.now(),
          JSON.stringify({ batchId, changes, remove, through: index.covered }),
        );
      return receipt;
    });
  }
  original(ref: string, visible: string[]) {
    const item = this.fragment(ref, visible);
    const neighbors = this.db
      .prepare(
        'SELECT f.ref,d.message,d.position,f.part FROM fragments f JOIN documents d ON d.id=f.document WHERE d.session=? AND d.position BETWEEN ? AND ? ORDER BY d.position,d.observed,f.part LIMIT 50',
      )
      .all(item.session!, Number(item.position) - 1, Number(item.position) + 1);
    const backlinks = this.db
      .prepare(
        'SELECT l.index_id,l.entry_id,e.body FROM links l JOIN entries e ON e.index_id=l.index_id AND e.id=l.entry_id WHERE l.ref=?',
      )
      .all(ref)
      .filter((row) => {
        const refs = this.db
          .prepare('SELECT ref FROM links WHERE index_id=? AND entry_id=?')
          .all(row.index_id!, row.entry_id!);
        try {
          refs.forEach((r) => this.fragment(String(r.ref), visible));
          return true;
        } catch {
          return false;
        }
      });
    const latest = this.db
      .prepare('SELECT id FROM documents WHERE session=? AND message=? ORDER BY rowid DESC LIMIT 1')
      .get(item.session!, item.message!)!;
    const latestRevisionRefs = this.db
      .prepare('SELECT ref FROM fragments WHERE document=? ORDER BY part')
      .all(latest.id!)
      .map((r) => r.ref);
    return {
      item,
      neighbors,
      backlinks,
      isLatestRevision: latest.id === item.document,
      latestRevisionRefs,
      notice:
        'This is an immutable source fragment. Other revisions and later messages may supersede it. Search Recall for follow-ups too.',
    };
  }
}
