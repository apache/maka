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
import { NetworkStore, sourceOf } from '../../../../src/assistant/memory-network/store.js';

type Entry = { id: string; body: string; refs: string[] };

// Retired batch protocol, retained only to construct old-format databases and
// exercise their invariants. Production workers use CorpusStore checkpoints.
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class LegacyNetworkStore extends NetworkStore {
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
}
