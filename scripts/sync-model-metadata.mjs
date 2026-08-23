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

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const SOURCE_URL = 'https://models.dev/api.json';
const DEFAULT_OUTPUT = 'packages/core/src/model-metadata.generated.ts';
const DEFAULT_PRICING_OUTPUT = 'packages/runtime/src/telemetry/model-pricing.generated.ts';
// models.dev cost fields describe the catalog provider's public API. They are
// not automatically the rate a user pays on an OAuth, free, subscription, or
// plan access path. Such paths stay unpriced unless builtin-pricing.ts carries
// an explicit rate for that exact path.
export const PRICING_EXCLUDED_PROVIDER_TYPES = new Set([
  'alibaba-coding-plan-cn',
  'alibaba-coding-plan',
  'alibaba-token-plan-cn',
  'alibaba-token-plan',
  'github-copilot',
  'kimi-coding-plan',
  'minimax-coding-plan',
  'MiniMax-cn',
  'opencode-free',
  'opencode-go',
  'stepfun-ai-step-plan',
  'stepfun-step-plan',
  'tencent-coding-plan',
  'tencent-token-plan',
  'volcengine-agent-plan',
  'volcengine-coding-plan',
  'xiaomi-token-plan-ams',
  'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp',
  'zai-coding-plan',
]);
export const PROVIDERS = {
  anthropic: 'anthropic',
  alibaba: 'alibaba',
  'alibaba-coding-plan-cn': 'alibaba-coding-plan-cn',
  'alibaba-coding-plan': 'alibaba-coding-plan',
  'alibaba-token-plan-cn': 'alibaba-token-plan-cn',
  'alibaba-token-plan': 'alibaba-token-plan',
  cerebras: 'cerebras',
  cohere: 'cohere',
  'cloudflare-workers-ai': 'cloudflare-workers-ai',
  deepinfra: 'deepinfra',
  deepseek: 'deepseek',
  'fireworks-ai': 'fireworks-ai',
  'github-copilot': 'github-copilot',
  google: 'google',
  groq: 'groq',
  huggingface: 'huggingface',
  'kimi-coding-plan': 'kimi-for-coding',
  MiniMax: 'minimax',
  'MiniMax-cn': 'minimax-cn',
  'minimax-coding-plan': 'minimax-coding-plan',
  mistral: 'mistral',
  moonshot: 'moonshotai-cn',
  nvidia: 'nvidia',
  'ollama-cloud': 'ollama-cloud',
  openai: 'openai',
  opencode: 'opencode',
  'opencode-go': 'opencode-go',
  openrouter: 'openrouter',
  siliconflow: 'siliconflow',
  stepfun: 'stepfun',
  'stepfun-ai': 'stepfun-ai',
  'stepfun-ai-step-plan': 'stepfun-ai-step-plan',
  'stepfun-step-plan': 'stepfun-step-plan',
  togetherai: 'togetherai',
  'tencent-coding-plan': 'tencent-coding-plan',
  'tencent-token-plan': 'tencent-token-plan',
  'tencent-tokenhub': 'tencent-tokenhub',
  vercel: 'vercel',
  xai: 'xai',
  xiaomi: 'xiaomi',
  'xiaomi-token-plan-cn': 'xiaomi-token-plan-cn',
  'xiaomi-token-plan-sgp': 'xiaomi-token-plan-sgp',
  'xiaomi-token-plan-ams': 'xiaomi-token-plan-ams',
  zai: 'zai',
  'zai-coding-plan': 'zai-coding-plan',
  zenmux: 'zenmux',
};

export async function main(argv = process.argv) {
  const inputPath = option('--input', argv);
  const outputPath = option('--output', argv) ?? DEFAULT_OUTPUT;
  const pricingOutputPath =
    option('--pricing-output', argv) ??
    (outputPath === DEFAULT_OUTPUT ? DEFAULT_PRICING_OUTPUT : undefined);
  const sourceText = inputPath
    ? await readFile(inputPath, 'utf8')
    : await fetch(SOURCE_URL, { signal: AbortSignal.timeout(10_000) }).then((response) => {
        if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
        return response.text();
      });
  const catalog = JSON.parse(sourceText);

  const generated = {};
  const generatedPricing = [];
  const generatedProviders = {};
  const generatedModelProviderOverrides = {};
  for (const [providerType, sourceId] of Object.entries(PROVIDERS)) {
    const provider = catalog[sourceId];
    if (!provider) {
      throw new Error(`models.dev provider ${sourceId} is missing`);
    }
    if (!provider.models || typeof provider.models !== 'object') {
      throw new Error(`models.dev provider ${sourceId} has no models object`);
    }
    if (
      typeof provider.id !== 'string' ||
      typeof provider.name !== 'string' ||
      typeof provider.doc !== 'string'
    ) {
      throw new Error(`models.dev provider ${sourceId} has an unsupported shape`);
    }
    generatedProviders[providerType] = {
      id: provider.id,
      name: provider.name,
      ...(typeof provider.api === 'string' ? { api: provider.api } : {}),
      doc: provider.doc,
    };
    generated[providerType] = Object.fromEntries(
      Object.entries(provider.models)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, model]) => [id, toMetadata(sourceId, id, provider, model)]),
    );
    generatedModelProviderOverrides[providerType] = Object.fromEntries(
      Object.entries(provider.models)
        .sort(([left], [right]) => left.localeCompare(right))
        .filter(([, model]) => model.provider !== undefined)
        .map(([id, model]) => [id, toModelProviderOverride(sourceId, id, model.provider)]),
    );
    if (!PRICING_EXCLUDED_PROVIDER_TYPES.has(providerType)) {
      generatedPricing.push(
        ...Object.entries(provider.models)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, model]) => toPricing(providerType, id, model))
          .filter((pricing) => pricing !== undefined),
      );
    }
  }

  const providerTypeUnion = Object.keys(PROVIDERS).map(JSON.stringify).join(' | ');
  const lines = [
    ...snapshotHeader(
      '// Do not edit by hand; put access-path-specific facts in model-metadata.ts.',
    ),
    "import type { ModelMetadata } from './model-metadata.js';",
    '',
    `export const GENERATED_MODELS_DEV_METADATA: Record<${providerTypeUnion}, Record<string, ModelMetadata>> = {`,
  ];
  for (const [provider, models] of Object.entries(generated)) {
    lines.push(`  ${JSON.stringify(provider)}: {`);
    for (const [id, metadata] of Object.entries(models)) {
      lines.push(`    ${JSON.stringify(id)}: ${JSON.stringify(metadata)},`);
    }
    lines.push('  },');
  }
  lines.push('};', '');
  lines.push(
    `export const GENERATED_MODELS_DEV_MODEL_PROVIDER_OVERRIDES: Record<${providerTypeUnion}, Record<string, { npm: string; api?: string }>> = {`,
  );
  for (const [provider, overrides] of Object.entries(generatedModelProviderOverrides)) {
    lines.push(`  ${JSON.stringify(provider)}: ${JSON.stringify(overrides)},`);
  }
  lines.push('};', '');
  lines.push(
    `export const GENERATED_MODELS_DEV_PROVIDER_FACTS: Record<${providerTypeUnion}, { id: string; name: string; api?: string; doc: string }> = {`,
  );
  for (const [provider, facts] of Object.entries(generatedProviders)) {
    lines.push(`  ${JSON.stringify(provider)}: ${JSON.stringify(facts)},`);
  }
  lines.push('};', '');
  await writeFile(outputPath, lines.join('\n'));
  if (pricingOutputPath) {
    await writeFile(pricingOutputPath, buildPricingModule(generatedPricing));
  }
}

function toModelProviderOverride(providerId, modelId, override) {
  if (
    !override ||
    typeof override !== 'object' ||
    typeof override.npm !== 'string' ||
    (override.api !== undefined && typeof override.api !== 'string')
  ) {
    throw new Error(
      `models.dev model ${providerId}/${modelId} has an unsupported provider override`,
    );
  }
  return {
    npm: override.npm,
    ...(override.api ? { api: override.api } : {}),
  };
}

export function toMetadata(providerId, modelId, provider, model) {
  if (
    typeof provider.doc !== 'string' ||
    typeof model?.name !== 'string' ||
    (model.modalities !== undefined && !Array.isArray(model.modalities?.input)) ||
    (model.modalities !== undefined && !Array.isArray(model.modalities?.output)) ||
    typeof model.limit?.context !== 'number' ||
    typeof model.limit?.output !== 'number' ||
    typeof model.reasoning !== 'boolean' ||
    typeof model.tool_call !== 'boolean'
  ) {
    throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported shape`);
  }
  if (
    (model.description !== undefined && typeof model.description !== 'string') ||
    (model.knowledge !== undefined && typeof model.knowledge !== 'string') ||
    (model.limit?.input !== undefined &&
      (typeof model.limit.input !== 'number' || !Number.isFinite(model.limit.input))) ||
    (model.structured_output !== undefined && typeof model.structured_output !== 'boolean') ||
    (model.last_updated !== undefined && typeof model.last_updated !== 'string')
  ) {
    throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported shape`);
  }
  const lifecycle = lifecycleForStatus(providerId, modelId, model.status);
  const reasoningOptions = model.reasoning_options ?? [];
  if (!Array.isArray(reasoningOptions)) {
    throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported shape`);
  }
  let efforts;
  let toggle = false;
  for (const entry of reasoningOptions) {
    if (entry?.type === 'effort') {
      if (!Array.isArray(entry.values) || entry.values.some((value) => typeof value !== 'string')) {
        throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported shape`);
      }
      efforts = entry.values;
    } else if (entry?.type === 'toggle') {
      toggle = true;
    } else if (entry?.type !== 'budget_tokens') {
      // budget_tokens is a known models.dev option type with no wire consumer
      // yet; any other unknown type fails loudly so a models.dev schema change
      // is a conscious decision, not silent drift.
      throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported shape`);
    }
  }
  return {
    displayName: model.name,
    ...(model.description !== undefined ? { description: model.description } : {}),
    lifecycle,
    docsUrl: provider.doc,
    contextWindow: model.limit?.context,
    ...(model.limit?.input !== undefined ? { inputLimit: model.limit.input } : {}),
    maxOutputTokens: model.limit?.output,
    ...(model.knowledge !== undefined ? { knowledgeCutoff: model.knowledge } : {}),
    ...(model.structured_output !== undefined ? { structuredOutput: model.structured_output } : {}),
    ...(model.last_updated !== undefined ? { lastUpdated: model.last_updated } : {}),
    ...(model.cost?.input === 0 ? { isFree: true } : {}),
    capabilities: {
      ...(model.modalities ? { vision: model.modalities.input.includes('image') } : {}),
      reasoning: model.reasoning === true,
      functionCalling: model.tool_call === true,
    },
    ...(efforts?.length || toggle
      ? {
          thinkingOptions: {
            ...(efforts?.length ? { efforts } : {}),
            ...(toggle ? { toggle: true } : {}),
          },
        }
      : {}),
    ...(model.modalities
      ? {
          modalities: {
            input: model.modalities.input.filter(
              (value) =>
                value === 'text' || value === 'image' || value === 'audio' || value === 'pdf',
            ),
            output: (Array.isArray(model.modalities.output) ? model.modalities.output : []).filter(
              (value) => value === 'text' || value === 'image' || value === 'audio',
            ),
          },
        }
      : {}),
  };
}

export function toPricing(providerType, modelId, model) {
  const cost = model?.cost;
  if (cost === undefined) return undefined;
  if (!cost || typeof cost !== 'object' || Array.isArray(cost)) {
    throw new Error(`models.dev model ${providerType}/${modelId} has an unsupported cost shape`);
  }
  // PricingConfig and computeCost() currently represent one flat rate. Do
  // not publish a base rate for a model whose actual price depends on input
  // volume or an explicit tier table; that would systematically undercharge
  // long-context requests until the runtime can select a tier by usage.
  if (
    Object.prototype.hasOwnProperty.call(cost, 'context_over_200k') ||
    Object.prototype.hasOwnProperty.call(cost, 'tiers')
  ) {
    return undefined;
  }
  const inputUsdPer1M = priceNumber(providerType, modelId, cost.input, 'input');
  const outputUsdPer1M = priceNumber(providerType, modelId, cost.output, 'output');
  const cacheReadUsdPer1M = optionalPriceNumber(
    providerType,
    modelId,
    cost.cache_read,
    'cache_read',
  );
  const cacheWriteUsdPer1M = optionalPriceNumber(
    providerType,
    modelId,
    cost.cache_write,
    'cache_write',
  );
  return {
    modelKey: `${providerType}:${modelId}`,
    inputUsdPer1M,
    outputUsdPer1M,
    ...(cacheReadUsdPer1M !== undefined ? { cacheReadUsdPer1M } : {}),
    ...(cacheWriteUsdPer1M !== undefined ? { cacheWriteUsdPer1M } : {}),
  };
}

function lifecycleForStatus(providerId, modelId, status) {
  if (status === undefined) return 'active';
  if (status === 'active' || status === 'beta' || status === 'alpha' || status === 'deprecated') {
    return status;
  }
  throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported status`);
}

function priceNumber(providerType, modelId, value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`models.dev model ${providerType}/${modelId} has an unsupported cost.${field}`);
  }
  return value;
}

function optionalPriceNumber(providerType, modelId, value, field) {
  return value === undefined ? undefined : priceNumber(providerType, modelId, value, field);
}

// Every generated file names its upstream. The copyright line is required by
// models.dev's MIT license and is repeated in LICENSE under THIRD-PARTY
// COMPONENTS. models.dev serves a rolling document with no revision to cite,
// and the committed bytes below are what actually ships, so the file records
// where the data came from and lets git fix which data it was.
function snapshotHeader(handEditLine) {
  return [
    `// Generated by scripts/sync-model-metadata.mjs from ${SOURCE_URL}.`,
    '// Upstream: sst/models.dev (https://github.com/sst/models.dev), MIT,',
    '// Copyright (c) 2025 models.dev. See LICENSE, THIRD-PARTY COMPONENTS.',
    handEditLine,
  ];
}

function buildPricingModule(pricing) {
  const lines = [
    ...snapshotHeader(
      '// Do not edit by hand; special access-path pricing belongs in builtin-pricing.ts.',
    ),
    "import type { PricingConfig } from '@maka/core/usage-stats/types';",
    '',
    'export const GENERATED_MODEL_PRICING: readonly PricingConfig[] = [',
  ];
  for (const entry of pricing) lines.push(`  ${JSON.stringify(entry)},`);
  lines.push('];', '');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

function option(name, argv) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}
