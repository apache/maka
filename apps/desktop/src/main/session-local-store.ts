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

import { chmodSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  SessionCreateInput,
  TurnMessageSubmitInput,
  TurnMessageSubmitResult,
} from '@maka/runtime-host/protocol';
import type { DesktopSessionSummaryInput } from '../shared/desktop-session-projection.js';
import type { DesktopLocalMessageState } from '../shared/session-local-contract.js';
import type { DesktopTranscriptReplicaSnapshot } from './desktop-transcript-replica.js';

const MAX_OUTBOX_BYTES = 256 * 1024 * 1024;
export const MAX_LOCAL_MESSAGE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_SESSION_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface LocalStagedAttachment {
  readonly name: string;
  readonly mimeType: string;
  readonly base64: string;
}

export interface LocalMessageIntent {
  readonly command: Omit<TurnMessageSubmitInput, 'originHostEpoch'>;
  readonly staged: readonly LocalStagedAttachment[];
  /** Written durably before the first dispatch, and immutable thereafter. */
  readonly originHostEpoch?: string;
  readonly attachmentsPrepared?: true;
}

export interface LocalOutboxRecord {
  readonly partition: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly createdAt: number;
  readonly state: DesktopLocalMessageState;
  readonly intent: Omit<LocalMessageIntent, 'staged'>;
  readonly fingerprint: string;
  readonly result?: TurnMessageSubmitResult;
  readonly error?: string;
}

/** A Client-owned database, never the Host's operational database. */
export class DesktopSessionLocalStore {
  readonly #db: DatabaseSync;
  #revision = 0;
  get revision(): number {
    return this.#revision;
  }
  constructor(
    path: string,
    private readonly now: () => number = Date.now,
  ) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS outbox (
        partition TEXT NOT NULL, session_id TEXT NOT NULL, message_id TEXT NOT NULL,
        created_at INTEGER NOT NULL, state TEXT NOT NULL, payload TEXT NOT NULL,
        PRIMARY KEY (partition, message_id)
      );
      CREATE INDEX IF NOT EXISTS outbox_order ON outbox(partition, created_at);
      CREATE TABLE IF NOT EXISTS outbox_attachments (
        partition TEXT NOT NULL, message_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
        name TEXT NOT NULL, mime_type TEXT NOT NULL, content BLOB NOT NULL,
        PRIMARY KEY (partition, message_id, ordinal),
        FOREIGN KEY (partition, message_id) REFERENCES outbox(partition, message_id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS sessions (
        partition TEXT NOT NULL, session_id TEXT NOT NULL, summary TEXT NOT NULL,
        creation TEXT, updated_at INTEGER NOT NULL,
        PRIMARY KEY (partition, session_id)
      );
      CREATE TABLE IF NOT EXISTS transcripts (
        partition TEXT NOT NULL, session_id TEXT NOT NULL, snapshot TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (partition, session_id)
      );
      CREATE TABLE IF NOT EXISTS authorities (profile_id TEXT PRIMARY KEY, partition TEXT NOT NULL);
    `);
    // A crash may have happened anywhere after persisting dispatch intent.
    // Recovery probes the original epoch instead of assuming the send failed.
    this.#db.exec("UPDATE outbox SET state = 'unknown' WHERE state = 'sending'");
    this.#db.prepare('DELETE FROM transcripts WHERE updated_at < ?').run(now() - CACHE_TTL_MS);
  }

  close(): void {
    this.#db.close();
  }

  bindAuthority(profileId: string, partition: string): void {
    const previous = this.#db
      .prepare('SELECT partition FROM authorities WHERE profile_id = ?')
      .get(profileId);
    if (previous?.partition === partition) return;
    if (previous) this.purge(String(previous.partition));
    this.#db
      .prepare(
        'INSERT INTO authorities VALUES (?, ?) ON CONFLICT(profile_id) DO UPDATE SET partition = excluded.partition',
      )
      .run(profileId, partition);
  }

  enqueue(partition: string, intent: LocalMessageIntent): LocalOutboxRecord {
    const digest = createHash('sha256').update(JSON.stringify(intent.command));
    for (const staged of intent.staged)
      digest.update(JSON.stringify([staged.name, staged.mimeType, staged.base64]));
    const fingerprint = digest.digest('hex');
    const previous = this.get(partition, intent.command.messageId);
    if (previous) {
      // Only an identical caller retry can claim a durable local receipt.
      if (previous.fingerprint !== fingerprint) {
        throw new Error('Message identity is already bound to a different local intent');
      }
      return previous;
    }
    const { staged, ...metadata } = intent;
    const record: LocalOutboxRecord = {
      partition,
      sessionId: intent.command.sessionId,
      messageId: intent.command.messageId,
      createdAt: this.now(),
      state: 'saved',
      intent: metadata,
      fingerprint,
    };
    const payload = JSON.stringify(record);
    const usage = this.#db
      .prepare(
        'SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(payload AS BLOB))), 0) AS bytes FROM outbox',
      )
      .get()!;
    const storedBytes = Number(
      this.#db
        .prepare('SELECT COALESCE(SUM(length(content)), 0) AS bytes FROM outbox_attachments')
        .get()!.bytes,
    );
    const messageBytes =
      Buffer.byteLength(payload) +
      staged.reduce((bytes, item) => bytes + Buffer.byteLength(item.base64, 'base64'), 0);
    if (
      Number(usage.count) >= 256 ||
      messageBytes > MAX_LOCAL_MESSAGE_BYTES ||
      Number(usage.bytes) + storedBytes + messageBytes > MAX_OUTBOX_BYTES
    ) {
      throw new Error(
        'Local message storage is full; keep the draft and resolve pending messages first',
      );
    }
    this.#transaction(() => {
      this.#db
        .prepare('INSERT INTO outbox VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          partition,
          record.sessionId,
          record.messageId,
          record.createdAt,
          record.state,
          payload,
        );
      const insert = this.#db.prepare('INSERT INTO outbox_attachments VALUES (?, ?, ?, ?, ?, ?)');
      staged.forEach((item, ordinal) =>
        insert.run(
          partition,
          record.messageId,
          ordinal,
          item.name,
          item.mimeType,
          Buffer.from(item.base64, 'base64'),
        ),
      );
    });
    this.#revision += 1;
    return record;
  }

  /** Only the delivering worker reads blobs; catalog/UI/retry scans read metadata. */
  stagedAttachments(
    partition: string,
    messageId: string,
  ): { name: string; mimeType: string; content: Uint8Array }[] {
    return this.#db
      .prepare(
        'SELECT name, mime_type, content FROM outbox_attachments WHERE partition = ? AND message_id = ? ORDER BY ordinal',
      )
      .all(partition, messageId)
      .map((row) => ({
        name: String(row.name),
        mimeType: String(row.mime_type),
        content: row.content as Uint8Array,
      }));
  }

  get(partition: string, messageId: string): LocalOutboxRecord | undefined {
    const row = this.#db
      .prepare('SELECT state, payload FROM outbox WHERE partition = ? AND message_id = ?')
      .get(partition, messageId);
    return row
      ? ({ ...JSON.parse(String(row.payload)), state: row.state } as LocalOutboxRecord)
      : undefined;
  }

  list(partition: string, sessionId?: string): LocalOutboxRecord[] {
    const rows =
      sessionId === undefined
        ? this.#db
            .prepare(
              'SELECT state, payload FROM outbox WHERE partition = ? ORDER BY created_at, rowid',
            )
            .all(partition)
        : this.#db
            .prepare(
              'SELECT state, payload FROM outbox WHERE partition = ? AND session_id = ? ORDER BY created_at, rowid',
            )
            .all(partition, sessionId);
    return rows.map(
      (row) => ({ ...JSON.parse(String(row.payload)), state: row.state }) as LocalOutboxRecord,
    );
  }

  update(record: LocalOutboxRecord): void {
    const previous = this.get(record.partition, record.messageId);
    if (!previous) throw new Error('Local intent was removed');
    if (
      previous.intent.originHostEpoch &&
      previous.intent.originHostEpoch !== record.intent.originHostEpoch
    )
      throw new Error('Cannot retarget a dispatched Message epoch');
    this.#transaction(() => {
      this.#db
        .prepare('UPDATE outbox SET state = ?, payload = ? WHERE partition = ? AND message_id = ?')
        .run(record.state, JSON.stringify(record), record.partition, record.messageId);
      // Host references and local bytes change ownership in the same commit.
      if (record.intent.attachmentsPrepared)
        this.#db
          .prepare('DELETE FROM outbox_attachments WHERE partition = ? AND message_id = ?')
          .run(record.partition, record.messageId);
    });
  }

  cancel(partition: string, messageId: string): void {
    const record = this.get(partition, messageId);
    if (!record) return;
    if ((record.intent.originHostEpoch && record.state !== 'failed') || record.state === 'accepted')
      throw new Error(
        'The Host may already own this message; local cancellation cannot stop execution',
      );
    this.#db
      .prepare('DELETE FROM outbox WHERE partition = ? AND message_id = ?')
      .run(partition, messageId);
  }

  saveSession(
    partition: string,
    summary: DesktopSessionSummaryInput,
    creation?: SessionCreateInput,
  ): void {
    this.#db
      .prepare(`INSERT INTO sessions VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(partition, session_id) DO UPDATE SET summary = excluded.summary,
        creation = excluded.creation, updated_at = excluded.updated_at`)
      .run(
        partition,
        summary.id,
        JSON.stringify(summary),
        creation ? JSON.stringify(creation) : null,
        this.now(),
      );
    this.#revision += 1;
  }

  sessions(partition: string): DesktopSessionSummaryInput[] {
    return this.#db
      .prepare('SELECT summary FROM sessions WHERE partition = ? ORDER BY updated_at DESC')
      .all(partition)
      .map((row) => JSON.parse(String(row.summary)) as DesktopSessionSummaryInput);
  }

  creation(partition: string, sessionId: string): SessionCreateInput | undefined {
    const row = this.#db
      .prepare('SELECT creation FROM sessions WHERE partition = ? AND session_id = ?')
      .get(partition, sessionId);
    return row?.creation ? (JSON.parse(String(row.creation)) as SessionCreateInput) : undefined;
  }

  saveCatalog(partition: string, summaries: readonly DesktopSessionSummaryInput[]): void {
    this.#transaction(() => {
      const seen = new Set(summaries.map((summary) => summary.id));
      for (const summary of summaries) this.saveSession(partition, summary);
      for (const previous of this.sessions(partition)) {
        if (!seen.has(previous.id) && !this.creation(partition, previous.id))
          this.removeSession(partition, previous.id);
      }
    });
  }

  retireObservedMessages(partition: string, snapshot: DesktopTranscriptReplicaSnapshot): boolean {
    const pending = new Set(
      this.#db
        .prepare(
          "SELECT message_id FROM outbox WHERE partition = ? AND session_id = ? AND state IN ('sending', 'unknown', 'accepted')",
        )
        .all(partition, snapshot.sessionId)
        .map((row) => String(row.message_id)),
    );
    if (!pending.size) return false;
    const observed = snapshot.durable.filter(
      (entry) => entry.message.type === 'user' && pending.has(entry.message.id),
    );
    if (!observed.length) return false;
    return this.#transaction(() => {
      let changed = false;
      const remove = this.#db.prepare(
        "DELETE FROM outbox WHERE partition = ? AND session_id = ? AND message_id = ? AND state IN ('sending', 'unknown', 'accepted')",
      );
      for (const entry of observed) {
        if (remove.run(partition, snapshot.sessionId, entry.message.id).changes) changed = true;
      }
      return changed;
    });
  }

  /** Host-confirmed cancellation is terminal evidence, even without a transcript row.
   * Delete in one commit; the delivering worker's ownership check fences a late ACK.
   */
  retireRetractedMessages(
    partition: string, hostEpoch: string, sessionId: string, messageIds: readonly string[],
  ): boolean {
    return this.#retireCancelledMessages(partition, sessionId, messageIds, hostEpoch);
  }

  /** Durable Host tombstones identify a Message across Host process restarts. */
  retireCancelledMessages(partition: string, sessionId: string, messageIds: readonly string[]): boolean {
    return this.#retireCancelledMessages(partition, sessionId, messageIds);
  }

  #retireCancelledMessages(
    partition: string, sessionId: string, messageIds: readonly string[], hostEpoch?: string,
  ): boolean {
    if (!messageIds.length) return false;
    return this.#transaction(() => {
      let changed = false;
      const remove = this.#db.prepare(
        'DELETE FROM outbox WHERE partition = ? AND session_id = ? AND message_id = ?',
      );
      for (const messageId of messageIds) {
        const record = this.get(partition, messageId);
        if (!record || record.sessionId !== sessionId || !record.intent.originHostEpoch) continue;
        if (hostEpoch !== undefined && record.intent.originHostEpoch !== hostEpoch) continue;
        if (remove.run(partition, sessionId, messageId).changes) changed = true;
      }
      // Like retireObservedMessages, removing outbox rows does not invalidate
      // a pending canonical transcript snapshot for the same Session.
      return changed;
    });
  }

  saveTranscript(partition: string, snapshot: DesktopTranscriptReplicaSnapshot): void {
    // Persist durable evidence only. Live assistant fragments and old running
    // claims must not masquerade as current execution after restart.
    const payload = JSON.stringify({ ...snapshot, overlay: [] });
    if (Buffer.byteLength(payload) > MAX_CACHE_SESSION_BYTES) return;
    this.#transaction(() => {
      this.#db
        .prepare(`INSERT INTO transcripts VALUES (?, ?, ?, ?)
        ON CONFLICT(partition, session_id) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at`)
        .run(partition, snapshot.sessionId, payload, this.now());
      let total = Number(
        this.#db
          .prepare(
            'SELECT COALESCE(SUM(length(CAST(snapshot AS BLOB))), 0) AS bytes FROM transcripts',
          )
          .get()!.bytes,
      );
      for (const row of this.#db
        .prepare(
          'SELECT rowid, length(CAST(snapshot AS BLOB)) AS bytes FROM transcripts ORDER BY updated_at, rowid',
        )
        .all()) {
        if (total <= MAX_CACHE_BYTES) break;
        this.#db.prepare('DELETE FROM transcripts WHERE rowid = ?').run(row.rowid!);
        total -= Number(row.bytes);
      }
    });
  }

  transcript(
    partition: string,
    sessionId: string,
  ): { snapshot: DesktopTranscriptReplicaSnapshot; cachedAt: number } | undefined {
    const row = this.#db
      .prepare(
        'SELECT snapshot, updated_at FROM transcripts WHERE partition = ? AND session_id = ? AND updated_at >= ?',
      )
      .get(partition, sessionId, this.now() - CACHE_TTL_MS);
    return row
      ? {
          snapshot: JSON.parse(String(row.snapshot)) as DesktopTranscriptReplicaSnapshot,
          cachedAt: Number(row.updated_at),
        }
      : undefined;
  }

  removeSession(partition: string, sessionId: string): void {
    for (const table of ['outbox', 'sessions', 'transcripts'])
      this.#db
        .prepare(`DELETE FROM ${table} WHERE partition = ? AND session_id = ?`)
        .run(partition, sessionId);
    this.#revision += 1;
  }

  purge(partition: string): void {
    this.#transaction(() => {
      for (const table of ['outbox', 'sessions', 'transcripts'])
        this.#db.prepare(`DELETE FROM ${table} WHERE partition = ?`).run(partition);
    });
    this.#revision += 1;
  }

  #transaction<T>(operation: () => T): T {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      this.#db.exec('ROLLBACK');
      throw error;
    }
  }
}
