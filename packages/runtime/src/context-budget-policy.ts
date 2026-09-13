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

import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import {
  declaredContextWindow,
  modelOverride,
  resolveModelLimits,
  modelLimitsConflict,
} from '@maka/core/model-thinking';
import type { ContextBudgetPolicy } from './context-budget.js';

export interface BuildDefaultContextBudgetPolicyOptions {
  name?: string;
  modelId?: string;
}

/**
 * The shipped context-budget policy. It carries no history budget and no
 * reserve: whether a request fits is the provider's answer, and the only
 * proactive threshold is the context window the user declared for the model
 * (see `resolveDeclaredContextWindow`), read by the compaction seam itself.
 * What remains here are content policies — how one oversized Tool Result
 * enters the request — and the compaction switches (#4559).
 */
export function buildDefaultContextBudgetPolicy(
  options: BuildDefaultContextBudgetPolicyOptions = {},
): ContextBudgetPolicy {
  const surfaceName = (options.name ?? 'default-history-budget').replace(
    /-default-history-budget$/,
    '',
  );
  return {
    name: options.name ?? 'default-history-budget',
    staleToolResultPrune: {
      enabled: true,
      maxResultEstimatedTokens: 2_048,
      minRecentTurnsFull: 2,
    },
    historyCompact: {
      enabled: true,
      highWaterName: `${surfaceName}-history-compact`,
      midTurn: { enabled: true },
    },
    activeToolResultPrune: {
      enabled: true,
      maxCurrentResultEstimatedTokens: 2_048,
      minSupersededResultEstimatedTokens: 256,
      minStepNumber: 1,
    },
  };
}

/**
 * The Maka window for the selected model: the context window the user declared,
 * resolved by core's single owner of that rule (`declaredContextWindow`), or
 * undefined when nothing is declared — and then no proactive compaction runs.
 */
export function resolveDeclaredContextWindow(
  connection: RuntimeExecutionConnection,
  modelId: string | undefined,
): number | undefined {
  const selectedModelId = modelId ?? connection.defaultModel;
  if (selectedModelId === undefined) return undefined;
  return declaredContextWindow(connection, selectedModelId);
}

export function resolveSelectedModelContextWindow(
  connection: RuntimeExecutionConnection,
  modelId: string | undefined,
): number | undefined {
  const selectedModelId = modelId ?? connection.defaultModel;
  if (selectedModelId === undefined) return undefined;
  const model = connection.models?.find((candidate) => candidate.id === selectedModelId);
  // Resolve each fact independently before deriving the input budget.
  const limits = resolveModelLimits(
    connection.providerType,
    model ?? { id: selectedModelId },
    connection.modelOverrides?.[selectedModelId],
  );
  if (modelLimitsConflict(limits))
    throw new Error('Model input limit exceeds the context window. Update the model limits.');
  return narrowestPositiveLimit(limits.contextWindow, limits.inputLimit);
}

function narrowestPositiveLimit(...values: Array<number | undefined>): number | undefined {
  const positiveValues = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
  );
  return positiveValues.length > 0 ? Math.min(...positiveValues) : undefined;
}
