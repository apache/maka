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

export interface CuE2eScenario {
  id: string;
  level: 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5';
  prompt: string;
  fixtureSetup: {
    layout: string;
    windows: Array<Record<string, unknown>>;
    transitions?: Array<Record<string, unknown>>;
    zOrder?: string[];
  };
  expectedState: Array<Record<string, unknown>>;
  forbiddenEffects: Array<Record<string, unknown>>;
  allowedActions: string[];
  contractChecks: string[];
  realRunEnabled: boolean;
  requiresExecutionCapabilities: string[];
  runner?: string;
  maxTotalActions?: number;
  minimumActionCounts?: Record<string, number>;
  maxActionCounts?: Record<string, number>;
  expectedActionSequence?: string[];
  expectedFailures?: Array<{
    action: string;
    error: string;
  }>;
}

export const CU_E2E_ACTIONS: readonly string[];
export const CU_E2E_SCENARIOS: readonly CuE2eScenario[];
export function getCuE2eScenario(id: string): CuE2eScenario;
export function validateCuE2eScenario(scenario: unknown): CuE2eScenario;
export function validateCuE2eScenarioLibrary(
  scenarios?: readonly CuE2eScenario[],
): readonly CuE2eScenario[];
export function evaluateCuE2eScenarioState(
  scenario: CuE2eScenario,
  stateByWindow: Record<string, unknown>,
): {
  pass: boolean;
  expected: Array<Record<string, unknown> & { actual: unknown; pass: boolean }>;
  forbidden: Array<Record<string, unknown> & { actual: unknown; pass: boolean }>;
};
