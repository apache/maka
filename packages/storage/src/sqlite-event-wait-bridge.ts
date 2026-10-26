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
import { decodeAnyEventWaitRecord } from '@maka/core/event-wait';
import type { GoalAuthoritySnapshot } from './goal-authority.js';
import type { AnyEventWaitSnapshot } from './event-wait-authority.js';
import { retireNaturalGoalWaiting, type NaturalGoalWaitSnapshot } from './event-wait-bridge.js';

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
export function readAnyBridgeWait(
  db: DatabaseSync,
  sessionId: string,
  waitId: string,
): AnyEventWaitSnapshot | null {
  const row = db.prepare('SELECT * FROM workflow_event_waits WHERE wait_id = ?').get(waitId);
  if (!row) return null;
  const record = decodeAnyEventWaitRecord(JSON.parse(String(row.record_json)));
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
export function writeBridgeWait(db: DatabaseSync, wait: AnyEventWaitSnapshot): void {
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
export function writeBridgeSnapshot<T extends NaturalGoalWaitSnapshot>(
  db: DatabaseSync,
  snapshot: T,
): T {
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
export function retirePreviousSqliteGoalWaiting(
  db: DatabaseSync,
  sessionId: string,
  next: import('@maka/core/goal').GoalAuthorityRecord | null,
): void {
  const old = readBridgeGoal(db, sessionId)?.record;
  const observation = old?.pendingContinuation?.observation;
  if (
    observation &&
    !(
      next?.pendingContinuation?.observation?.waitId === observation.waitId &&
      next.controlLease.goalId === old.controlLease.goalId &&
      next.controlLease.generation === old.controlLease.generation &&
      ['active', 'waiting'].includes(next.goal.status)
    )
  ) {
    const wait = readAnyBridgeWait(db, sessionId, observation.waitId);
    if (wait) writeBridgeWait(db, retireNaturalGoalWaiting(wait, Date.now()));
  }
}
