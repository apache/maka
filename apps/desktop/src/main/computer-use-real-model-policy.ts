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

import type { ComputerUseToolSet } from '@maka/runtime/computer-use-tools';

import type { MakaTool } from '@maka/runtime/tool-runtime';

const ACTIONS_WITHOUT_OBSERVATION_OWNERSHIP = new Set([
  'list_apps',
  'wait',
  'cursor_position',
]);

export interface ComputerUseRealModelPolicy {
  allowedActions: readonly string[];
  maxTotalActions: number;
  maxActionCounts: Readonly<Record<string, number>>;
  allowedApps: readonly string[];
}

export function parseComputerUseRealModelPolicy(
  raw: string | undefined,
): ComputerUseRealModelPolicy {
  if (!raw) throw new Error('Missing Computer Use real-model policy');
  const value = JSON.parse(raw) as {
    allowedActions?: unknown;
    maxTotalActions?: unknown;
    maxActionCounts?: unknown;
    allowedApps?: unknown;
  };
  const allowedActions = Array.isArray(value.allowedActions)
    ? value.allowedActions
    : [];
  if (
    allowedActions.length === 0
    || allowedActions.some((action) =>
      typeof action !== 'string' || !action.trim())
    || new Set(allowedActions).size !== allowedActions.length
  ) {
    throw new Error('Invalid Computer Use real-model allowedActions');
  }
  if (
    !Number.isInteger(value.maxTotalActions)
    || (value.maxTotalActions as number) < 1
    || (value.maxTotalActions as number) > 100
  ) {
    throw new Error('Invalid Computer Use real-model maxTotalActions');
  }
  if (
    !value.maxActionCounts
    || typeof value.maxActionCounts !== 'object'
    || Array.isArray(value.maxActionCounts)
    || Object.entries(value.maxActionCounts).some(([action, count]) =>
      !allowedActions.includes(action)
      || !Number.isInteger(count)
      || (count as number) < 0)
  ) {
    throw new Error('Invalid Computer Use real-model maxActionCounts');
  }
  if (
    !Array.isArray(value.allowedApps)
    || value.allowedApps.length === 0
    || value.allowedApps.some((app) =>
      typeof app !== 'string' || !app.trim())
  ) {
    throw new Error('Invalid Computer Use real-model allowedApps');
  }
  return {
    allowedActions,
    maxTotalActions: value.maxTotalActions as number,
    maxActionCounts: value.maxActionCounts as Record<string, number>,
    allowedApps: value.allowedApps,
  };
}

export function applyComputerUseRealModelPolicy(
  tools: ComputerUseToolSet,
  policy: ComputerUseRealModelPolicy | undefined,
): ComputerUseToolSet {
  if (!policy) return tools;
  let totalActions = 0;
  const actionCounts = new Map<string, number>();
  const ownedObservations = new Set<string>();
  const allowed = new Set(policy.allowedActions);
  const allowedApps = new Set(policy.allowedApps);
  const wrapped = tools.map((tool) => {
    if (tool.name !== 'maka_computer') return tool;
    return {
      ...tool,
      impl: async (args, context) => {
        const action = typeof (args as { action?: unknown })?.action === 'string'
          ? (args as { action: string }).action
          : 'unknown';
        totalActions += 1;
        if (totalActions > policy.maxTotalActions) {
          return {
            text: 'maka_computer failed: total_action_budget_exceeded',
            error: 'total_action_budget_exceeded',
          };
        }
        if (!allowed.has(action)) {
          return {
            text: `maka_computer.${action} failed: unsupported_action_policy`,
            error: 'unsupported_action_policy',
          };
        }
        const app = (args as { app?: unknown })?.app;
        if (
          (action === 'observe' || action === 'screenshot')
          && (typeof app !== 'string' || !allowedApps.has(app))
        ) {
          return {
            text: `maka_computer.${action} failed: target_policy_mismatch`,
            error: 'target_policy_mismatch',
          };
        }
        const observationId = (args as {
          observation_id?: unknown;
        })?.observation_id;
        if (
          action !== 'observe'
          && action !== 'screenshot'
          && !ACTIONS_WITHOUT_OBSERVATION_OWNERSHIP.has(action)
          && (
            typeof observationId !== 'string'
            || !ownedObservations.has(observationId)
          )
        ) {
          return {
            text: `maka_computer.${action} failed: target_policy_mismatch`,
            error: 'target_policy_mismatch',
          };
        }
        const actionCount = (actionCounts.get(action) ?? 0) + 1;
        actionCounts.set(action, actionCount);
        if (actionCount > (policy.maxActionCounts[action] ?? 0)) {
          return {
            text: `maka_computer.${action} failed: action_budget_exceeded`,
            error: 'action_budget_exceeded',
          };
        }
        const result = await tool.impl(args as never, context);
        if (action === 'observe') {
          const text = (result as { text?: unknown })?.text;
          if (typeof text === 'string') {
            try {
              const parsed = JSON.parse(text) as {
                observation_id?: unknown;
              };
              if (typeof parsed.observation_id === 'string') {
                ownedObservations.add(parsed.observation_id);
              }
            } catch {
              // A failed/non-JSON observation never creates target ownership.
            }
          }
        }
        return result;
      },
    };
  }) as ComputerUseToolSet;
  wrapped.clearSession = (sessionId) => tools.clearSession(sessionId);
  wrapped.sessionEvents = tools.sessionEvents;
  return wrapped;
}
