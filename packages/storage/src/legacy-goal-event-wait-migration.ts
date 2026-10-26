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

import type { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { decodeEventWaitRecord, EVENT_WAIT_LIMITS } from '@maka/core/event-wait';
import { decodeLegacyEventWaitProvenance } from '@maka/core/event-wait-delivery';
import { decodeGoalAuthorityRecord, GOAL_REASON_TEXT_LIMIT } from '@maka/core/goal';
import { isRecord } from '@maka/core/record-schema';

const RETIREMENT_REASON =
  'Legacy Goal event wait retired during upgrade. Resume the Goal and register a new wait.';

/**
 * Runs inside the owner's schema transaction, before any current decoder or
 * observer reads the rows. Only the released PR3/PR4 format is retired. Neutral
 * observations, v2 consumers, cooldowns and immutable execution facts survive.
 * Also handles roots already advanced to v16 before their first read failed.
 */
export function retireLegacyGoalEventWaits(db: DatabaseSync, now: number): void {
  let afterSession = '';
  for (;;) {
    const rows = db
      .prepare(`SELECT * FROM workflow_goal_authority
      WHERE session_id > ? AND (json_type(record_json, '$.activeEventWait') IS NOT NULL
        OR json_type(record_json, '$.pendingContinuation.eventWait') IS NOT NULL)
      ORDER BY session_id LIMIT 100`)
      .all(afterSession);
    if (!rows.length) break;
    for (const row of rows) {
      afterSession = String(row.session_id);
      const raw = JSON.parse(String(row.record_json));
      const gate = exact(raw.activeEventWait, [
        'waitId',
        'sourceExecution',
        'controlLease',
        'reason',
        'settled',
      ]);
      const { activeEventWait: _gate, pendingContinuation, ...base } = raw;
      const oldEvent = pendingContinuation?.eventWait;
      let pending = pendingContinuation;
      if (oldEvent !== undefined) {
        const { eventWait: _event, ...rest } = pendingContinuation;
        pending = rest;
      }
      const old = decodeGoalAuthorityRecord({ ...base, pendingContinuation: pending });
      integer(row.authority_revision);
      if (
        old.goal.sessionId !== row.session_id ||
        old.goal.id !== row.goal_id ||
        old.goal.revision !== row.goal_revision ||
        old.goal.status !== row.status ||
        !['active', 'waiting'].includes(old.goal.status)
      )
        invalid();
      if (
        typeof gate.settled !== 'boolean' ||
        typeof gate.reason !== 'string' ||
        !gate.reason.trim() ||
        gate.reason.length > GOAL_REASON_TEXT_LIMIT.codeUnits ||
        Buffer.byteLength(gate.reason) > GOAL_REASON_TEXT_LIMIT.utf8Bytes
      )
        invalid();
      const source = execution(gate.sourceExecution, old.goal.sessionId);
      if (!isDeepStrictEqual(gate.controlLease, old.controlLease)) invalid();
      const waitRow = db
        .prepare('SELECT * FROM workflow_event_waits WHERE wait_id = ?')
        .get(id(gate.waitId));
      if (!waitRow) invalid();
      const wait = legacyWait(waitRow!);
      if (
        wait.record.sessionId !== old.goal.sessionId ||
        wait.record.sourceTurnId !== source.turnId ||
        !isDeepStrictEqual(wait.lease, old.controlLease) ||
        wait.delivery !== undefined
      )
        invalid();
      if (oldEvent !== undefined) {
        const event = exact(oldEvent, ['execution', 'userMessageId', 'provenance']);
        execution(event.execution, old.goal.sessionId);
        id(event.userMessageId);
        const provenance = decodeLegacyEventWaitProvenance(event.provenance);
        if (
          !gate.settled ||
          provenance.waitId !== gate.waitId ||
          provenance.sourceTurnId !== source.turnId ||
          provenance.generation !== old.controlLease.generation ||
          pending.triggeringTurnId !== source.turnId
        )
          invalid();
      } else if (pending) invalid();
      if (
        !gate.settled &&
        (!old.currentExecution || old.currentExecution.execution.turnId !== source.turnId)
      )
        invalid();
      if (gate.settled && old.currentExecution) invalid();
      const record = decodeGoalAuthorityRecord({
        ...base,
        goal: {
          ...old.goal,
          revision: old.goal.revision + 1,
          status: 'paused',
          pausedAt: now,
          lastReason: RETIREMENT_REASON,
        },
        controlLease: { ...old.controlLease, generation: old.controlLease.generation + 1 },
        currentExecution: old.currentExecution,
        pendingContinuation: null,
        ...(!gate.settled ? { legacyEventWaitSettlement: source } : {}),
      });
      db.prepare(`UPDATE workflow_goal_authority SET authority_revision = authority_revision + 1,
        goal_revision = ?, status = ?, record_json = ? WHERE session_id = ?`).run(
        record.goal.revision,
        record.goal.status,
        JSON.stringify(record),
        row.session_id,
      );
    }
  }

  let afterWait = '';
  for (;;) {
    const rows = db
      .prepare(`SELECT * FROM workflow_event_waits WHERE wait_id > ?
      AND json_type(record_json, '$.goalControlLease') IS NOT NULL ORDER BY wait_id LIMIT 100`)
      .all(afterWait);
    if (!rows.length) break;
    for (const row of rows) {
      const { record } = legacyWait(row);
      afterWait = record.waitId;
      db.prepare('DELETE FROM workflow_event_waits WHERE wait_id = ?').run(record.waitId);
    }
  }
}

function legacyWait(row: Record<string, unknown>) {
  const json = String(row.record_json);
  if (Buffer.byteLength(json) > EVENT_WAIT_LIMITS.recordBytes) invalid();
  const { goalControlLease, delivery, ...neutral } = JSON.parse(json);
  const lease = exact(goalControlLease, ['goalId', 'generation']);
  id(lease.goalId);
  integer(lease.generation);
  // Validate the shared source/condition/lifecycle without ever registering it
  // as a neutral observation. Unknown fields and versions still fail closed.
  const record = decodeEventWaitRecord(neutral);
  if (
    record.waitId !== row.wait_id ||
    record.sessionId !== row.session_id ||
    record.status !== row.status ||
    record.deliveryKey !== row.delivery_key ||
    record.deadlineAt !== row.deadline_at
  )
    invalid();
  integer(row.authority_revision);
  if (delivery !== undefined) {
    if (record.status === 'waiting') invalid();
    const terminalAt =
      record.status === 'resolved'
        ? record.resolvedAt
        : record.status === 'expired'
          ? record.expiredAt
          : record.cancelledAt;
    if (delivery.kind === 'admitted') {
      exact(delivery, ['kind', 'turnId', 'runId', 'userMessageId', 'at']);
      if (record.status !== 'resolved' && record.status !== 'expired') invalid();
      id(delivery.turnId);
      id(delivery.runId);
      id(delivery.userMessageId);
    } else {
      exact(delivery, ['kind', 'at', 'reason']);
      if (
        delivery.kind !== 'suppressed' ||
        typeof delivery.reason !== 'string' ||
        !delivery.reason.trim() ||
        Buffer.byteLength(delivery.reason) > EVENT_WAIT_LIMITS.reasonBytes
      )
        invalid();
    }
    integer(delivery.at);
    if (delivery.at < terminalAt || delivery.at > record.updatedAt) invalid();
  }
  return { record, lease, delivery };
}

function execution(value: unknown, sessionId: string) {
  const ref = exact(value, ['sessionId', 'turnId', 'runId']);
  if (ref.sessionId !== sessionId) invalid();
  return { sessionId, turnId: id(ref.turnId), runId: id(ref.runId) };
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) invalid();
  return value as Record<string, unknown>;
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) invalid();
  return value as string;
}
function integer(value: unknown): void {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
}
function invalid(): never {
  throw new TypeError('Unrecognized legacy Goal event wait; migration rolled back');
}
