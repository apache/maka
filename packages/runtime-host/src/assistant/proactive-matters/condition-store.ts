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

import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  assertEventWaitTransition,
  decodeEventWaitRecord,
  eventWaitDeliveryKey,
  type EventWaitRecord,
} from '@maka/core/event-wait';
import type {
  EventWaitObservationStore,
  ObservationWaitSnapshot,
} from '../../server/event-wait-observation-store.js';
import {
  conditionId,
  normalizeCondition,
  parseConditionResult,
  type TestedCondition,
  type ConditionDefinition,
  type ConditionResult,
} from './condition.js';
import type { Matter } from './matter.js';

/** Shares Matter's DB transaction: settlement, wait installation and wake delivery are atomic. */
export class MatterConditions {
  constructor(
    private db: DatabaseSync,
    private now: () => number,
    private transaction: <T>(fn: () => T) => T,
    private matter: (id: string) => Matter,
    private deliver: (matter: Matter, wait: EventWaitRecord) => void,
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS matter_checkers(id TEXT PRIMARY KEY, matter_id TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS matter_conditions(id TEXT PRIMARY KEY, matter_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS matter_conditions_owner ON matter_conditions(matter_id);
      CREATE TABLE IF NOT EXISTS matter_condition_sources(id TEXT PRIMARY KEY, cooldown INTEGER NOT NULL DEFAULT 0, token TEXT, reserved_until INTEGER NOT NULL DEFAULT 0);`);
  }
  saveTest(
    matterId: string,
    definition: ConditionDefinition,
    result: ConditionResult,
  ): TestedCondition {
    const captured = normalizeCondition(definition);
    const checked = parseConditionResult(result);
    const record = {
      id: conditionId(matterId, captured),
      matterId,
      definition: captured,
      testedAt: this.now(),
      result: checked,
    };
    this.db
      .prepare(
        'INSERT INTO matter_checkers(id,matter_id,payload) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload',
      )
      .run(record.id, matterId, JSON.stringify(record));
    return record;
  }
  checker(id: string, matterId: string): TestedCondition {
    const row = this.db
      .prepare('SELECT payload FROM matter_checkers WHERE id=? AND matter_id=?')
      .get(id, matterId);
    if (!row) throw new Error('Checker must be successfully tested in this matter first');
    return JSON.parse(String(row.payload));
  }
  /** Called only inside the settlement transaction. Testing alone never starts observation. */
  install(m: Matter, checkerId: string, intervalMs: number, submittedAt: number): void {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 86400000)
      throw new Error('Condition intervalMs must be 1000–86400000');
    this.checker(checkerId, m.id);
    const id = randomUUID();
    const record = decodeEventWaitRecord({
      schemaVersion: 1,
      waitId: id,
      sessionId: m.sessionId,
      sourceTurnId: m.activation!.turnId,
      sourceToolCallId: m.activation!.id,
      resource: {
        providerId: 'matter',
        connectionId: m.sessionId,
        resourceType: 'checker',
        resourceId: m.id,
      },
      condition: { typeId: 'code', version: 1, parameters: { checkerId, intervalMs } },
      deliveryKey: eventWaitDeliveryKey(id),
      createdAt: submittedAt,
      updatedAt: submittedAt,
      deadlineAt: Math.min(...m.wakes.map((w) => w.at)),
      status: 'waiting',
    });
    this.db
      .prepare('INSERT INTO matter_conditions(id,matter_id,revision,payload) VALUES(?,?,1,?)')
      .run(id, m.id, JSON.stringify(record));
    m.conditionWaitId = id;
  }
  read(id: string): ObservationWaitSnapshot | null {
    const row = this.db
      .prepare('SELECT revision,payload FROM matter_conditions WHERE id=?')
      .get(id);
    return row
      ? {
          authorityRevision: Number(row.revision),
          record: decodeEventWaitRecord(JSON.parse(String(row.payload))),
        }
      : null;
  }
  /** The caller is already inside a Matter transaction; retirement also clears the time fallback. */
  retire(m: Matter, reason: string): void {
    if (!m.conditionWaitId) return;
    const snapshot = this.read(m.conditionWaitId);
    if (snapshot?.record.status === 'waiting') {
      const record = {
        ...snapshot.record,
        status: 'cancelled' as const,
        reason,
        updatedAt: Math.max(this.now(), snapshot.record.updatedAt),
        cancelledAt: Math.max(this.now(), snapshot.record.updatedAt),
      };
      this.write(snapshot, record);
    }
    m.conditionWaitId = null;
    m.wakes = [];
  }
  /** Called by the existing time scanner, independent of source availability. */
  expire(m: Matter): boolean {
    if (!m.conditionWaitId) return false;
    const snapshot = this.read(m.conditionWaitId);
    if (snapshot?.record.status === 'waiting' && this.now() >= snapshot.record.deadlineAt) {
      const record: EventWaitRecord = {
        ...snapshot.record,
        status: 'expired',
        expiredAt: this.now(),
        updatedAt: this.now(),
      };
      this.write(snapshot, record);
      this.deliver(m, record);
    }
    return true;
  }
  private write(before: ObservationWaitSnapshot, record: EventWaitRecord): ObservationWaitSnapshot {
    assertEventWaitTransition(before.record, record);
    const snapshot = { authorityRevision: before.authorityRevision + 1, record };
    this.db
      .prepare('UPDATE matter_conditions SET revision=?,payload=? WHERE id=?')
      .run(snapshot.authorityRevision, JSON.stringify(record), record.waitId);
    return snapshot;
  }
  private eligible(r: EventWaitRecord): boolean {
    const m = this.matter(r.resource.resourceId);
    return m.conditionWaitId === r.waitId && m.status === 'waiting' && !m.activation;
  }
  private assertLease(owner: string): void {
    const row = this.db.prepare('SELECT owner,until_ms FROM plugin_lease WHERE id=1').get();
    if (!row || row.owner !== owner || Number(row.until_ms) <= this.now())
      throw new Error('Matter observation lease lost');
  }
  observationStore(owner: string): EventWaitObservationStore {
    const sourceId = (x: { providerId: string; connectionId: string | null }) =>
      JSON.stringify([x.providerId, x.connectionId]);
    const source = (x: { providerId: string; connectionId: string | null }) => {
      const id = sourceId(x);
      this.db.prepare('INSERT OR IGNORE INTO matter_condition_sources(id) VALUES(?)').run(id);
      return this.db.prepare('SELECT * FROM matter_condition_sources WHERE id=?').get(id)!;
    };
    const guarded = <T>(fn: () => T): T =>
      this.transaction(() => {
        this.assertLease(owner);
        return fn();
      });
    const waits = () =>
      this.db
        .prepare(`SELECT c.id FROM matter_conditions c JOIN matters m ON m.id=c.matter_id
      WHERE json_extract(m.payload,'$.conditionWaitId')=c.id
        AND json_extract(m.payload,'$.status')='waiting'
        AND json_extract(m.payload,'$.activation') IS NULL ORDER BY c.id`)
        .all()
        .map((row) => this.read(String(row.id))!)
        .filter((s) => this.eligible(s.record));
    return {
      read: async ({ sessionId, waitId }) =>
        guarded(() => {
          const s = this.read(waitId);
          return s?.record.sessionId === sessionId ? s : null;
        }),
      listByStatus: async ({ status, afterWaitId, limit }) =>
        guarded(() => {
          const all = waits().filter(
            (s) => s.record.status === status && (!afterWaitId || s.record.waitId > afterWaitId),
          );
          const items = all.slice(0, limit);
          return { items, nextCursor: all.length > limit ? items.at(-1)!.record.waitId : null };
        }),
      listForObservation: async (input) =>
        guarded(() => {
          const excluded = new Set(input.excludedWaitIds),
            sources = new Set(input.excludedSources?.map(sourceId));
          const items = waits().filter(
            ({ record: r }) =>
              r.status === 'waiting' &&
              !excluded.has(r.waitId) &&
              !sources.has(sourceId(r.resource)) &&
              (!input.scan?.afterWaitId || r.waitId > input.scan.afterWaitId) &&
              input.now >= (r.observation?.nextPollAt ?? r.createdAt),
          );
          if (!input.scan)
            items.sort(
              (a, b) =>
                (a.record.observation?.lastAttemptAt ?? 0) -
                (b.record.observation?.lastAttemptAt ?? 0),
            );
          return items.slice(0, input.limit);
        }),
      commit: async (input) =>
        guarded(() => {
          const before = this.read(input.waitId);
          if (!before || before.authorityRevision !== input.expectedAuthorityRevision)
            return {
              kind: 'revision_conflict',
              actualAuthorityRevision: before?.authorityRevision ?? null,
            };
          if (before.record.sessionId !== input.sessionId || !this.eligible(before.record))
            return { kind: 'session_unavailable' };
          let record = decodeEventWaitRecord(input.record);
          if (record.status === 'waiting' && record.observation?.outcome === 'pending') {
            const next =
              (record.observation.lastObservedAt ?? record.observation.lastAttemptAt) +
              Number(record.condition.parameters.intervalMs);
            record = {
              ...record,
              observation: { ...record.observation, nextObserveAt: next, nextPollAt: next },
            };
          }
          const snapshot = this.write(before, record);
          if (record.status !== 'waiting') {
            // Source revocation/cancellation must be visible to the worker too, not silently forgotten.
            this.deliver(this.matter(record.resource.resourceId), record);
          }
          return { kind: 'committed', snapshot };
        }),
      readSourceCooldown: async (x) =>
        guarded(() => {
          const r = source(x);
          return Math.max(Number(r.cooldown), Number(r.reserved_until)) || null;
        }),
      extendSourceCooldown: async (x) =>
        guarded(() => {
          const until = Math.max(Number(source(x).cooldown), x.until);
          this.db
            .prepare('UPDATE matter_condition_sources SET cooldown=? WHERE id=?')
            .run(until, sourceId(x));
          return until;
        }),
      reserveSourceDispatch: async (x) =>
        guarded(() => {
          const r = source(x);
          if (Math.max(Number(r.cooldown), Number(r.reserved_until)) > x.observedAt) return false;
          this.db
            .prepare('UPDATE matter_condition_sources SET token=?,reserved_until=? WHERE id=?')
            .run(x.token, x.until, sourceId(x));
          return true;
        }),
      completeSourceDispatch: async (x) =>
        guarded(() => {
          const r = source(x);
          if (r.token === x.token)
            this.db
              .prepare(
                'UPDATE matter_condition_sources SET token=NULL,reserved_until=0,cooldown=? WHERE id=?',
              )
              .run(Math.max(Number(r.cooldown), x.until), sourceId(x));
          const current = source(x);
          return Math.max(Number(current.cooldown), Number(current.reserved_until));
        }),
    };
  }
}
