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
      this.db.exec(`CREATE TABLE IF NOT EXISTS memory_references(ref TEXT PRIMARY KEY,source TEXT NOT NULL,object_id TEXT NOT NULL,revision TEXT NOT NULL,record_key TEXT NOT NULL,payload TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS memory_reference_object ON memory_references(source,object_id);
        CREATE TABLE IF NOT EXISTS memory_evidence(ref TEXT PRIMARY KEY REFERENCES memory_references(ref),body TEXT NOT NULL,observed_at INTEGER NOT NULL);`);
      if (!this.db.prepare("SELECT 1 FROM memory_meta WHERE key='references-v1'").get()) {
        for (const row of this.db
          .prepare(
            'SELECT f.ref,f.part,d.id,d.session,d.message,d.hash FROM fragments f JOIN documents d ON d.id=f.document',
          )
          .all()) {
          const source = sourceOf(String(row.session));
          const recordId =
            source === 'maka' ? String(row.session) : JSON.parse(String(row.session))[1];
          this.rememberReference(
            source,
            {
              id: JSON.stringify([recordId, row.message]),
              locator: { recordId, messageId: row.message },
              revision: String(row.hash),
              kind: 'message',
            },
            recordId,
            { ref: String(row.ref), document: String(row.id), part: Number(row.part) },
          );
        }
        // Transactional table replacement preserves every existing edge and its public ref.
        this.db.exec(`DROP INDEX backlinks;
          ALTER TABLE links RENAME TO memory_legacy_links;
          CREATE TABLE links(index_id TEXT NOT NULL,entry_id TEXT NOT NULL,ref TEXT NOT NULL REFERENCES memory_references(ref),PRIMARY KEY(index_id,entry_id,ref),FOREIGN KEY(index_id,entry_id) REFERENCES entries(index_id,id) ON DELETE CASCADE);
          INSERT INTO links SELECT index_id,entry_id,ref FROM memory_legacy_links;
          DROP TABLE memory_legacy_links;
          CREATE INDEX backlinks ON links(ref);
          INSERT INTO memory_meta VALUES('references-v1','1');`);
      }
    });
  }
  /** References and edges are independent of where original content lives. */
  reference(ref: string): any | undefined {
    const row = this.db.prepare('SELECT payload FROM memory_references WHERE ref=?').get(ref);
    return row ? JSON.parse(String(row.payload)) : undefined;
  }
  references(source?: string): any[] {
    return this.db
      .prepare('SELECT payload FROM memory_references WHERE (? IS NULL OR source=?)')
      .all(source ?? null, source ?? null)
      .map((r) => JSON.parse(String(r.payload)));
  }
  rememberReference(
    source: string,
    object: any,
    recordId = object.id,
    local?: { ref: string; document: string; part: number },
  ) {
    const ref = local?.ref ?? `r_${hash(JSON.stringify([source, object.id, object.revision]))}`;
    const payload = {
      ref,
      source,
      object,
      recordId,
      recordKey: sourceKey(source, recordId),
      ...(local ? { local } : {}),
    };
    const existing = this.reference(ref);
    if (existing) {
      // Provenance can be supplied after ingestion; enrich metadata without changing cited bodies/IDs.
      if (
        object.evidenceKind &&
        existing.object.evidenceKind !== 'test' &&
        (object.evidenceKind === 'test' || !existing.object.evidenceKind)
      ) {
        existing.object.evidenceKind = object.evidenceKind;
        this.db
          .prepare('UPDATE memory_references SET payload=? WHERE ref=?')
          .run(JSON.stringify(existing), ref);
      }
      return existing;
    }
    this.db
      .prepare(
        'INSERT INTO memory_references(ref,source,object_id,revision,record_key,payload) VALUES(?,?,?,?,?,?)',
      )
      .run(ref, source, object.id, object.revision, payload.recordKey, JSON.stringify(payload));
    return payload;
  }
  cacheEvidence(ref: string, content: unknown) {
    if (!this.reference(ref)) throw Error('Unknown reference');
    const body = JSON.stringify(content);
    const existing = this.db.prepare('SELECT body FROM memory_evidence WHERE ref=?').get(ref);
    if (existing && existing.body !== body)
      throw Error('Source reused a revision for different content');
    this.db
      .prepare('INSERT OR IGNORE INTO memory_evidence(ref,body,observed_at) VALUES(?,?,?)')
      .run(ref, body, Date.now());
  }
  evidence(ref: string): { content: unknown; observedAt: number } | undefined {
    const row = this.db
      .prepare('SELECT body,observed_at FROM memory_evidence WHERE ref=?')
      .get(ref);
    return row
      ? { content: JSON.parse(String(row.body)), observedAt: Number(row.observed_at) }
      : undefined;
  }
  linkedEntries(ref: string, visible: string[], objectWide = false) {
    const target = this.reference(ref);
    if (!target) throw Error('Unknown reference');
    const refs = objectWide
      ? this.db
          .prepare('SELECT ref FROM memory_references WHERE source=? AND object_id=?')
          .all(target.source, target.object.id)
          .map((r) => String(r.ref))
      : [ref];
    const seen = new Set<string>();
    return refs
      .flatMap((r) =>
        this.db
          .prepare(
            'SELECT l.index_id,l.entry_id,l.ref,e.body FROM links l JOIN entries e ON e.index_id=l.index_id AND e.id=l.entry_id WHERE l.ref=?',
          )
          .all(r),
      )
      .filter((row) => {
        const key = JSON.stringify([row.index_id, row.entry_id]);
        if (seen.has(key)) return false;
        try {
          this.db
            .prepare('SELECT ref FROM links WHERE index_id=? AND entry_id=?')
            .all(row.index_id!, row.entry_id!)
            .forEach((r) => this.fragment(String(r.ref), visible));
          seen.add(key);
          return true;
        } catch {
          return false;
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
          const source = sourceOf(session),
            recordId = source === 'maka' ? session : JSON.parse(session)[1];
          this.rememberReference(
            source,
            {
              id: JSON.stringify([recordId, message.id]),
              locator: { recordId, messageId: message.id },
              revision: digest,
              kind: 'message',
            },
            recordId,
            { ref: `${id}:${part}`, document: id, part },
          );
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
  fragment(ref: string, visible: string[]): Record<string, any> {
    const row = this.db
      .prepare(
        'SELECT f.*,d.session,d.message,d.position,d.observed,LENGTH(d.body) AS totalChars FROM fragments f JOIN documents d ON d.id=f.document WHERE ref=?',
      )
      .get(ref);
    if (row && visible.includes(String(row.session))) return row;
    const reference = this.reference(ref);
    if (!reference || !visible.includes(reference.recordKey))
      throw Error('Original is missing or outside current history visibility');
    return { ref, session: reference.recordKey, message: reference.object.id, external: true };
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
