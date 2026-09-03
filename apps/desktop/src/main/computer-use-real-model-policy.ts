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

import type {
  ComputerUsePreparationContext,
  ComputerUseToolSet,
  PreparedComputerUseInvocation,
  PreparedComputerUsePolicyBinding,
} from '@maka/runtime/computer-use-tools';
import { normalizeCuProcessGeneration } from '@maka/runtime/computer-use-tools';

import type { MakaTool } from '@maka/runtime/tool-runtime';

export interface ComputerUseRealModelPolicy {
  allowedActions: readonly string[];
  maxTotalActions: number;
  maxActionCounts: Readonly<Record<string, number>>;
  allowedTargets: readonly {
    readonly pid: number;
    readonly processGeneration: string;
    readonly windowIds?: readonly number[];
  }[];
}

export function parseComputerUseRealModelPolicy(
  raw: string | undefined,
): ComputerUseRealModelPolicy {
  if (!raw) throw new Error('Missing Computer Use real-model policy');
  const value = JSON.parse(raw) as {
    allowedActions?: unknown;
    maxTotalActions?: unknown;
    maxActionCounts?: unknown;
    allowedTargets?: unknown;
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
    !Array.isArray(value.allowedTargets)
    || value.allowedTargets.length === 0
    || value.allowedTargets.some((target) => {
      if (!target || typeof target !== 'object' || Array.isArray(target)) return true;
      const record = target as Record<string, unknown>;
      return !Number.isSafeInteger(record.pid)
        || (record.pid as number) <= 0
        || (() => {
          try {
            normalizeCuProcessGeneration(record.processGeneration);
            return false;
          } catch {
            return true;
          }
        })()
        || (record.windowIds !== undefined
          && (!Array.isArray(record.windowIds)
            || record.windowIds.some((windowId) =>
              !Number.isSafeInteger(windowId) || (windowId as number) <= 0)));
    })
  ) {
    throw new Error('Invalid Computer Use real-model allowedTargets');
  }
  return {
    allowedActions,
    maxTotalActions: value.maxTotalActions as number,
    maxActionCounts: value.maxActionCounts as Record<string, number>,
    allowedTargets: value.allowedTargets as ComputerUseRealModelPolicy['allowedTargets'],
  };
}

export function applyComputerUseRealModelPolicy(
  tools: ComputerUseToolSet,
  policy: ComputerUseRealModelPolicy | undefined,
): ComputerUseToolSet {
  if (!policy) return tools;
  const activePolicy = policy;
  let totalActions = 0;
  const actionCounts = new Map<string, number>();
  const ownedObservations = new Set<string>();
  const allowed = new Set(activePolicy.allowedActions);
  function policyFailure(action: string, error: string): Error {
    return new Error(`maka_computer.${action} failed: ${error}`);
  }
  function targetAllowed(binding: PreparedComputerUsePolicyBinding): boolean {
    if (binding.target.kind === 'app_catalog' || binding.target.kind === 'targetless') return true;
    if (binding.target.kind === 'unresolved') return false;
    if (binding.target.kind === 'observation') {
      if (!ownedObservations.has(binding.target.binding.frameId)) return false;
      return runningTargetAllowed(binding.target.binding.target.selector);
    }
    if (binding.target.resolved.kind !== 'running') return false;
    return runningTargetAllowed(binding.target.resolved.selector);
  }
  function runningTargetAllowed(selector: {
    readonly pid: number;
    readonly processGeneration: string;
    readonly windowId: number;
  }): boolean {
    return activePolicy.allowedTargets.some((target) =>
      target.pid === selector.pid
      && target.processGeneration === selector.processGeneration
      && (target.windowIds === undefined || target.windowIds.includes(selector.windowId)));
  }
  async function prepareInvocation(
    args: unknown,
    context: ComputerUsePreparationContext,
  ): Promise<PreparedComputerUseInvocation> {
    const prepared = await tools.prepareInvocation(args, context);
    const action = prepared.policyBinding.action;
    if (!allowed.has(action)) throw policyFailure(action, 'unsupported_action_policy');
    if (!targetAllowed(prepared.policyBinding)) {
      throw policyFailure(action, 'target_policy_mismatch');
    }
    let consumed = false;
    return Object.freeze({
      ...prepared,
      execute: async (...executeArgs: Parameters<PreparedComputerUseInvocation['execute']>) => {
        if (consumed) throw new Error('Computer Use policy invocation was already consumed');
        consumed = true;
        totalActions += 1;
        if (totalActions > activePolicy.maxTotalActions) {
          throw policyFailure(action, 'total_action_budget_exceeded');
        }
        const actionCount = (actionCounts.get(action) ?? 0) + 1;
        actionCounts.set(action, actionCount);
        if (actionCount > (activePolicy.maxActionCounts[action] ?? 0)) {
          throw policyFailure(action, 'action_budget_exceeded');
        }
        const result = await prepared.execute(...executeArgs);
        if (result.metadata.freshObservation) {
          ownedObservations.add(result.metadata.freshObservation.frameId);
        }
        return result;
      },
    });
  }
  const wrapped = tools.map((tool) =>
    tool.name !== 'maka_computer'
      ? tool
      : {
          ...tool,
          impl: async (args, context) => {
            try {
              const prepared = await prepareInvocation(args, {
                sessionId: context.sessionId,
                turnId: context.turnId,
                toolCallId: context.toolCallId,
                signal: context.abortSignal,
              });
              return (await prepared.execute(context)).result;
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              return { text: message, error: message.split(': ').at(-1) ?? 'policy_error' };
            }
          },
        }) as ComputerUseToolSet;
  wrapped.prepareInvocation = prepareInvocation;
  wrapped.clearSession = (sessionId) => tools.clearSession(sessionId);
  wrapped.sessionEvents = tools.sessionEvents;
  return wrapped;
}
