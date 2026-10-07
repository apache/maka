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

export const DEFAULT_COMPACTION_THRESHOLD_RATIO = 0.65;

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
    toolResultPrune: { enabled: true },
    historyCompact: {
      enabled: true,
      highWaterName: `${surfaceName}-history-compact`,
      midTurn: { enabled: true },
    },
  };
}

/**
 * The proactive compaction target for the selected model. An explicit positive
 * declaration wins, zero disables the default, and an absent declaration uses
 * a bounded fraction of the effective model input window.
 */
export function resolveDeclaredContextWindow(
  connection: RuntimeExecutionConnection,
  modelId: string | undefined,
): number | undefined {
  const selectedModelId = modelId ?? connection.defaultModel;
  if (selectedModelId === undefined) return undefined;
  const declared = declaredContextWindow(connection, selectedModelId);
  if (declared === 0) return undefined;
  if (declared !== undefined) return declared;
  const capacity = resolveSelectedModelContextWindow(connection, selectedModelId);
  return capacity === undefined
    ? undefined
    : Math.max(1, Math.floor(capacity * DEFAULT_COMPACTION_THRESHOLD_RATIO));
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
