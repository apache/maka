import { writeFile } from 'node:fs/promises';
import { toMetadata, toPricing } from './sync-model-metadata.mjs';

const SOURCE_URL = 'https://models.dev/api.json';
const OUTPUT = 'packages/core/src/bedrock-model-metadata.generated.ts';
const PRICING_OUTPUT = 'packages/runtime/src/telemetry/bedrock-pricing.generated.ts';

const catalog = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(10_000) }).then(
  (response) => {
    if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
    return response.json();
  },
);
const provider = catalog['amazon-bedrock'];
if (!provider?.models) throw new Error('models.dev Amazon Bedrock catalog is missing');
const metadata = Object.fromEntries(
  Object.entries(provider.models).map(([id, model]) => [
    id,
    toMetadata('amazon-bedrock', id, provider, model),
  ]),
);
const source = `// Generated from ${SOURCE_URL}; refresh with scripts/sync-bedrock-model-metadata.mjs.\nimport type { ModelMetadata } from './model-metadata.js';\n\nexport const BEDROCK_MODEL_METADATA: Readonly<Record<string, ModelMetadata>> = ${JSON.stringify(metadata, null, 2)};\n`;
await writeFile(OUTPUT, source);

const pricing = Object.entries(provider.models).flatMap(([id, model]) => {
  const entry = toPricing('amazon-bedrock', id, model);
  return entry ? [entry] : [];
});
await writeFile(
  PRICING_OUTPUT,
  `// Generated from ${SOURCE_URL}; refresh with scripts/sync-bedrock-model-metadata.mjs.\nimport type { PricingConfig } from '@maka/core/usage-stats/types';\n\nexport const BEDROCK_MODEL_PRICING: readonly PricingConfig[] = ${JSON.stringify(pricing, null, 2)};\n`,
);
