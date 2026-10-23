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
import type { StoredMessage } from '@maka/core/session';
import { assistantBatchOutputTurnId, assistantOutputTurnId } from './turn-ids.js';

export type InboxType = 'user_message' | 'discovery' | 'task_update' | 'system_event';
export interface InboxInput {
  id: string;
  type: InboxType;
  source: string;
  content: unknown;
  taskId?: string;
}

/** Durable incoming messages; delivery cursors are not task completion state. */
export class BotStore {
  readonly db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'bot.sqlite');
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS inbox(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
        type TEXT NOT NULL, source TEXT NOT NULL, at INTEGER NOT NULL, task TEXT,
        content TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox_batches(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);`);
  }
  transaction<T>(fn: () => T): T {
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
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO metadata VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  hasUserMessage(id: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM inbox WHERE id=? AND type='user_message'").get(id);
  }
  head(): number {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) n FROM inbox').get()!.n);
  }
  post(input: InboxInput, visible?: StoredMessage) {
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM inbox WHERE id=?').get(input.id);
      const content = JSON.stringify(input.content);
      if (existing) {
        if (
          existing.content !== content ||
          existing.type !== input.type ||
          existing.source !== input.source ||
          existing.task !== (input.taskId ?? null)
        )
          throw Error('Inbox message identity already has different content');
        return Number(existing.seq);
      }
      const result = this.db
        .prepare('INSERT INTO inbox(id,type,source,at,task,content) VALUES(?,?,?,?,?,?)')
        .run(input.id, input.type, input.source, Date.now(), input.taskId ?? null, content);
      if (visible) this.queueVisible(visible);
      // A fresh event retries a failed worker, without a timed restart storm.
      this.set('error', null);
      return Number(result.lastInsertRowid);
    });
  }
  list(input: { after?: number; limit?: number; type?: InboxType }) {
    const where = ['seq > ?'];
    const args: (string | number)[] = [input.after ?? 0];
    if (input.type) {
      where.push('type=?');
      args.push(input.type);
    }
    const limit = Math.min(100, Math.max(1, input.limit ?? 30));
    const rows = this.db
      .prepare(`SELECT * FROM inbox WHERE ${where.join(' AND ')} ORDER BY seq LIMIT ?`)
      .all(...args, limit + 1);
    return {
      items: rows.slice(0, limit).map((row) => ({
        seq: row.seq,
        id: row.id,
        type: row.type,
        source: row.source,
        at: row.at,
        taskId: row.task,
        preview: String(row.content).slice(0, 500),
      })),
      nextAfter: rows.length > limit ? Number(rows[limit - 1].seq) : null,
      revision: this.head(),
    };
  }
  read(id: string, offset = 0, limit = 24000) {
    const row = this.db.prepare('SELECT * FROM inbox WHERE id=?').get(id);
    if (!row) throw Error('Unknown inbox message');
    const body = String(row.content);
    const end = Math.min(body.length, offset + limit);
    return {
      id,
      type: row.type,
      source: row.source,
      taskId: row.task,
      at: row.at,
      content: body.slice(offset, end),
      nextOffset: end < body.length ? end : null,
      totalCharacters: body.length,
    };
  }
  /** Bounded delivery, returning bodies directly rather than requiring List + Read. */
  batch(after: number, limit = 50, maxCharacters = 24000) {
    const rows = this.db
      .prepare('SELECT * FROM inbox WHERE seq > ? ORDER BY seq LIMIT ?')
      .all(after, limit);
    const items = [];
    let characters = 0;
    let through = after;
    for (const row of rows) {
      const body = String(row.content);
      if (items.length && characters + body.length > maxCharacters) break;
      const content = body.slice(0, maxCharacters);
      items.push({
        seq: Number(row.seq),
        id: String(row.id),
        type: row.type,
        source: row.source,
        at: row.at,
        taskId: row.task,
        content,
        nextOffset: content.length < body.length ? content.length : null,
        totalCharacters: body.length,
      });
      characters += content.length;
      through = Number(row.seq);
    }
    return { items, through, hasMore: this.head() > through };
  }
  queueVisible(message: StoredMessage) {
    const old = this.db.prepare('SELECT payload FROM outbox WHERE id=?').get(message.id);
    if (old) {
      const previous = JSON.parse(String(old.payload));
      if (
        previous.text !== ('text' in message ? message.text : undefined) ||
        previous.summary !== (message.type === 'assistant' ? message.summary : undefined)
      )
        throw Error('Message ID has different text');
      return previous as StoredMessage;
    }
    this.db
      .prepare('INSERT INTO outbox(id,payload) VALUES(?,?)')
      .run(message.id, JSON.stringify(message));
    return message;
  }
  /** Register the whole batch before delivery. Retries cannot extend or reorder a committed batch. */
  queueVisibleBatch(
    batchId: string,
    texts: readonly { summary?: string; text: string }[],
  ): string[] {
    return this.transaction(() => {
      const serialize = (items: typeof texts) =>
        JSON.stringify(
          items.map((entry) => ({
            text: entry.text,
            ...(entry.summary !== undefined ? { summary: entry.summary } : {}),
          })),
        );
      const payload = serialize(texts);
      const old = this.db.prepare('SELECT payload FROM outbox_batches WHERE id=?').get(batchId);
      if (old && serialize(JSON.parse(String(old.payload))) !== payload)
        throw Error('Message ID has different batch content');
      // Preserve single-message identities from before batch delivery was introduced.
      const legacyId = `bot-message:${batchId}`;
      if (
        !old &&
        texts.length !== 1 &&
        this.db.prepare('SELECT 1 FROM outbox WHERE id=?').get(legacyId)
      )
        throw Error('Message ID already belongs to a single message');
      const timestamp = Date.now();
      const ids = texts.map((entry, index) => {
        const text = entry.text;
        const summary = entry.summary;
        const suffix = texts.length === 1 ? batchId : JSON.stringify([batchId, index]);
        const id = texts.length === 1 ? legacyId : `bot-batch-message:${suffix}`;
        this.queueVisible({
          type: 'assistant',
          id,
          turnId:
            texts.length === 1
              ? assistantOutputTurnId(batchId)
              : assistantBatchOutputTurnId(batchId, index),
          ts: timestamp,
          text,
          ...(summary !== undefined ? { summary } : {}),
          modelId: 'assistant-bot',
        });
        return id;
      });
      if (!old)
        this.db.prepare('INSERT INTO outbox_batches(id,payload) VALUES(?,?)').run(batchId, payload);
      return ids;
    });
  }
  pendingVisible() {
    return this.db
      .prepare('SELECT payload FROM outbox WHERE delivered=0 ORDER BY rowid')
      .all()
      .map((row) => JSON.parse(String(row.payload)) as StoredMessage);
  }
  delivered(id: string) {
    this.db.prepare('UPDATE outbox SET delivered=1 WHERE id=?').run(id);
  }
  close() {
    this.db.close();
  }
}
