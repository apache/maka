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
import { decodeGoalAuthorityRecord } from '@maka/core/goal';
import { decodeEventWaitRecord } from '@maka/core/event-wait';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import type { GoalAuthoritySnapshot } from './goal-authority.js';
import type { EventWaitSnapshot } from './event-wait-authority.js';
import { suppressGoalWait, type GoalWaitSnapshot } from './event-wait-bridge.js';

export function readBridgeGoal(db: DatabaseSync, sessionId: string): GoalAuthoritySnapshot | null {
  const row = db
    .prepare('SELECT * FROM workflow_goal_authority WHERE session_id = ?')
    .get(sessionId);
  if (!row) return null;
  const record = decodeGoalAuthorityRecord(JSON.parse(String(row.record_json)));
  if (
    record.goal.sessionId !== sessionId ||
    row.goal_id !== record.goal.id ||
    row.goal_revision !== record.goal.revision ||
    row.status !== record.goal.status ||
    typeof row.authority_revision !== 'number' ||
    !Number.isSafeInteger(row.authority_revision) ||
    row.authority_revision < 0
  )
    throw new Error('Corrupt Goal authority');
  return { authorityRevision: row.authority_revision, record };
}
export function readBridgeWait(
  db: DatabaseSync,
  sessionId: string,
  waitId: string,
): EventWaitSnapshot | null {
  const row = db.prepare('SELECT * FROM workflow_event_waits WHERE wait_id = ?').get(waitId);
  if (!row) return null;
  const record = decodeEventWaitRecord(JSON.parse(String(row.record_json)));
  if (
    record.sessionId !== sessionId ||
    row.session_id !== sessionId ||
    record.waitId !== waitId ||
    row.status !== record.status ||
    row.delivery_key !== record.deliveryKey ||
    row.deadline_at !== record.deadlineAt ||
    typeof row.authority_revision !== 'number' ||
    !Number.isSafeInteger(row.authority_revision) ||
    row.authority_revision < 0
  )
    throw new Error('Event wait ownership or indexed authority mismatch');
  return { authorityRevision: row.authority_revision, record };
}
export function readBridgeTermination(
  db: DatabaseSync,
  sessionId: string,
  runId: string,
): RuntimeEvent[] {
  return db
    .prepare(
      "SELECT payload_json FROM runtime_events WHERE session_id = ? AND run_id = ? AND json_extract(payload_json, '$.status') IN ('completed', 'failed', 'cancelled', 'aborted') ORDER BY event_seq DESC LIMIT 1",
    )
    .all(sessionId, runId)
    .map((row) => JSON.parse(String(row.payload_json)) as RuntimeEvent);
}
export function assertBridgeSession(db: DatabaseSync, sessionId: string): void {
  if (
    !db
      .prepare(
        'SELECT 1 FROM session_metadata WHERE session_id = ? AND is_archived = 0 AND NOT EXISTS (SELECT 1 FROM session_metadata_tombstones WHERE session_id = ?)',
      )
      .get(sessionId, sessionId)
  )
    throw new Error('Event wait Session is unavailable');
}
export function writeBridgeWait(db: DatabaseSync, wait: EventWaitSnapshot): void {
  const r = wait.record;
  db.prepare(`INSERT INTO workflow_event_waits(wait_id, session_id, authority_revision, status, delivery_key, deadline_at, record_json) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(wait_id) DO UPDATE SET authority_revision = excluded.authority_revision, status = excluded.status, record_json = excluded.record_json`).run(
    r.waitId,
    r.sessionId,
    wait.authorityRevision,
    r.status,
    r.deliveryKey,
    r.deadlineAt,
    JSON.stringify(r),
  );
}
export function writeBridgeSnapshot(
  db: DatabaseSync,
  snapshot: GoalWaitSnapshot,
): GoalWaitSnapshot {
  writeBridgeWait(db, snapshot.wait);
  const { goal, authorityRevision } = {
    goal: snapshot.goal.record,
    authorityRevision: snapshot.goal.authorityRevision,
  };
  db.prepare(
    'UPDATE workflow_goal_authority SET authority_revision = ?, goal_id = ?, goal_revision = ?, status = ?, record_json = ? WHERE session_id = ?',
  ).run(
    authorityRevision,
    goal.goal.id,
    goal.goal.revision,
    goal.goal.status,
    JSON.stringify(goal),
    goal.goal.sessionId,
  );
  return snapshot;
}
export function suppressPreviousBridgeWait(
  db: DatabaseSync,
  sessionId: string,
  next: import('@maka/core/goal').GoalAuthorityRecord | null,
): void {
  const old = readBridgeGoal(db, sessionId)?.record;
  const gate = old?.activeEventWait;
  if (
    !gate ||
    (next?.activeEventWait?.waitId === gate.waitId &&
      next.controlLease.goalId === gate.controlLease.goalId &&
      next.controlLease.generation === gate.controlLease.generation &&
      ['active', 'waiting'].includes(next.goal.status))
  )
    return;
  const wait = readBridgeWait(db, sessionId, gate.waitId);
  if (wait) writeBridgeWait(db, suppressGoalWait(wait, Date.now()));
}
