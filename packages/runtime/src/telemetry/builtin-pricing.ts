import { GENERATED_PRICING_CONFIGS } from '@maka/core/model-pricing';
import type { PricingConfig } from '@maka/core/usage-stats/types';

// Hand-maintained supplement over the models.dev sync, for keys the sync
// cannot price correctly: models absent upstream, and special access tiers
// (Coding Plan, Education, Volume Pricing) whose plan-equivalent rates differ
// from the metered rate models.dev carries. A supplement wins over the synced
// row for the same key; everything else comes from model-pricing.generated.ts.
const SUPPLEMENTAL_PRICING: readonly PricingConfig[] = [
  // Absent from models.dev.
  {
    modelKey: 'anthropic:claude-opus-4-1',
    inputUsdPer1M: 15,
    outputUsdPer1M: 75,
    cacheReadUsdPer1M: 1.5,
    cacheWriteUsdPer1M: 18.75,
  },
  {
    modelKey: 'anthropic:claude-haiku-4',
    inputUsdPer1M: 1,
    outputUsdPer1M: 5,
    cacheReadUsdPer1M: 0.1,
    cacheWriteUsdPer1M: 1.25,
  },
  { modelKey: 'moonshot:kimi-k2', inputUsdPer1M: 0.6, outputUsdPer1M: 2.5 },
  // Coding Plan tiers: models.dev prices subscription usage at zero; keep the
  // vendor's plan-equivalent rates so plan usage still values its tokens.
  { modelKey: 'zai-coding-plan:glm-4.7', inputUsdPer1M: 0.6, outputUsdPer1M: 2.2 },
  { modelKey: 'zai-coding-plan:glm-4.6', inputUsdPer1M: 0.6, outputUsdPer1M: 2.2 },
  { modelKey: 'zai-coding-plan:glm-4.5-air', inputUsdPer1M: 0.2, outputUsdPer1M: 0.8 },
];

const supplementalKeys = new Set(SUPPLEMENTAL_PRICING.map((pricing) => pricing.modelKey));

export const BUILTIN_PRICING: readonly PricingConfig[] = [
  ...GENERATED_PRICING_CONFIGS.filter((pricing) => !supplementalKeys.has(pricing.modelKey)),
  ...SUPPLEMENTAL_PRICING,
];

const byKey = new Map(BUILTIN_PRICING.map((pricing) => [pricing.modelKey, pricing]));

export function getBuiltinPricing(modelKey: string): PricingConfig | null {
  return byKey.get(modelKey) ?? null;
}
