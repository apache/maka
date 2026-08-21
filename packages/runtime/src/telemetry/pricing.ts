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
import { pricingModelKey } from '@maka/core/usage-stats/pricing';
import type { PricingConfig } from '@maka/core/usage-stats/types';
import { getBuiltinPricing } from './builtin-pricing.js';

export function buildPricingLookup(
  overrides: readonly PricingConfig[] = [],
): (modelKey: string) => PricingConfig | null {
  const overrideMap = new Map(overrides.map((pricing) => [pricing.modelKey, pricing]));
  return (modelKey) => overrideMap.get(modelKey) ?? getBuiltinPricing(modelKey);
}

/**
 * Inference profiles are invoked by profile id but, when they resolve to one
 * unambiguous foundation model, use that model's public Bedrock rate. Profiles
 * spanning different source ids remain deliberately unpriced.
 */
export function withBedrockSourcePricing(
  lookup: (modelKey: string) => PricingConfig | null,
  connection: RuntimeExecutionConnection,
  modelId: string,
): (modelKey: string) => PricingConfig | null {
  const sources = connection.models?.find((model) => model.id === modelId)?.bedrock?.sourceModelIds;
  if (connection.providerType !== 'amazon-bedrock' || sources?.length !== 1) return lookup;
  const sourceKey = pricingModelKey('amazon-bedrock', sources[0]!);
  return (modelKey) => lookup(modelKey) ?? lookup(sourceKey);
}
