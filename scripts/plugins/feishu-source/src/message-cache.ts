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
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { messageObject } from './adapter.js';
export const hash = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');

/** Local account cache. Incomplete jobs retain originals without publishing them. */
export class MessageCache {
  readonly db: DatabaseSync;
  readonly scope: any;
  private readonly cursorScope: any;
  private readonly signingKey: Buffer;
  constructor(
    directory: string,
    config: any,
    readonly key: string,
  ) {
    this.signingKey = Buffer.from(key, 'base64url');
    if (this.signingKey.length !== 32) throw Error('cursor-signing-key must decode to 32 bytes');
    const account = hash([config.instanceId, config.accountId, config.appId]);
    const path = join(directory, account, 'messages.sqlite');
    mkdirSync(join(directory, account), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.cursorScope = {
      accountId: config.accountId,
      appId: config.appId,
      instanceId: config.instanceId,
      mode: 'local-originals',
      startTime: config.startTime ?? 0,
      endTime: config.endTime ?? null,
    };
    this.scope = { ...this.cursorScope, containers: config.containers ?? [] };
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS sync_jobs(id TEXT PRIMARY KEY,request TEXT NOT NULL,status TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sync_chats(job TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(job,id));
      CREATE TABLE IF NOT EXISTS originals(id TEXT NOT NULL,revision TEXT NOT NULL,object TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(id,revision));
      CREATE TABLE IF NOT EXISTS sync_members(job TEXT NOT NULL,id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(job,id));
      CREATE TABLE IF NOT EXISTS sync_tokens(job TEXT NOT NULL,kind TEXT NOT NULL,token TEXT NOT NULL,PRIMARY KEY(job,kind,token));
      CREATE TABLE IF NOT EXISTS publications(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL,revision TEXT NOT NULL,created_at INTEGER NOT NULL,kind TEXT NOT NULL,object TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS publication_object ON publications(id,seq);
      CREATE TABLE IF NOT EXISTS heads(id TEXT PRIMARY KEY,seq INTEGER NOT NULL);`);
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
  private decodeJob(row: any) {
    return {
      id: row.id,
      ...JSON.parse(String(row.request)),
      ...JSON.parse(String(row.payload)),
      status: row.status,
    };
  }
  job(id: string) {
    const row = this.db.prepare('SELECT * FROM sync_jobs WHERE id=?').get(id);
    if (!row) throw Error('Unknown sync job');
    return this.decodeJob(row);
  }
  latest() {
    const row = this.db.prepare('SELECT * FROM sync_jobs ORDER BY rowid DESC LIMIT 1').get();
    return row ? this.decodeJob(row) : undefined;
  }
  save(job: any) {
    job.updatedAt = Date.now();
    const request = JSON.stringify({
      startTime: job.startTime,
      endTime: job.endTime,
      containers: job.containers,
    });
    const payload = JSON.stringify({
      phase: job.phase,
      chatsPage: job.chatsPage ?? null,
      searchPage: job.searchPage ?? null,
      pages: job.pages,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      finishedAt: job.finishedAt ?? null,
      error: job.error ?? null,
    });
    this.db
      .prepare(
        'INSERT INTO sync_jobs(id,request,status,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,payload=excluded.payload',
      )
      .run(job.id, request, job.status, payload);
  }
  begin(startTime: number, endTime: number, refresh = false) {
    const request = JSON.stringify({ startTime, endTime, containers: this.scope.containers });
    const pending = this.db
      .prepare(
        "SELECT * FROM sync_jobs WHERE request=? AND status='incomplete' ORDER BY rowid DESC LIMIT 1",
      )
      .get(request);
    if (pending) return this.decodeJob(pending);
    const done =
      !refresh &&
      this.db
        .prepare(
          "SELECT * FROM sync_jobs WHERE request=? AND status='complete' ORDER BY rowid DESC LIMIT 1",
        )
        .get(request);
    if (done) return this.decodeJob(done);
    const job = {
      id: randomUUID(),
      startTime,
      endTime,
      containers: this.scope.containers,
      status: 'incomplete',
      phase: 'discover',
      chatsPage: null,
      searchPage: null,
      pages: 0,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
    };
    this.save(job);
    return job;
  }
  has(job: string, id: string) {
    return !!this.db.prepare('SELECT 1 FROM sync_members WHERE job=? AND id=?').get(job, id);
  }
  nextChat(job: string) {
    const row = this.db
      .prepare(
        "SELECT * FROM sync_chats WHERE job=? AND json_extract(payload,'$.done')=0 ORDER BY rowid LIMIT 1",
      )
      .get(job);
    return row ? { id: String(row.id), ...JSON.parse(String(row.payload)) } : undefined;
  }
  page(
    job: any,
    messages: any[],
    options: {
      chats?: string[];
      chat?: { id: string; page: string | null; done: boolean };
      kind?: string;
      next?: string | null;
      count?: boolean;
    } = {},
  ) {
    this.transaction(() => {
      if (options.next) {
        if (
          this.db
            .prepare('SELECT 1 FROM sync_tokens WHERE job=? AND kind=? AND token=?')
            .get(job.id, options.kind!, options.next)
        )
          throw Error('Repeated provider pagination cursor');
        this.db
          .prepare('INSERT INTO sync_tokens(job,kind,token) VALUES(?,?,?)')
          .run(job.id, options.kind!, options.next);
      }
      for (const m of messages) {
        const o = messageObject(m);
        this.db
          .prepare('INSERT OR IGNORE INTO originals(id,revision,object,body) VALUES(?,?,?,?)')
          .run(o.id, o.revision, JSON.stringify(o), JSON.stringify(m));
        this.db
          .prepare(
            'INSERT INTO sync_members(job,id,revision) VALUES(?,?,?) ON CONFLICT(job,id) DO UPDATE SET revision=excluded.revision',
          )
          .run(job.id, o.id, o.revision);
      }
      for (const id of options.chats ?? [])
        this.db
          .prepare('INSERT OR IGNORE INTO sync_chats(job,id,payload) VALUES(?,?,?)')
          .run(job.id, id, JSON.stringify({ page: null, done: false }));
      if (options.chat) {
        const { id, page, done } = options.chat;
        this.db
          .prepare('UPDATE sync_chats SET payload=? WHERE job=? AND id=?')
          .run(JSON.stringify({ page, done }), job.id, id);
      }
      if (options.count !== false) job.pages++;
      job.error = null;
      this.save(job);
    });
  }
  publish(job: any) {
    this.transaction(() => {
      for (const row of this.db
        .prepare(
          'SELECT o.* FROM sync_members m JOIN originals o ON o.id=m.id AND o.revision=m.revision WHERE m.job=? ORDER BY o.id',
        )
        .all(job.id)) {
        const head = this.db
          .prepare('SELECT p.revision FROM heads h JOIN publications p ON p.seq=h.seq WHERE h.id=?')
          .get(row.id);
        if (head?.revision === row.revision) continue;
        const m = JSON.parse(String(row.body)),
          o = JSON.parse(String(row.object));
        const seq = this.db
          .prepare('INSERT INTO publications(id,revision,created_at,kind,object) VALUES(?,?,?,?,?)')
          .run(
            String(row.id),
            String(row.revision),
            Number(m.create_time),
            o.kind,
            String(row.object),
          ).lastInsertRowid;
        this.db
          .prepare(
            'INSERT INTO heads(id,seq) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET seq=excluded.seq',
          )
          .run(String(row.id), seq);
      }
      job.status = 'complete';
      job.phase = 'complete';
      job.finishedAt = Date.now();
      job.error = null;
      this.save(job);
    });
  }
  boundary() {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) n FROM publications').get()!.n);
  }
  rows(highWater = this.boundary()) {
    return this.db
      .prepare(`SELECT o.* FROM originals o JOIN publications p ON o.id=p.id AND o.revision=p.revision
      WHERE p.seq=(SELECT MAX(p2.seq) FROM publications p2 WHERE p2.id=p.id AND p2.seq<=?) ORDER BY p.created_at,p.id`)
      .all(highWater);
  }
  publishedVersion(id: string, revision: string) {
    return this.db
      .prepare(
        'SELECT o.* FROM originals o WHERE id=? AND revision=? AND EXISTS(SELECT 1 FROM publications p WHERE p.id=o.id AND p.revision=o.revision)',
      )
      .get(id, revision);
  }
  inScope(m: any, range: any = this.scope) {
    const time = Number(m.create_time);
    return (
      Number.isFinite(time) &&
      time >= range.startTime * 1000 &&
      time < (range.endTime ?? Infinity) * 1000 &&
      (!range.containers.length ||
        range.containers.some((c: any) =>
          c.type === 'chat' ? c.id === m.chat_id : c.id === m.thread_id,
        ))
    );
  }
  encode(state: any) {
    const text = Buffer.from(JSON.stringify(state)).toString('base64url');
    return text + '.' + createHmac('sha256', this.signingKey).update(text).digest('hex');
  }
  decode(cursor: string) {
    const [text, mac, extra] = cursor.split('.');
    if (extra || !mac || mac !== createHmac('sha256', this.signingKey).update(text).digest('hex'))
      throw Error('Invalid source cursor');
    return JSON.parse(Buffer.from(text, 'base64url').toString());
  }
  source(id: string, verify: (caller: any) => Promise<void>) {
    const query = async (q: any, caller: any) => {
      await verify(caller);
      if (!this.db.prepare("SELECT 1 FROM sync_jobs WHERE status='complete' LIMIT 1").get())
        throw Error('Messages have not been synchronized; call FeishuSync first');
      if (
        Object.keys(q).some(
          (k) =>
            !['cursor', 'text', 'types', 'chatId', 'startTime', 'endTime', 'limit'].includes(k),
        )
      )
        throw Error('Unsupported message query');
      const { cursor, ...shape } = q,
        limit = q.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw Error('Invalid limit');
      if (q.text !== undefined && typeof q.text !== 'string') throw Error('Invalid text');
      if (
        q.types !== undefined &&
        (!Array.isArray(q.types) || q.types.some((t: any) => typeof t !== 'string'))
      )
        throw Error('Invalid types');
      if (q.chatId !== undefined && typeof q.chatId !== 'string') throw Error('Invalid chatId');
      for (const k of ['startTime', 'endTime'])
        if (q[k] !== undefined && (!Number.isSafeInteger(q[k]) || q[k] < 0))
          throw Error('Invalid time');
      const start = Math.max(this.scope.startTime, q.startTime ?? 0),
        end = Math.min(this.scope.endTime ?? Infinity, q.endTime ?? Infinity);
      if (start >= end) throw Error('Invalid time range');
      const fingerprint = hash({ scope: this.cursorScope, shape });
      const state = cursor
        ? this.decode(cursor)
        : { hash: fingerprint, highWater: this.boundary(), offset: 0 };
      if (state.hash !== fingerprint) throw Error('Source cursor scope or query changed');
      if (
        !Number.isSafeInteger(state.highWater) ||
        state.highWater < 0 ||
        !Number.isSafeInteger(state.offset) ||
        state.offset < 0
      )
        throw Error('Invalid source cursor');
      const conditions = ['p.created_at>=?'],
        values: any[] = [state.highWater, start * 1000];
      if (Number.isFinite(end)) {
        conditions.push('p.created_at<?');
        values.push(end * 1000);
      }
      if (this.scope.containers.length) {
        conditions.push(
          '(' +
            this.scope.containers
              .map(
                (c: any) =>
                  `json_extract(o.body,'$.${c.type === 'chat' ? 'chat_id' : 'thread_id'}')=?`,
              )
              .join(' OR ') +
            ')',
        );
        values.push(...this.scope.containers.map((c: any) => c.id));
      }
      if (q.chatId !== undefined) {
        conditions.push("json_extract(o.body,'$.chat_id')=?");
        values.push(q.chatId);
      }
      if (q.text) {
        conditions.push('instr(lower(o.body),lower(?))>0');
        values.push(q.text);
      }
      if (q.types?.length) {
        conditions.push(
          `json_extract(o.body,'$.msg_type') IN (${q.types.map(() => '?').join(',')})`,
        );
        values.push(...q.types);
      }
      if (q.types && !q.types.length) conditions.push('0');
      const rows = this.db
        .prepare(`WITH selected AS (SELECT id,MAX(seq) seq FROM publications WHERE seq<=? GROUP BY id)
        SELECT p.object FROM selected s JOIN publications p ON p.seq=s.seq JOIN originals o ON o.id=p.id AND o.revision=p.revision
        WHERE ${conditions.join(' AND ')} ORDER BY p.created_at,p.id LIMIT ? OFFSET ?`)
        .all(...values, limit + 1, state.offset);
      return {
        items: rows.slice(0, limit).map((r) => JSON.parse(String(r.object))),
        ...(rows.length > limit
          ? { next: this.encode({ ...state, offset: state.offset + limit }) }
          : {}),
      };
    };
    return {
      id,
      description:
        'Feishu messages from completed local sync jobs; call FeishuSync to download new messages.',
      scope: this.scope,
      activityToken: async (caller: any) => {
        await verify(caller);
        const row = this.db.prepare('SELECT MAX(seq) AS seq FROM publications').get();
        return row?.seq == null ? null : hash({ scope: this.scope, seq: row.seq });
      },
      queryHelp:
        '{text?,types?,chatId?,startTime?,endTime?,limit?:1..500,cursor?}; Unix seconds. Default 50, enumeration 500. Local published originals only; preserve query fields when paging. Completed bounded scans do not guarantee all Feishu history. Index observation reads this local cache, not the live server; use FeishuSyncStatus for last successful source sync and failures. Older edits/deletions require refreshing their time range.',
      query,
      enumerate: (cursor: string | undefined, caller: any) =>
        query({ limit: 500, ...(cursor ? { cursor } : {}) }, caller),
      authorize: async (objects: any[], caller: any) => {
        await verify(caller);
        return objects
          .filter((o) => {
            const row = this.publishedVersion(o.id, o.revision);
            return row && this.inScope(JSON.parse(String(row.body)));
          })
          .map((o) => o.id);
      },
      read: async (o: any, caller: any) => {
        await verify(caller);
        const row = this.publishedVersion(o.id, o.revision);
        if (!row || !this.inScope(JSON.parse(String(row.body))))
          return { status: 'unavailable' as const, object: o };
        const m = JSON.parse(String(row.body)),
          object = JSON.parse(String(row.object));
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
