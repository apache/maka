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

import type { WorkHubVoiceTranscriptInput } from '../protocol/workhub-coordination.js';
import type { WorkHubVoiceObservation } from '../protocol/workhub-voice-state.js';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { lstat, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  decodeVoiceQueueItem,
  decodeVoiceRequest,
  decodeVoiceEnqueue,
  type VoiceRequest,
  type VoiceEnqueueInput,
  decodeVoiceState,
  type VoiceQueueItem,
  type VoiceDeliveryInput,
  type WorkHubVoiceState,
  type VoiceReview,
} from '../protocol/workhub-voice-state.js';

import { recordWorkHubVoiceCall } from './workhub-voice-call-state.js';

const writes = new Map<string, Promise<unknown>>();
export const VOICE_QUEUE_FILENAME = 'voice-queue.sqlite';
interface StoredVoiceState extends WorkHubVoiceState {
  version: 3;
  discardOnRelease: string[];
  requests?: VoiceRequest[];
  transcripts?: WorkHubVoiceTranscriptInput[];
  checkedThrough?: Record<string, number>;
}
export interface VoiceQueueUpdate {
  upsert?: VoiceQueueItem[];
  remove?: string[];
  order?: string[];
  resolveDeliveries?: string[];
}

/** One Host owns list projections and the append-only log in the same SQLite transaction. */
export class WorkHubVoiceStateStore {
  private database?: DatabaseSync;
  readonly logPath: string;
  constructor(readonly path: string) {
    this.logPath = path;
  }

  #append(kind: string, data: unknown, callId?: string, id: string = randomUUID()): void {
    // Deltas may arrive after the independent final-transcript write. Never
    // resurrect temporary fragments once this call/turn has its final record.
    if (
      kind === 'transcript_delta' &&
      data &&
      typeof data === 'object' &&
      'nativeTurnId' in data &&
      typeof data.nativeTurnId === 'string' &&
      this.database!.prepare(`SELECT 1 FROM voice_log WHERE kind = 'transcript'
          AND call_id IS ? AND json_extract(data, '$.nativeTurnId') = ? LIMIT 1`).get(
        callId ?? null,
        data.nativeTurnId,
      )
    )
      return;
    const encoded = JSON.stringify(data);
    const prior = this.database!.prepare(
      'SELECT kind, data, call_id FROM voice_log WHERE id = ?',
    ).get(id);
    if (prior) {
      if (prior.kind !== kind || prior.data !== encoded || prior.call_id !== (callId ?? null))
        throw new Error('Voice log identity reused');
      return;
    }
    this.database!.prepare(
      'INSERT INTO voice_log (id, at, kind, call_id, data) VALUES (?, ?, ?, ?, ?)',
    ).run(id, Date.now(), kind, callId ?? null, encoded);
  }

  log(
    input: {
      callId?: string;
      kind?: string;
      query?: string;
      relatedId?: string;
      after?: number;
      before?: number;
      snapshot?: number;
      limit?: number;
      turns?: boolean;
    } = {},
    modelTurnId?: string,
  ) {
    return this.#locked(async () => {
      await this.#load();
      if (
        input.snapshot !== undefined &&
        (!Number.isSafeInteger(input.snapshot) || input.snapshot < 0)
      )
        throw new Error('Voice log snapshot must be a non-negative safe integer');
      const latest = Number(
        this.database!.prepare('SELECT COALESCE(MAX(seq), 0) AS sequence FROM voice_log').get()!
          .sequence,
      );
      let ceiling = latest;
      if (modelTurnId) {
        const saved = this.database!.prepare(
          'SELECT sequence FROM voice_log_snapshots WHERE turn_id = ?',
        ).get(modelTurnId);
        if (saved) ceiling = Number(saved.sequence);
        else {
          ceiling = Math.min(latest, input.snapshot ?? latest);
          this.database!.prepare(
            'INSERT INTO voice_log_snapshots (turn_id, sequence) VALUES (?, ?)',
          ).run(modelTurnId, ceiling);
        }
      }
      const snapshot = Math.min(ceiling, input.snapshot ?? ceiling);
      if (input.turns) {
        const limit = Math.min(input.limit ?? 6, 64);
        const rows = this.database!.prepare(`
          WITH facts AS (
            SELECT seq, at, call_id, kind,
              json_extract(data, '$.nativeTurnId') AS turn_id,
              json_extract(data, '$.role') AS role,
              COALESCE(json_extract(data, '$.text'), json_extract(data, '$.delta'), '') AS text,
              json_extract(data, '$.start_ms') AS start_ms,
              json_extract(data, '$.end_ms') AS end_ms
            FROM voice_log
            WHERE kind IN ('transcript', 'transcript_delta') AND seq <= ?
              AND (? IS NULL OR call_id = ?) AND (? IS NULL OR at <= ?)
              AND json_extract(data, '$.nativeTurnId') IS NOT NULL
          ), grouped AS (
            SELECT call_id, turn_id, MAX(seq) AS sequence, MAX(at) AS at,
              MAX(role) AS role, MAX(kind = 'transcript') AS final,
              MIN(start_ms) AS start_ms, MAX(end_ms) AS end_ms,
              COALESCE(MAX(CASE WHEN kind = 'transcript' THEN text END),
                group_concat(CASE WHEN kind = 'transcript_delta' THEN text END, '' ORDER BY seq)) AS text
            FROM facts GROUP BY call_id, turn_id
          ) SELECT * FROM grouped WHERE sequence > ?
            AND (? IS NULL OR instr(text, ?) > 0)
            AND (? IS NULL OR instr(turn_id, ?) > 0)
          ORDER BY sequence LIMIT ?
        `).all(
          snapshot,
          input.callId ?? null,
          input.callId ?? null,
          input.before ?? null,
          input.before ?? null,
          input.after ?? 0,
          input.query ?? null,
          input.query ?? null,
          input.relatedId ?? null,
          input.relatedId ?? null,
          limit + 1,
        );
        const entries = rows.slice(0, limit).map((row) => ({
          sequence: Number(row.sequence),
          id: String(row.turn_id),
          at: Number(row.at),
          kind: row.final ? 'transcript' : 'transcript_partial',
          callId: row.call_id,
          data: {
            nativeTurnId: String(row.turn_id),
            role: String(row.role),
            text: String(row.text),
            final: Boolean(row.final),
            ...(row.start_ms == null ? {} : { start_ms: Number(row.start_ms) }),
            ...(row.end_ms == null ? {} : { end_ms: Number(row.end_ms) }),
          } as unknown,
        }));
        return {
          snapshot,
          entries,
          ...(rows.length > limit ? { nextAfter: entries.at(-1)!.sequence } : {}),
        };
      }
      const conditions = ['seq > ?', 'seq <= ?'];
      const args: Array<string | number> = [input.after ?? 0, snapshot];
      for (const [column, value] of [
        ['call_id', input.callId],
        ['kind', input.kind],
      ] as const)
        if (value !== undefined) {
          conditions.push(`${column} = ?`);
          args.push(value);
        }
      if (input.before !== undefined) {
        conditions.push('at <= ?');
        args.push(input.before);
      }
      for (const value of [input.query, input.relatedId])
        if (value) {
          conditions.push('instr(data, ?) > 0');
          args.push(value);
        }
      const limit = Math.min(input.limit ?? 16, 64);
      const rows = this.database!.prepare(
        `SELECT seq, id, at, kind, call_id, data FROM voice_log WHERE ${conditions.join(' AND ')} ORDER BY seq LIMIT ?`,
      ).all(...args, limit + 1);
      const entries = rows.slice(0, limit).map((row) => ({
        sequence: Number(row.seq),
        id: String(row.id),
        at: Number(row.at),
        kind: String(row.kind),
        callId: row.call_id,
        data: JSON.parse(String(row.data)) as unknown,
      }));
      return {
        snapshot,
        entries,
        ...(rows.length > limit ? { nextAfter: entries.at(-1)!.sequence } : {}),
      };
    });
  }

  async #load(): Promise<StoredVoiceState> {
    const saved = this.database!.prepare('SELECT data FROM voice_state WHERE singleton = 1').get();
    if (!saved) return { version: 3, queue: [], deliveries: [], discardOnRelease: [] };
    const value = JSON.parse(String(saved.data)) as StoredVoiceState;
    const fields = new Set([
      'version',
      'queue',
      'deliveries',
      'responses',
      'review',
      'discardOnRelease',
      'requests',
      'transcripts',
      'checkedThrough',
    ]);
    if (
      !value ||
      value.version !== 3 ||
      Object.keys(value).some((key) => !fields.has(key)) ||
      !Array.isArray(value.discardOnRelease) ||
      value.discardOnRelease.some((id) => typeof id !== 'string')
    )
      throw new Error('Unsupported voice state format');
    if (
      value.checkedThrough &&
      Object.values(value.checkedThrough).some(
        (sequence) => !Number.isSafeInteger(sequence) || sequence < 0,
      )
    )
      throw new Error('Invalid voice review cursor');
    return {
      version: 3,
      ...decodeVoiceState({
        queue: value.queue,
        deliveries: value.deliveries,
        ...(value.responses?.length ? { responses: value.responses } : {}),
        ...(value.review ? { review: value.review } : {}),
      }),
      discardOnRelease: value.discardOnRelease,
      requests: (value.requests ?? []).map(decodeVoiceRequest),
      transcripts: value.transcripts ?? [],
      checkedThrough: value.checkedThrough ?? {},
    };
  }

  #snapshot(state: StoredVoiceState): WorkHubVoiceState {
    return {
      ...(state.review ? { review: state.review } : {}),
      queue: state.queue,
      ...(state.responses?.length ? { responses: state.responses } : {}),
      deliveries: state.deliveries,
    };
  }
  snapshot(): Promise<WorkHubVoiceState> {
    return this.#locked(async () => this.#snapshot(await this.#load()));
  }
  read(): Promise<WorkHubVoiceState> {
    return this.snapshot();
  }

  /** Model view: active state only. Sent scripts stay in the archive, not every tool result. */
  current(input: { offset?: number; limit?: number; itemId?: string } = {}) {
    return this.#locked(async () => {
      const state = await this.#load();
      const offset = input.offset ?? 0,
        limit = Math.min(input.limit ?? 8, 16);
      return {
        queue: state.queue
          .filter((item) => !input.itemId || item.id === input.itemId)
          .slice(offset, offset + limit)
          .map(({ id, text, reply }) => ({
            id,
            ...(input.itemId ? { text } : { preview: text.slice(0, 240) }),
            ...(reply ? { reply } : {}),
          })),
        total: state.queue.length,
        offset,
        ...(offset + limit < state.queue.length ? { nextOffset: offset + limit } : {}),
        blocked: state.deliveries
          .filter((d) => d.status === 'reserved' || d.status === 'uncertain')
          .map(({ id, deliveryId, status }) => ({ id, deliveryId, status })),
        archive: 'voice_log_read for history; voice_queue_read itemId for full prepared content',
      };
    });
  }

  async #save(state: StoredVoiceState): Promise<void> {
    if (state.queue.length > 256 || Buffer.byteLength(JSON.stringify(state.queue)) > 96_000)
      throw new Error('Voice queue is too large');
    const saved = this.database!.prepare('SELECT data FROM voice_state WHERE singleton = 1').get();
    const before = saved ? (JSON.parse(String(saved.data)) as StoredVoiceState) : undefined;
    if (!isDeepStrictEqual(before?.queue ?? [], state.queue))
      this.#append('queue_changed', {
        upsert: state.queue.filter(
          (item) =>
            !isDeepStrictEqual(
              before?.queue.find((old) => old.id === item.id),
              item,
            ),
        ),
        remove: (before?.queue ?? [])
          .filter((item) => !state.queue.some((next) => next.id === item.id))
          .map((item) => item.id),
        order: state.queue.map((item) => item.id),
      });
    for (const item of state.responses ?? [])
      if (!before?.responses?.some((old) => old.id === item.id))
        this.#append(
          'reply_prepared',
          { id: item.id, requestId: item.reply!.id, text: item.text },
          item.reply!.callId,
        );
    for (const item of state.deliveries)
      if (
        !isDeepStrictEqual(
          before?.deliveries.find((d) => d.deliveryId === item.deliveryId),
          item,
        )
      )
        this.#append(
          'delivery_' + item.status,
          {
            id: item.id,
            deliveryId: item.deliveryId,
            status: item.status,
            ...(item.reply
              ? { requestId: item.reply.id, channel: 'reply' }
              : { channel: 'supplement' }),
          },
          item.callId,
        );
    for (const item of before?.deliveries ?? [])
      if (!state.deliveries.some((d) => d.deliveryId === item.deliveryId))
        this.#append(
          'delivery_released',
          { id: item.id, deliveryId: item.deliveryId },
          item.callId,
        );
    for (const item of state.transcripts ?? [])
      if (!before?.transcripts?.some((t) => t.id === item.id))
        this.#append('transcript', item, item.callId, 'transcript-' + item.id);
    for (const item of state.requests ?? [])
      if (!before?.requests?.some((r) => r.id === item.id))
        this.#append('request_registered', item, item.callId, 'request-' + item.id);
    this.database!.prepare(
      'INSERT INTO voice_state (singleton, data) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET data=excluded.data',
    ).run(JSON.stringify(state));
  }
  #locked<T>(operation: () => Promise<T>): Promise<T> {
    const next = (writes.get(this.path) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.logPath), { recursive: true });
        try {
          if ((await lstat(this.logPath)).isSymbolicLink())
            throw new Error('Voice log cannot be a symbolic link');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const db = new DatabaseSync(this.logPath);
        this.database = db;
        try {
          await chmod(this.logPath, 0o600);
          db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
          CREATE TABLE IF NOT EXISTS voice_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), data TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS voice_log_snapshots (turn_id TEXT PRIMARY KEY, sequence INTEGER NOT NULL CHECK(sequence >= 0));
          CREATE TABLE IF NOT EXISTS voice_log (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, at INTEGER NOT NULL, kind TEXT NOT NULL, call_id TEXT, data TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS voice_log_call ON voice_log(call_id, seq);
          CREATE TRIGGER IF NOT EXISTS voice_log_no_update BEFORE UPDATE ON voice_log BEGIN SELECT RAISE(ABORT, 'Voice log is append-only'); END;
          BEGIN IMMEDIATE;`);
          db.exec(`CREATE INDEX IF NOT EXISTS voice_log_native_turn
                ON voice_log(call_id, json_extract(data, '$.nativeTurnId'), kind);
              CREATE TRIGGER IF NOT EXISTS voice_log_no_delete BEFORE DELETE ON voice_log
                WHEN OLD.kind != 'transcript_delta' OR NOT EXISTS (
                  SELECT 1 FROM voice_log final WHERE final.kind = 'transcript'
                    AND final.call_id IS OLD.call_id
                    AND json_extract(final.data, '$.nativeTurnId') = json_extract(OLD.data, '$.nativeTurnId')
                ) BEGIN SELECT RAISE(ABORT, 'Voice log is append-only except finalized transcript fragments'); END;
              CREATE TRIGGER IF NOT EXISTS voice_log_finalize_transcript AFTER INSERT ON voice_log
                WHEN NEW.kind = 'transcript' BEGIN
                  DELETE FROM voice_log WHERE kind = 'transcript_delta' AND call_id IS NEW.call_id
                    AND json_extract(data, '$.nativeTurnId') = json_extract(NEW.data, '$.nativeTurnId');
                END;
`);
          const result = await operation();
          db.exec('COMMIT');
          return result;
        } catch (error) {
          try {
            db.exec('ROLLBACK');
          } catch {}
          throw error;
        } finally {
          this.database = undefined;
          db.close();
        }
      });
    writes.set(this.path, next);
    const cleanup = () => {
      if (writes.get(this.path) === next) writes.delete(this.path);
    };
    void next.then(cleanup, cleanup);
    return next;
  }

  request(input: VoiceRequest): Promise<WorkHubVoiceState> {
    return this.#locked(async () => {
      const request = decodeVoiceRequest(input);
      const state = await this.#load();
      const requests = (state.requests ??= []);
      const previous = requests.find((item) => item.id === request.id);
      if (previous && !isDeepStrictEqual(previous, request))
        throw new Error('Voice request identity reused');
      if (!previous) {
        if (requests.length >= 512) requests.shift();
        requests.push(request);
        await this.#save(state);
      }
      return this.#snapshot(state);
    });
  }

  /** Publish a WorkHub reply correlated to a registered voice request. */
  enqueue(input: VoiceEnqueueInput): Promise<WorkHubVoiceState> {
    return this.#locked(async () => {
      const output = decodeVoiceEnqueue(input);
      const state = await this.#load();
      this.#enqueue(state, output);
      await this.#save(state);
      return this.#snapshot(state);
    });
  }

  #enqueue(state: StoredVoiceState, output: VoiceEnqueueInput): void {
    const request = state.requests?.find((item) => item.id === output.requestId);
    if (!request) throw new Error('Unknown voice request');
    const item = decodeVoiceQueueItem({
      id: output.id,
      text: output.text,
      context: '',
      reply: { ...request, kind: output.kind },
    });
    const responses = (state.responses ??= []);
    const previous = [...responses, ...state.deliveries].find((old) => old.id === item.id);
    if (previous) {
      if (previous.text !== item.text || !isDeepStrictEqual(previous.reply, item.reply))
        throw new Error('Voice reply identity reused with different content');
      return;
    }
    if (state.queue.some((old) => old.id === item.id))
      throw new Error('Voice reply ID belongs to the supplemental list');
    if (responses.length >= 256) throw new Error('Too many pending voice replies');
    responses.push(item);
    return;
  }

  /** Merge ID operations against live state. Consumption and unseen additions never reject a ranking. */
  update(input: VoiceQueueUpdate): Promise<WorkHubVoiceState> {
    return this.#locked(async () => {
      const state = await this.#load();
      const upsert = (input.upsert ?? []).map(decodeVoiceQueueItem);
      if (
        upsert.some((item) => item.reply || state.responses?.some((reply) => reply.id === item.id))
      )
        throw new Error('WorkHub replies do not belong in the supplemental list');
      for (const ids of [upsert.map((item) => item.id), input.order ?? [], input.remove ?? []]) {
        if (
          new Set(ids).size !== ids.length ||
          ids.some((id) => !/^[A-Za-z0-9_-]{1,128}$/.test(id))
        )
          throw new Error('Invalid or duplicate voice queue id');
      }
      for (const id of input.resolveDeliveries ?? []) {
        const delivery = state.deliveries.find((item) => item.deliveryId === id);
        if (!delivery || delivery.status === 'reserved' || delivery.status === 'sent')
          throw new Error('Only uncertain deliveries may be resolved; use their deliveryId');
        delivery.status = 'resolved';
      }
      const owned = new Set(state.deliveries.map((item) => item.id));
      const removed = new Set(input.remove ?? []);
      if (upsert.some((item) => removed.has(item.id)))
        throw new Error('Cannot update and remove the same item');
      const items = new Map(
        state.queue.filter((item) => !removed.has(item.id)).map((item) => [item.id, item]),
      );
      for (const item of upsert) {
        if (owned.has(item.id)) continue;
        if (item.reply) throw new Error('List edits cannot rewrite reply attribution');
        items.set(item.id, item);
      }
      const order = (input.order ?? []).filter((id) => !owned.has(id) && !removed.has(id));
      if (order.some((id) => !items.has(id))) throw new Error('Unknown queue id in priority order');
      const ranked = new Set(order);
      state.queue = [
        ...order.map((id) => items.get(id)!),
        ...[...items.values()].filter((item) => !ranked.has(item.id)),
      ];
      // A cancellation during reservation also applies if the send is subsequently released.
      state.discardOnRelease = [
        ...new Set([
          ...state.discardOnRelease,
          ...state.deliveries
            .filter((item) => item.status === 'reserved' && removed.has(item.id))
            .map((item) => item.id),
        ]),
      ];
      await this.#save(state);
      return this.#snapshot(state);
    });
  }

  recordTranscript(input: WorkHubVoiceTranscriptInput): Promise<void> {
    return this.#locked(async () => {
      const state = await this.#load();
      const records = (state.transcripts ??= []);
      const previous = records.find((item) => item.id === input.id);
      if (previous) {
        if (!isDeepStrictEqual(previous, input)) throw new Error('Transcript identity reused');
        return;
      }
      records.push(input);
      await this.#save(state);
    });
  }

  receiveObservation(input: WorkHubVoiceObservation): Promise<WorkHubVoiceState> {
    return this.#locked(async () => {
      const state = await this.#load();
      if (input.discard?.length) {
        state.queue = state.queue.filter(
          (item) => !input.discard!.some((expected) => isDeepStrictEqual(item, expected)),
        );
      }
      for (const entry of input.entries) {
        this.#append(entry.kind, entry.data, input.callId, entry.id);
        recordWorkHubVoiceCall(this.path, input.callId, entry.kind);
        if (entry.kind === 'call_started') {
          // A transport from an earlier call cannot own the new call's outlet.
          for (const delivery of state.deliveries)
            if (
              delivery.callId !== input.callId &&
              (delivery.status === 'reserved' || delivery.status === 'uncertain')
            )
              delivery.status = 'resolved';
        }
      }
      await this.#save(state);
      return { ...this.#snapshot(state), receivedObservationId: input.id };
    });
  }

  /** Jev requests maintenance; a nonempty list does not block admission. */
  claimReview(callId: string, id: string): Promise<VoiceReview | undefined> {
    return this.#locked(async () => {
      const state = await this.#load();
      if (state.review?.status === 'admitted') return;
      const latestFact = Number(
        this.database!.prepare(`SELECT COALESCE(MAX(seq),0) AS n FROM voice_log
        WHERE call_id = ? AND kind IN ('transcript','transcript_delta','interruption','delegation','delivery_uncertain','jev_review')`).get(
          callId,
        )!.n,
      );
      const through = Number(
        this.database!.prepare(
          'SELECT COALESCE(MAX(seq),0) AS n FROM voice_log WHERE call_id = ?',
        ).get(callId)!.n,
      );
      const after = state.checkedThrough?.[callId] ?? 0;
      // A failed range is retained but not retried every outlet poll; new facts permit a fresh review.
      if (
        latestFact <= after ||
        (state.review?.callId === callId && latestFact <= state.review.through)
      )
        return;
      state.review = { id, callId, after, through, status: 'admitted' };
      this.database!.prepare(
        'INSERT OR IGNORE INTO voice_log_snapshots (turn_id,sequence) VALUES (?,?)',
      ).run(`voice-maintenance-${id}`, through);
      await this.#save(state);
      return state.review;
    });
  }

  releaseReview(id: string): Promise<void> {
    return this.#locked(async () => {
      const state = await this.#load();
      if (state.review?.id !== id || state.review.status !== 'admitted') return;
      delete state.review;
      await this.#save(state);
    });
  }

  finishReview(id: string, completed: boolean): Promise<void> {
    return this.#locked(async () => {
      const state = await this.#load();
      if (state.review?.id !== id || state.review.status !== 'admitted') return;
      state.review.status = completed ? 'completed' : 'failed';
      if (completed) (state.checkedThrough ??= {})[state.review.callId] = state.review.through;
      await this.#save(state);
    });
  }

  delivery(input: VoiceDeliveryInput): Promise<WorkHubVoiceState> {
    return this.#locked(async () => {
      const state = await this.#load();
      const previous = state.deliveries.find((item) => item.id === input.id);
      if (input.status === 'reserved') {
        const source = input.reply ? (state.responses ?? []) : state.queue;
        const item =
          input.reply || input.expectedQueue
            ? source.find((item) => item.id === input.id)
            : source[0];
        if (
          previous ||
          (input.expectedQueue !== undefined &&
            !isDeepStrictEqual(state.queue, input.expectedQueue)) ||
          !item ||
          (item.reply && item.reply.callId !== input.callId) ||
          item.id !== input.id ||
          item.text !== input.text ||
          item.context !== input.context ||
          !isDeepStrictEqual(item.reply, input.reply) ||
          state.deliveries.some(
            (item) =>
              !input.reply &&
              !item.reply &&
              (item.status === 'reserved' || item.status === 'uncertain'),
          )
        )
          return this.#snapshot(state);
        source.splice(source.indexOf(item), 1);
        state.deliveries.push({
          ...item,
          callId: input.callId,
          deliveryId: input.deliveryId,
          status: 'reserved',
        });
      } else {
        if (
          !previous ||
          (previous.status !== 'reserved' &&
            !(previous.status === 'sent' && input.status === 'uncertain')) ||
          previous.callId !== input.callId ||
          previous.deliveryId !== input.deliveryId ||
          previous.text !== input.text ||
          previous.context !== input.context ||
          !isDeepStrictEqual(previous.reply, input.reply)
        )
          return this.#snapshot(state);
        if (input.status === 'release') {
          state.deliveries.splice(state.deliveries.indexOf(previous), 1);
          if (!state.discardOnRelease.includes(input.id))
            (previous.reply ? (state.responses ??= []) : state.queue).unshift({
              id: previous.id,
              text: previous.text,
              context: previous.context,
              ...(previous.reply ? { reply: previous.reply } : {}),
            });
        } else previous.status = input.status;
        state.discardOnRelease = state.discardOnRelease.filter((id) => id !== input.id);
      }
      await this.#save(state);
      return this.#snapshot(state);
    });
  }
}
