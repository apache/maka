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

/** The system prompt and active tool subset one request actually dispatches. */
export interface DispatchRequestShape {
  systemPromptChars: number;
  activeTools: string[];
}

export interface RequestProjectionContext {
  completedSteps: readonly CompletedProviderStep[];
  stepNumber: number;
  model: unknown;
  messages: ModelMessage[];
  activeTools?: readonly string[];
  /**
   * Resolve what this step will really send, from a stage's projected active
   * tool set. Dispatch appends step-specific system prompt fragments and can
   * clear the tool set entirely on a finalization step, so a stage that
   * MEASURES the request must price this shape, not the pre-dispatch inputs —
   * otherwise a payload measure gets paired with a different request's tokens.
   */
  resolveDispatch: (activeTools: readonly string[] | undefined) => DispatchRequestShape;
}

export interface RequestProjection {
  activeTools?: string[];
  messages?: ModelMessage[];
}

export type RequestProjectionStage = (
  context: RequestProjectionContext,
) => RequestProjection | undefined | PromiseLike<RequestProjection | undefined>;

export function composeRequestProjection(
  ...stages: Array<RequestProjectionStage | undefined>
): RequestProjectionStage | undefined {
  const hooks = stages.filter((stage): stage is RequestProjectionStage => stage !== undefined);
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
