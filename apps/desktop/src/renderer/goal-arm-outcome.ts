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

import type { GoalState } from '@maka/runtime/goal-state';
import type { GoalArmOutcome } from '../shared/goal-arm.js';

export type GoalArmReconciliationNotice =
  | { readonly kind: 'matching_goal'; readonly goal: GoalState }
  | { readonly kind: 'different_goal'; readonly goal: GoalState }
  | { readonly kind: 'no_goal' }
  | { readonly kind: 'unavailable' };

export type GoalArmOutcomeAction =
  | { readonly action: 'close' }
  | { readonly action: 'lock'; readonly notice: GoalArmReconciliationNotice };

export function interpretGoalArmOutcome(
  outcome: GoalArmOutcome,
): GoalArmOutcomeAction {
  if (outcome.kind === 'armed') return { action: 'close' };
  if (outcome.kind === 'reconciliation_unavailable') {
    return { action: 'lock', notice: { kind: 'unavailable' } };
  }
  if (outcome.currentGoal === null) {
    return { action: 'lock', notice: { kind: 'no_goal' } };
  }
  return {
    action: 'lock',
    notice: {
      kind: outcome.matchesRequestedState ? 'matching_goal' : 'different_goal',
      goal: outcome.currentGoal,
    },
  };
}
