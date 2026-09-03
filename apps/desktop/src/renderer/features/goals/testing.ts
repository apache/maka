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

import type { GoalServices } from './ports.js';

export { GoalServicesProvider } from './services-context.js';
export { GoalDialog } from './ui/goal-dialog.js';
export { GoalProvider } from './ui/goal-provider.js';
export { readGoalBudget } from './model/goal-budget.js';
export { isLiveGoal } from './model/live-goal.js';
export { interpretGoalArmOutcome } from './model/goal-arm-outcome.js';
export {
  useGoalController,
  type GoalController,
  type UseGoalControllerInput,
} from './controller/use-goal-controller.js';
export type { GoalServices } from './ports.js';

const noopSubscription = (): (() => void) => () => undefined;

export function createFakeGoalServices(
  overrides: Partial<GoalServices> = {},
): GoalServices {
  return {
    goal: {
      get: async () => null,
      arm: async () => {
        throw new Error('Fake goal.arm is not configured');
      },
      clear: async () => undefined,
      pause: async () => undefined,
      resume: async () => undefined,
      subscribeChanges: noopSubscription,
    },
    ...overrides,
  };
}
