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
import type { AnyEventWaitSnapshot } from '../event-wait-authority.js';
import type { RootTurnAdmission } from '../agent-run-store-contract.js';
import {
  admitNaturalGoalWaiting,
  retireNaturalGoalWaiting,
  type NaturalGoalWaitSnapshot,
} from '../event-wait-bridge.js';
import { rows, type MemoryState } from './memory-execution-state.js';
import type { SessionHeaderSnapshot } from '../session-store-contract.js';
export function assertMemoryBridgeSession(s: MemoryState, sessionId: string): void {
  const session = rows<SessionHeaderSnapshot>(s, 'headers').get(sessionId);
  if (!session || session.header.isArchived || rows(s, 'tombstones').has(sessionId))
    throw new Error('Event wait Session is unavailable');
}
export function writeMemoryBridge<T extends NaturalGoalWaitSnapshot>(
  s: MemoryState,
  snapshot: T,
): T {
  rows<AnyEventWaitSnapshot>(s, 'eventWaits').set(snapshot.wait.record.waitId, snapshot.wait);
  rows<GoalAuthoritySnapshot>(s, 'goals').set(snapshot.goal.record.goal.sessionId, snapshot.goal);
  return snapshot;
}
export function admitMemoryNaturalGoalWaiting(s: MemoryState, admission: RootTurnAdmission): void {
  if (admission.execution.kind === 'goal' && admission.execution.goalWaiting) {
    assertMemoryBridgeSession(s, admission.sessionId);
    const goal = rows<GoalAuthoritySnapshot>(s, 'goals').get(admission.sessionId) ?? null;
    const wait = rows<AnyEventWaitSnapshot>(s, 'eventWaits').get(
      admission.execution.goalWaiting.waitId,
    );
    if (!wait) throw new Error('Natural Goal wait missing at admission');
    writeMemoryBridge(s, admitNaturalGoalWaiting(admission, goal, wait));
    return;
  }
}
export function retirePreviousMemoryGoalWaiting(
  s: MemoryState,
  sessionId: string,
  next: GoalAuthorityRecord | null,
): void {
  const old = rows<GoalAuthoritySnapshot>(s, 'goals').get(sessionId)?.record;
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
    const waits = rows<AnyEventWaitSnapshot>(s, 'eventWaits');
    const wait = waits.get(observation.waitId);
    if (wait) waits.set(observation.waitId, retireNaturalGoalWaiting(wait, Date.now()));
  }
}
