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
import { GENERATED_MODEL_PRICING } from './model-pricing.generated.js';

// Access-path-specific pricing that models.dev cannot represent. The generated
// table is authoritative for ordinary overlapping keys; these rows only fill
// gaps or preserve special plans whose provider price is not a public base
// rate. User pricing overrides still win in buildPricingLookup().
const LOCAL_PRICING_SUPPLEMENT: readonly PricingConfig[] = [
  {
    modelKey: 'anthropic:claude-opus-4-1',
    inputUsdPer1M: 15,
    outputUsdPer1M: 75,
    cacheReadUsdPer1M: 1.5,
    cacheWriteUsdPer1M: 18.75,
  },
  {
    modelKey: 'anthropic:claude-sonnet-4-5',
    inputUsdPer1M: 3,
    outputUsdPer1M: 15,
    cacheReadUsdPer1M: 0.3,
    cacheWriteUsdPer1M: 3.75,
  },
  {
    modelKey: 'anthropic:claude-haiku-4',
    inputUsdPer1M: 1,
    outputUsdPer1M: 5,
    cacheReadUsdPer1M: 0.1,
    cacheWriteUsdPer1M: 1.25,
  },
  { modelKey: 'openai:gpt-4o', inputUsdPer1M: 2.5, outputUsdPer1M: 10, cacheReadUsdPer1M: 1.25 },
  {
    modelKey: 'openai:gpt-4o-mini',
    inputUsdPer1M: 0.15,
    outputUsdPer1M: 0.6,
    cacheReadUsdPer1M: 0.075,
  },
  { modelKey: 'openai:o1', inputUsdPer1M: 15, outputUsdPer1M: 60, cacheReadUsdPer1M: 7.5 },
  { modelKey: 'google:gemini-2.5-flash', inputUsdPer1M: 0.3, outputUsdPer1M: 2.5 },
  {
    modelKey: 'deepseek:deepseek-chat',
    inputUsdPer1M: 0.27,
    outputUsdPer1M: 1.1,
    cacheReadUsdPer1M: 0.07,
  },
  {
    modelKey: 'deepseek:deepseek-reasoner',
    inputUsdPer1M: 0.55,
    outputUsdPer1M: 2.19,
    cacheReadUsdPer1M: 0.14,
  },
  { modelKey: 'moonshot:kimi-k2', inputUsdPer1M: 0.6, outputUsdPer1M: 2.5 },
  { modelKey: 'zai-coding-plan:glm-4.7', inputUsdPer1M: 0.6, outputUsdPer1M: 2.2 },
  { modelKey: 'zai-coding-plan:glm-4.6', inputUsdPer1M: 0.6, outputUsdPer1M: 2.2 },
  { modelKey: 'zai-coding-plan:glm-4.5-air', inputUsdPer1M: 0.2, outputUsdPer1M: 0.8 },
  {
    modelKey: 'MiniMax-cn:MiniMax-M3',
    inputUsdPer1M: 0.3,
    outputUsdPer1M: 1.2,
    cacheReadUsdPer1M: 0.06,
  },
];

const generatedPricingKeys = new Set(GENERATED_MODEL_PRICING.map(({ modelKey }) => modelKey));

export const BUILTIN_PRICING: readonly PricingConfig[] = [
  ...GENERATED_MODEL_PRICING,
  ...LOCAL_PRICING_SUPPLEMENT.filter(({ modelKey }) => !generatedPricingKeys.has(modelKey)),
];

const byKey = new Map(BUILTIN_PRICING.map((pricing) => [pricing.modelKey, pricing]));

export function getBuiltinPricing(modelKey: string): PricingConfig | null {
  return byKey.get(modelKey) ?? null;
}
