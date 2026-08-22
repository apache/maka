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

import type { GoalState } from '@maka/core/goal';

export type GoalUnsubscribe = () => void;

export interface GoalArmInput {
  readonly condition: string;
  readonly maxIterations?: number | null;
  readonly tokenBudget?: number | null;
}

/** The minimum environment capability needed by the Goals feature. */
export interface GoalService {
  get(sessionId: string): Promise<GoalState | null>;
  arm(sessionId: string, goal: GoalArmInput): Promise<GoalState>;
  clear(sessionId: string): Promise<void>;
  pause(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<void>;
  /** Emits a Session id, or `undefined` for a broadcast Goal transition. */
  subscribeChanges(handler: (sessionId: string | undefined) => void): GoalUnsubscribe;
}

export interface GoalServices {
  goal: GoalService;
}
