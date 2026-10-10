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
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { messageObject } from './adapter.js';
export const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

/** Staging and immutable published versions share storage, never visibility. */
export class MessageCache {
  readonly db: DatabaseSync;
  readonly key: string;
  constructor(
    directory: string,
    readonly scope: any,
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, 'messages.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_jobs(id TEXT PRIMARY KEY,scope TEXT NOT NULL,range_key TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS job_range ON sync_jobs(scope,range_key);
      CREATE TABLE IF NOT EXISTS versions(scope TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,object TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(scope,id,revision));
      CREATE TABLE IF NOT EXISTS staged(job TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(job,id));
      CREATE TABLE IF NOT EXISTS publications(seq INTEGER PRIMARY KEY AUTOINCREMENT,scope TEXT NOT NULL,job TEXT NOT NULL UNIQUE);
      CREATE TABLE IF NOT EXISTS published(seq INTEGER NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(seq,id));
      CREATE INDEX IF NOT EXISTS published_identity ON published(id,seq);`);
    this.db
      .prepare('INSERT OR IGNORE INTO meta VALUES(?,?)')
      .run('cursor-key', randomBytes(32).toString('hex'));
    this.key = String(this.db.prepare('SELECT v FROM meta WHERE k=?').get('cursor-key')!.v);
  }
  get scopeKey() {
    return hash(this.scope);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const x = fn();
      this.db.exec('COMMIT');
      return x;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  job(id: string) {
    const r = this.db
      .prepare('SELECT payload FROM sync_jobs WHERE id=? AND scope=?')
      .get(id, this.scopeKey);
    if (!r) throw Error('Unknown sync job');
    return JSON.parse(String(r.payload));
  }
  jobs() {
    return this.db
      .prepare('SELECT payload FROM sync_jobs WHERE scope=? ORDER BY rowid DESC')
      .all(this.scopeKey)
      .map((r) => JSON.parse(String(r.payload)));
  }
  save(job: any) {
    job.updatedAt = Date.now();
    this.db
      .prepare(
        'INSERT INTO sync_jobs VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(job.id, this.scopeKey, hash([job.startTime, job.endTime]), JSON.stringify(job));
  }
  begin(startTime: number, endTime: number, refresh = false) {
    const old = this.jobs().find((j) => j.startTime === startTime && j.endTime === endTime);
    // A refresh already in progress is also resumed, not replaced with another partial generation.
    if (old && (old.status !== 'complete' || !refresh)) return old;
    const j = {
      id: randomUUID(),
      startTime,
      endTime,
      status: 'pending',
      phase: 'chats',
      chats: [],
      chatIndex: 0,
      pages: 0,
      seen: [],
      createdAt: Date.now(),
      error: null,
    };
    this.save(j);
    return j;
  }
  has(job: string, id: string) {
    return !!this.db.prepare('SELECT 1 FROM staged WHERE job=? AND id=?').get(job, id);
  }
  page(job: any, messages: any[]) {
    this.transaction(() => {
      for (const m of messages) {
        const o = messageObject(m);
        this.db
          .prepare('INSERT OR IGNORE INTO versions VALUES(?,?,?,?,?)')
          .run(this.scopeKey, o.id, o.revision, JSON.stringify(o), JSON.stringify(m));
        this.db
          .prepare(
            'INSERT INTO staged VALUES(?,?,?) ON CONFLICT(job,id) DO UPDATE SET revision=excluded.revision',
          )
          .run(job.id, o.id, o.revision);
      }
      job.pages++;
      job.status = 'running';
      job.error = null;
      this.save(job);
    });
  }
  publish(job: any) {
    this.transaction(() => {
      const seq = Number(
        this.db
          .prepare('INSERT INTO publications(scope,job) VALUES(?,?)')
          .run(this.scopeKey, job.id).lastInsertRowid,
      );
      this.db
        .prepare('INSERT INTO published SELECT ?,id,revision FROM staged WHERE job=?')
        .run(seq, job.id);
      job.status = 'complete';
      job.phase = 'complete';
      job.publication = seq;
      job.completedAt = Date.now();
      job.error = null;
      this.save(job);
    });
  }
  boundary() {
    return Number(
      this.db
        .prepare('SELECT COALESCE(MAX(seq),0) n FROM publications WHERE scope=?')
        .get(this.scopeKey)!.n,
    );
  }
  rows(boundary = this.boundary()) {
    return this.db
      .prepare(`SELECT v.* FROM versions v JOIN published p ON v.id=p.id AND v.revision=p.revision
      JOIN publications s ON s.seq=p.seq AND s.scope=v.scope
      WHERE v.scope=? AND p.seq=(SELECT MAX(p2.seq) FROM published p2 JOIN publications s2 ON p2.seq=s2.seq WHERE s2.scope=v.scope AND p2.id=v.id AND p2.seq<=?) ORDER BY v.id`)
      .all(this.scopeKey, boundary);
  }
  publishedVersion(id: string, revision: string) {
    return this.db
      .prepare(`SELECT v.* FROM versions v WHERE scope=? AND id=? AND revision=? AND EXISTS(
      SELECT 1 FROM published p JOIN publications s ON s.seq=p.seq WHERE s.scope=v.scope AND p.id=v.id AND p.revision=v.revision)`)
      .get(this.scopeKey, id, revision);
  }
  encode(state: any) {
    const text = Buffer.from(JSON.stringify(state)).toString('base64url');
    return text + '.' + createHmac('sha256', this.key).update(text).digest('hex');
  }
  decode(cursor: string) {
    const [text, mac, extra] = cursor.split('.');
    if (extra || !mac || mac !== createHmac('sha256', this.key).update(text).digest('hex'))
      throw Error('Invalid source cursor');
    return JSON.parse(Buffer.from(text, 'base64url').toString());
  }
  source(id: string, verify: (caller: any) => Promise<void>) {
    const query = async (q: any, caller: any) => {
      await verify(caller);
      if (
        Object.keys(q).some(
          (k) =>
            !['cursor', 'text', 'types', 'chatId', 'startTime', 'endTime', 'limit'].includes(k),
        )
      )
        throw Error('Unsupported message query');
      const { cursor, ...shape } = q;
      const limit = q.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw Error('Invalid limit');
      if (q.text !== undefined && typeof q.text !== 'string') throw Error('Invalid text');
      if (
        q.types !== undefined &&
        (!Array.isArray(q.types) || q.types.some((t: any) => typeof t !== 'string'))
      )
        throw Error('Invalid types');
      for (const k of ['startTime', 'endTime'])
        if (q[k] !== undefined && (!Number.isSafeInteger(q[k]) || q[k] < 0))
          throw Error('Invalid time');
      const state = cursor
        ? this.decode(cursor)
        : { scope: this.scopeKey, query: hash(shape), boundary: this.boundary(), offset: 0 };
      if (state.scope !== this.scopeKey || state.query !== hash(shape))
        throw Error('Source cursor scope or query changed');
      const conditions = ['v.scope=?'],
        values: any[] = [this.scopeKey, state.boundary, this.scopeKey];
      if (q.text) {
        conditions.push('instr(lower(v.body),lower(?))>0');
        values.push(q.text);
      }
      if (q.types?.length) {
        conditions.push(
          `json_extract(v.body,'$.msg_type') IN (${q.types.map(() => '?').join(',')})`,
        );
        values.push(...q.types);
      }
      if (q.types && !q.types.length) conditions.push('0');
      if (q.chatId !== undefined) {
        if (typeof q.chatId !== 'string') throw Error('Invalid chatId');
        conditions.push("json_extract(v.body,'$.chat_id')=?");
        values.push(q.chatId);
      }
      for (const [key, op] of [
        ['startTime', '>='],
        ['endTime', '<'],
      ])
        if (q[key] !== undefined) {
          conditions.push(`CAST(json_extract(v.body,'$.create_time') AS INTEGER)${op}?`);
          values.push(q[key] * 1000);
        }
      if (q.startTime !== undefined && q.endTime !== undefined && q.startTime >= q.endTime)
        throw Error('Invalid time range');
      const rows = this.db
        .prepare(`WITH heads AS (
        SELECT p.id,MAX(p.seq) seq FROM published p JOIN publications s ON s.seq=p.seq WHERE s.scope=? AND p.seq<=? GROUP BY p.id
      ) SELECT v.object FROM heads h JOIN published p ON p.id=h.id AND p.seq=h.seq
        JOIN versions v ON v.id=p.id AND v.revision=p.revision WHERE ${conditions.join(' AND ')} ORDER BY v.id LIMIT ? OFFSET ?`)
        .all(...values, limit + 1, state.offset);
      const selected = rows.slice(0, limit),
        offset = state.offset + selected.length;
      return {
        items: selected.map((r) => JSON.parse(String(r.object))),
        ...(rows.length > limit ? { next: this.encode({ ...state, offset }) } : {}),
      };
    };
    return {
      id,
      description:
        'Feishu messages from completed local sync batches; run FeishuSync explicitly to download new messages.',
      scope: this.scope,
      queryHelp:
        '{text?,types?,chatId?,startTime?,endTime?,limit?:1..500,cursor?}; Unix seconds. Local cache only. Preserve query fields when following next. Completed sync means the bounded API scan finished, not exhaustive Feishu history.',
      query,
      enumerate: (cursor: string | undefined, caller: any) =>
        query({ ...(cursor ? { cursor } : {}) }, caller),
      authorize: async (objects: any[], caller: any) => {
        await verify(caller);
        return objects.filter((o) => this.publishedVersion(o.id, o.revision)).map((o) => o.id);
      },
      read: async (o: any, caller: any) => {
        await verify(caller);
        const r = this.publishedVersion(o.id, o.revision);
        if (!r) return { status: 'unavailable' as const, object: o };
        const m = JSON.parse(String(r.body)),
          object = JSON.parse(String(r.object));
        return m.deleted ||
          JSON.stringify(m.body ?? '').includes(
            'The message has exceeded the retention period and has been deleted.',
          )
          ? { status: 'deleted' as const, object }
          : { status: 'ok' as const, object, content: m };
      },
    };
  }
  close() {
    this.db.close();
  }
}
