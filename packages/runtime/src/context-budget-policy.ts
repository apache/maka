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
import { lookupModelMetadata } from '@maka/core/model-metadata';
import { relayModelProfile } from '@maka/core/model-thinking';
import type { ContextBudgetPolicy } from './context-budget.js';
import { finitePositive } from './context-budget-helpers.js';

export interface BuildDefaultContextBudgetPolicyOptions {
  name?: string;
  modelId?: string;
}

export function buildDefaultContextBudgetPolicy(
  connection: RuntimeExecutionConnection,
  options: BuildDefaultContextBudgetPolicyOptions = {},
): ContextBudgetPolicy {
  const contextWindow = resolveSelectedModelContextWindow(connection, options.modelId);
  const reserveTokens = defaultCompactReserveTokens(contextWindow);
  const maxHistoryEstimatedTokens = defaultHistoryBudgetTokens(
    connection,
    contextWindow,
    reserveTokens,
  );
  const surfaceName = (options.name ?? 'default-history-budget').replace(
    /-default-history-budget$/,
    '',
  );
  return {
    name: options.name ?? 'default-history-budget',
    ...(maxHistoryEstimatedTokens !== undefined ? { maxHistoryEstimatedTokens } : {}),
    staleToolResultPrune: {
      enabled: true,
      maxResultEstimatedTokens: 2_048,
      minRecentTurnsFull: 2,
    },
    historyCompact: {
      enabled: true,
      highWaterName: `${surfaceName}-history-compact`,
      midTurn: { enabled: true, reserveTokens },
    },
    activeToolResultPrune: {
      enabled: true,
      maxCurrentResultEstimatedTokens: 2_048,
      minSupersededResultEstimatedTokens: 256,
      minStepNumber: 1,
    },
  };
}

// Single owner of the compaction reserve default. The classic 16384 reserve
// assumed large-window models; on an 8K window it derived a 1-token history
// budget and a 1-token mid_turn high water — every multi-step turn ran the
// summarizer for a checkpoint the replay gate could never admit. The default
// is therefore bounded by the KNOWN window (a quarter of it, capped at 16384;
// peers bound the same way: opencode caps its buffer by the model's output
// limit, gemini-cli triggers at a window fraction). An unknown window keeps
// the classic constant.
function defaultCompactReserveTokens(contextWindow: number | undefined): number {
  if (contextWindow === undefined) return 16_384;
  return Math.min(16_384, Math.max(1, Math.floor(contextWindow / 4)));
}

function defaultHistoryBudgetTokens(
  connection: RuntimeExecutionConnection,
  contextWindow: number | undefined,
  reserveTokens: number,
): number | undefined {
  if (contextWindow !== undefined) {
    return Math.max(1, contextWindow - reserveTokens);
  }
  if (connection.providerType === 'deepseek') return undefined;
  return 32_000;
}

export function resolveSelectedModelContextWindow(
  connection: RuntimeExecutionConnection,
  modelId: string | undefined,
): number | undefined {
  const selectedModelId = modelId ?? connection.defaultModel;
  if (selectedModelId === undefined) return undefined;
  const model = connection.models?.find((candidate) => candidate.id === selectedModelId);
  // A model-facts pin is the cross-provider correction authority. It must win
  // over the older relay-only declaration so catalog display and execution use
  // the same window. Relay declarations retain their existing precedence when
  // there is no facts pin for this field.
  if (model?.factOverriddenFields?.includes('contextWindow')) {
    return narrowestPositiveLimit(model.contextWindow, model.inputLimit);
  }
  // A user declaration outranks both the provider's /models report and
  // generated metadata — mirrors the declared-vision precedence in
  // model-metadata.ts. A declared context window is legal on any provider: it
  // states a fact about the model, not a request shape (#1584).
  const declared = relayModelProfile(connection, selectedModelId)?.contextWindow;
  if (declared !== undefined) return declared;
  const metadata = lookupModelMetadata(connection.providerType, selectedModelId);
  // Provider/access-path facts outrank static metadata. Within one source,
  // use the narrowest positive bound: models.dev's input limit can be lower
  // than its total context window, while an access path can expose a narrower
  // context window than the public catalog.
  const modelLimit = narrowestPositiveLimit(model?.contextWindow, model?.inputLimit);
  const metadataLimit = narrowestPositiveLimit(metadata.contextWindow, metadata.inputLimit);
  return modelLimit ?? metadataLimit;
}

function narrowestPositiveLimit(...values: Array<number | undefined>): number | undefined {
  const positiveValues = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0,
  );
  return positiveValues.length > 0 ? Math.min(...positiveValues) : undefined;
}

export interface ContextBudgetCapacity {
  tokens: number;
  source: 'selected_model' | 'policy_fallback';
}

export function resolveContextBudgetCapacity(
  connection: RuntimeExecutionConnection,
  modelId: string | undefined,
  policy: ContextBudgetPolicy | undefined,
): ContextBudgetCapacity | undefined {
  const selectedWindow = resolveSelectedModelContextWindow(connection, modelId);
  if (selectedWindow !== undefined) {
    return { tokens: selectedWindow, source: 'selected_model' };
  }

  const historyBudget = finitePositive(policy?.maxHistoryEstimatedTokens);
  const reserveTokens = finitePositive(policy?.historyCompact?.midTurn?.reserveTokens);
  if (historyBudget === undefined || reserveTokens === undefined) return undefined;
  return { tokens: historyBudget + reserveTokens, source: 'policy_fallback' };
}
