import { GENERATED_MODELS_DEV_PRICING } from './model-pricing.generated.js';
import type { PricingConfig } from './usage-stats/types.js';

/**
 * models.dev base rates flattened onto the runtime pricing key space
 * (`providerType:modelId`). Special access tiers and models absent upstream
 * live in the runtime's supplement layer (telemetry/builtin-pricing.ts).
 */
export const GENERATED_PRICING_CONFIGS: readonly PricingConfig[] = Object.entries(
  GENERATED_MODELS_DEV_PRICING,
).flatMap(([providerType, models]) =>
  Object.entries(models).map(([modelId, rates]) => ({
    modelKey: `${providerType}:${modelId}`,
    ...rates,
  })),
);
