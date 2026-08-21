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
