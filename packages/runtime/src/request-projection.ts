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

import type { ModelMessage, NormalizedUsage, ToolCallPart } from './model-protocol.js';

export interface CompletedProviderStep {
  toolCalls?: readonly ToolCallPart[];
  usage?: NormalizedUsage;
}

export interface RequestProjectionContext {
  completedSteps: readonly CompletedProviderStep[];
  stepNumber: number;
  model: unknown;
  messages: ModelMessage[];
  activeTools?: readonly string[];
}

export interface RequestProjection {
  activeTools?: string[];
  messages?: ModelMessage[];
}

export type RequestProjectionStage = (
  context: RequestProjectionContext,
) => RequestProjection | undefined | PromiseLike<RequestProjection | undefined>;

/**
 * Deterministic request-projection pipeline over ONE provider-visible request.
 * Order is a contract: mid-turn capacity compaction runs first among the
 * message-shaping hooks so every later mechanism operates on (and re-converges
 * onto) its projection — active tool-result pruning re-archives large tool
 * results in the rebuilt tail, and semantic compaction sees the
 * already-compacted messages. On a step where the capacity hook replaced the
 * request, semantic compaction yields (see AiSdkBackend.send) so
 * two summarizers never run for one step.
 *
 * Every hook here only SHAPES the projection. The pass/terminate capacity
 * verdict is issued once, after the whole pipeline, by the final-request
 * estimate owner (buildMidTurnFinalRequestVerdict) over the actual outgoing
 * (messages, tools) payload — never by an individual hook over an intermediate
 * projection that a later hook could still rescue.
 */
export function composeRequestProjection(
  toolAvailability: RequestProjectionStage | undefined,
  midTurnCapacityCompact: RequestProjectionStage | undefined,
  activeToolResultPrune: RequestProjectionStage | undefined,
  activeCompaction?: RequestProjectionStage | undefined,
): RequestProjectionStage | undefined {
  const hooks = [
    toolAvailability,
    midTurnCapacityCompact,
    activeToolResultPrune,
    activeCompaction,
  ].filter(Boolean) as RequestProjectionStage[];
  if (hooks.length === 0) return undefined;
  return async (context: RequestProjectionContext): Promise<RequestProjection | undefined> => {
    let result: RequestProjection | undefined;
    let messages = context.messages;
    for (const hook of hooks) {
      const hookOptions = {
        ...context,
        messages,
        ...(result?.activeTools ? { activeTools: result.activeTools } : {}),
      } as RequestProjectionContext;
      const hookResult = await Promise.resolve(hook(hookOptions));
      if (!hookResult) continue;
      result = {
        ...(result ?? {}),
        ...hookResult,
        activeTools: hookResult.activeTools ?? result?.activeTools,
      };
      if (hookResult.messages) messages = hookResult.messages;
    }
    return result;
  };
}
