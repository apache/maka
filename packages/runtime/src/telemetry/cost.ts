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

import type { PricingConfig } from '@maka/core/usage-stats/types';

export interface CostInput {
  inputTokens: number;
  outputTokens: number;
  cacheHitInputTokens?: number;
  cacheMissInputTokens?: number;
  /** Backward-compatible alias for cacheHitInputTokens. */
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
}

export function computeCost(usage: CostInput, pricing: PricingConfig | null): CostBreakdown {
  if (!pricing) {
    return { inputCost: 0, outputCost: 0, cacheReadCost: 0, cacheWriteCost: 0, totalCost: 0 };
  }
  const cacheHitInputTokens = usage.cacheHitInputTokens ?? usage.cachedInputTokens ?? 0;
  const cacheWriteInputTokens = usage.cacheWriteInputTokens ?? 0;
  const cacheMissInputTokens =
    usage.cacheMissInputTokens ??
    Math.max(0, usage.inputTokens - cacheHitInputTokens - cacheWriteInputTokens);
  const inputCost = (cacheMissInputTokens / 1_000_000) * pricing.inputUsdPer1M;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.outputUsdPer1M;
  const cacheReadCost =
    pricing.cacheReadUsdPer1M && cacheHitInputTokens
      ? (cacheHitInputTokens / 1_000_000) * pricing.cacheReadUsdPer1M
      : 0;
  const cacheWriteCost =
    pricing.cacheWriteUsdPer1M && cacheWriteInputTokens
      ? (cacheWriteInputTokens / 1_000_000) * pricing.cacheWriteUsdPer1M
      : 0;
  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
  };
}
