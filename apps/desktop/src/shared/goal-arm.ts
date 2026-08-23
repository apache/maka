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

/**
 * What the renderer sends to arm a Goal.
 *
 * The Session is not here: it travels as the scoped IPC argument, so a
 * renderer-side Session id can never redirect the operation. Preload declares
 * this shape and the IPC validator refuses anything outside it, so both read
 * the one declaration instead of each keeping its own copy.
 */
export interface GoalArmRequest {
  readonly condition: string;
  readonly maxIterations?: number | null;
  readonly tokenBudget?: number | null;
}

export const GOAL_ARM_REQUEST_KEYS: readonly (keyof GoalArmRequest)[] = Object.freeze([
  'condition',
  'maxIterations',
  'tokenBudget',
]);
