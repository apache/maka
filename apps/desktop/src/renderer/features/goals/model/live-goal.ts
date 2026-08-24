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

import type { GoalState, GoalStatus } from '@maka/core/goal';

type LiveGoalStatus = Extract<GoalStatus, 'active' | 'waiting'>;

export type LiveGoalState =
  | (GoalState & { readonly status: LiveGoalStatus })
  | (GoalState & { readonly status: 'paused'; readonly pausedAt: number });

const LIVE_GOAL_STATUSES: ReadonlySet<GoalStatus> = new Set([
  'active',
  'waiting',
  'paused',
]);

export function isLiveGoal(goal: GoalState): goal is LiveGoalState {
  return (
    LIVE_GOAL_STATUSES.has(goal.status) &&
    (goal.status !== 'paused' ||
      (typeof goal.pausedAt === 'number' && Number.isFinite(goal.pausedAt)))
  );
}
