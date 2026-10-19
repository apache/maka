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

import type { GoalAuthorityRecord } from '@maka/core/goal';
import type { GoalAuthoritySnapshot } from '../goal-authority.js';
import type { EventWaitSnapshot } from '../event-wait-authority.js';
import type { RootTurnAdmission } from '../agent-run-store-contract.js';
import { admitGoalWait, suppressGoalWait, type GoalWaitSnapshot } from '../event-wait-bridge.js';
import { rows, type MemoryState } from './memory-execution-state.js';
import type { SessionHeaderSnapshot } from '../session-store-contract.js';
export function assertMemoryBridgeSession(s: MemoryState, sessionId: string): void {
  const session = rows<SessionHeaderSnapshot>(s, 'headers').get(sessionId);
  if (!session || session.header.isArchived || rows(s, 'tombstones').has(sessionId))
    throw new Error('Event wait Session is unavailable');
}
export function writeMemoryBridge(s: MemoryState, snapshot: GoalWaitSnapshot): GoalWaitSnapshot {
  rows<EventWaitSnapshot>(s, 'eventWaits').set(snapshot.wait.record.waitId, snapshot.wait);
  rows<GoalAuthoritySnapshot>(s, 'goals').set(snapshot.goal.record.goal.sessionId, snapshot.goal);
  return snapshot;
}
export function admitMemoryGoalWait(s: MemoryState, admission: RootTurnAdmission): void {
  if (admission.execution.kind !== 'goal' || !admission.execution.eventWait) return;
  assertMemoryBridgeSession(s, admission.sessionId);
  const goal = rows<GoalAuthoritySnapshot>(s, 'goals').get(admission.sessionId) ?? null;
  const wait = rows<EventWaitSnapshot>(s, 'eventWaits').get(admission.execution.eventWait.waitId);
  if (!wait) throw new Error('Event wait missing at admission');
  writeMemoryBridge(s, admitGoalWait(admission, goal, wait));
}
export function suppressPreviousMemoryWait(
  s: MemoryState,
  sessionId: string,
  next: GoalAuthorityRecord | null,
): void {
  const old = rows<GoalAuthoritySnapshot>(s, 'goals').get(sessionId)?.record;
  const gate = old?.activeEventWait;
  if (
    !gate ||
    (next?.activeEventWait?.waitId === gate.waitId &&
      next.controlLease.goalId === gate.controlLease.goalId &&
      next.controlLease.generation === gate.controlLease.generation &&
      ['active', 'waiting'].includes(next.goal.status))
  )
    return;
  const waits = rows<EventWaitSnapshot>(s, 'eventWaits'),
    wait = waits.get(gate.waitId);
  if (wait) waits.set(gate.waitId, suppressGoalWait(wait, Date.now()));
}
