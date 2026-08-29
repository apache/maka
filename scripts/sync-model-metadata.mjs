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

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const SOURCE_URL = 'https://models.dev/api.json';
const DEFAULT_SNAPSHOT = 'scripts/model-metadata/models-dev-api.snapshot.json';
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
  'alibaba-cn': 'alibaba-cn',
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
  const refreshInputPath = option('--refresh-input', argv);
  const snapshotPath = option('--snapshot', argv) ?? DEFAULT_SNAPSHOT;
  const outputPath = option('--output', argv) ?? DEFAULT_OUTPUT;
  const pricingOutputPath =
    option('--pricing-output', argv) ??
    (outputPath === DEFAULT_OUTPUT ? DEFAULT_PRICING_OUTPUT : undefined);
  const refresh = argv.includes('--refresh');
  const check = argv.includes('--check');
  const acceptUpstreamRemovals = argv.includes('--accept-upstream-removals');
  if (refreshInputPath && !refresh) throw new Error('--refresh-input requires --refresh');
  if (acceptUpstreamRemovals && !refresh) {
    throw new Error('--accept-upstream-removals requires --refresh');
  }

  const source = refresh
    ? await refreshSnapshot(snapshotPath, refreshInputPath, { acceptUpstreamRemovals })
    : await loadSnapshot(snapshotPath);
  const {
    metadata: generated,
    pricing: generatedPricing,
    providerFacts: generatedProviders,
    providerOverrides: generatedModelProviderOverrides,
  } = source.projection;
  if (check) {
    await assertGeneratedOutputs(outputPath, pricingOutputPath, source);
    if (source.snapshotWrite) await replaceFilesTransactionally([source.snapshotWrite]);
    return;
  }

  const providerTypeUnion = Object.keys(PROVIDERS).map(JSON.stringify).join(' | ');
  const lines = [
    ...snapshotHeader(
      '// Do not edit by hand; put access-path-specific facts in model-metadata.ts.',
      source,
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
  const metadataText = completeGeneratedModule(lines.join('\n'));
  const writes = [{ path: outputPath, text: metadataText }];
  if (pricingOutputPath) {
    const pricingText = completeGeneratedModule(buildPricingModule(generatedPricing, source));
    writes.push({ path: pricingOutputPath, text: pricingText });
  }
  if (source.snapshotWrite) writes.push(source.snapshotWrite);
  await replaceFilesTransactionally(writes);
}

function buildProjection(catalog) {
  const metadata = {};
  const pricing = [];
  const providerFacts = {};
  const providerOverrides = {};
  for (const [providerType, sourceId] of Object.entries(PROVIDERS)) {
    const provider = catalog[sourceId];
    if (!provider) {
      throw new Error(`models.dev provider ${sourceId} is missing`);
    }
    if (
      !provider.models ||
      typeof provider.models !== 'object' ||
      Array.isArray(provider.models) ||
      Object.keys(provider.models).length === 0
    ) {
      throw new Error(`models.dev provider ${sourceId} has no non-empty models object`);
    }
    if (
      typeof provider.id !== 'string' ||
      typeof provider.name !== 'string' ||
      typeof provider.doc !== 'string'
    ) {
      throw new Error(`models.dev provider ${sourceId} has an unsupported shape`);
    }
    providerFacts[providerType] = {
      id: provider.id,
      name: provider.name,
      ...(typeof provider.api === 'string' ? { api: provider.api } : {}),
      doc: provider.doc,
    };
    metadata[providerType] = Object.fromEntries(
      Object.entries(provider.models)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, model]) => [id, toMetadata(sourceId, id, provider, model)]),
    );
    providerOverrides[providerType] = Object.fromEntries(
      Object.entries(provider.models)
        .sort(([left], [right]) => left.localeCompare(right))
        .filter(([, model]) => model.provider !== undefined)
        .map(([id, model]) => [id, toModelProviderOverride(sourceId, id, model.provider)]),
    );
    if (!PRICING_EXCLUDED_PROVIDER_TYPES.has(providerType)) {
      pricing.push(
        ...Object.entries(provider.models)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([id, model]) => toPricing(providerType, id, model))
          .filter((pricing) => pricing !== undefined),
      );
    }
  }

  return { metadata, pricing, providerFacts, providerOverrides };
}

async function refreshSnapshot(snapshotPath, refreshInputPath, options = {}) {
  let sourceText;
  let sourceEtag = null;
  let retrievedAt = new Date().toISOString();
  if (refreshInputPath) {
    sourceText = await readFile(refreshInputPath, 'utf8');
  } else {
    const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
    sourceText = await response.text();
    sourceEtag = response.headers.get('etag');
    retrievedAt = new Date(response.headers.get('date') ?? Date.now()).toISOString();
  }
  const projection = buildProjection(selectCatalog(JSON.parse(sourceText)));
  if (!options.acceptUpstreamRemovals) {
    const previous = await loadSnapshotIfPresent(snapshotPath);
    if (previous) assertProjectionDoesNotShrink(previous.projection, projection);
  }
  const projectionText = JSON.stringify(projection);
  const snapshot = {
    formatVersion: 1,
    sourceUrl: SOURCE_URL,
    origin: {
      kind: 'models-dev-response',
      retrievedAt,
      etag: sourceEtag,
      responseSha256: sha256(sourceText),
    },
    projectionSha256: sha256(projectionText),
    projection,
  };
  await mkdir(dirname(snapshotPath), { recursive: true });
  return {
    projection,
    snapshotDigest: snapshot.projectionSha256,
    snapshotLabel: snapshotPath,
    snapshotWrite: { path: snapshotPath, text: `${JSON.stringify(snapshot, null, 2)}\n` },
  };
}

function assertProjectionDoesNotShrink(previous, next) {
  const removals = [];
  collectProjectionRemovals(previous, next, [], removals);
  if (removals.length === 0) return;

  throw new Error(
    `models.dev refresh would remove committed projection paths: ${removals.sort().join(', ')}; inspect the upstream change and rerun with --accept-upstream-removals to acknowledge it`,
  );
}

function collectProjectionRemovals(previous, next, path, removals) {
  if (Array.isArray(previous)) {
    if (!Array.isArray(next)) {
      removals.push(projectionPath(path));
      return;
    }
    if (path.length === 1 && path[0] === 'pricing') {
      const nextByModelKey = new Map(next.map((entry) => [entry?.modelKey, entry]));
      for (const entry of previous) {
        const modelPath = [...path, entry.modelKey];
        const nextEntry = nextByModelKey.get(entry.modelKey);
        if (!nextEntry) removals.push(projectionPath(modelPath));
        else collectProjectionRemovals(entry, nextEntry, modelPath, removals);
      }
      return;
    }
    for (const value of previous) {
      if (!next.some((candidate) => Object.is(candidate, value))) {
        removals.push(`${projectionPath(path)} value ${JSON.stringify(value)}`);
      }
    }
    return;
  }

  if (!previous || typeof previous !== 'object') {
    if (
      previous === true &&
      next === false &&
      path.length === 5 &&
      path[0] === 'metadata' &&
      path[3] === 'capabilities'
    ) {
      removals.push(projectionPath(path));
    }
    return;
  }
  if (!next || typeof next !== 'object' || Array.isArray(next)) {
    removals.push(projectionPath(path));
    return;
  }
  for (const [key, value] of Object.entries(previous)) {
    const childPath = [...path, key];
    if (!Object.prototype.hasOwnProperty.call(next, key)) {
      removals.push(projectionPath(childPath));
    } else {
      collectProjectionRemovals(value, next[key], childPath, removals);
    }
  }
}

function projectionPath(path) {
  return `/${path.map((segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}

async function replaceFilesTransactionally(writes) {
  if (new Set(writes.map((write) => write.path)).size !== writes.length) {
    throw new Error('model metadata outputs must use distinct paths');
  }
  // Later workspace prebuilds may sync after an earlier workspace has already
  // compiled. Preserve byte-identical targets so their mtimes cannot make that
  // already-built workspace look stale.
  const changedWrites = (
    await Promise.all(
      writes.map(async (write) => {
        try {
          return (await readFile(write.path)).equals(Buffer.from(write.text)) ? undefined : write;
        } catch (error) {
          if (error?.code === 'ENOENT') return write;
          throw error;
        }
      }),
    )
  ).filter(Boolean);
  if (changedWrites.length === 0) return;
  const transactionId = `${process.pid}-${randomUUID()}`;
  const entries = changedWrites.map((write) => ({
    ...write,
    stagedPath: `${write.path}.tmp-${transactionId}`,
    backupPath: `${write.path}.bak-${transactionId}`,
    hadOriginal: false,
    installed: false,
  }));

  let committed = false;
  try {
    // Stage every byte before replacing any target. Missing/unwritable output
    // directories therefore leave the existing snapshot and outputs intact.
    const stageResults = await Promise.allSettled(
      entries.map((entry) => writeFile(entry.stagedPath, entry.text, { flag: 'wx' })),
    );
    const stageFailure = stageResults.find((result) => result.status === 'rejected');
    if (stageFailure) throw stageFailure.reason;
    for (const entry of entries) {
      try {
        await rename(entry.path, entry.backupPath);
        entry.hadOriginal = true;
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      await rename(entry.stagedPath, entry.path);
      entry.installed = true;
    }
    committed = true;
  } catch (error) {
    let rollbackError;
    for (const entry of [...entries].reverse()) {
      try {
        if (entry.installed) await rm(entry.path, { force: true });
        if (entry.hadOriginal) await rename(entry.backupPath, entry.path);
      } catch (candidate) {
        rollbackError ??= candidate;
      }
    }
    if (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'model metadata transaction rollback failed',
      );
    }
    throw error;
  } finally {
    const cleanupPaths = entries.flatMap((entry) => [
      entry.stagedPath,
      ...(committed ? [entry.backupPath] : []),
    ]);
    await Promise.all(cleanupPaths.map((path) => rm(path, { force: true }).catch(() => {})));
  }
}

async function loadSnapshot(snapshotPath) {
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  if (
    snapshot?.formatVersion !== 1 ||
    snapshot.sourceUrl !== SOURCE_URL ||
    !snapshot.origin ||
    typeof snapshot.origin !== 'object' ||
    Array.isArray(snapshot.origin) ||
    typeof snapshot.projectionSha256 !== 'string' ||
    !snapshot.projection ||
    typeof snapshot.projection !== 'object' ||
    Array.isArray(snapshot.projection)
  ) {
    throw new Error(`models.dev snapshot ${snapshotPath} has an unsupported shape`);
  }
  const actualDigest = sha256(JSON.stringify(snapshot.projection));
  if (actualDigest !== snapshot.projectionSha256) {
    throw new Error(
      `models.dev snapshot ${snapshotPath} digest mismatch: expected ${snapshot.projectionSha256}, got ${actualDigest}`,
    );
  }
  return {
    projection: snapshot.projection,
    snapshotDigest: actualDigest,
    snapshotLabel: snapshotPath,
  };
}

async function loadSnapshotIfPresent(snapshotPath) {
  try {
    return await loadSnapshot(snapshotPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function selectCatalog(catalog) {
  const selected = {};
  for (const sourceId of [...new Set(Object.values(PROVIDERS))].sort()) {
    if (!catalog[sourceId]) throw new Error(`models.dev provider ${sourceId} is missing`);
    selected[sourceId] = catalog[sourceId];
  }
  return selected;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function completeGeneratedModule(source) {
  return source.endsWith('\n') ? source : `${source}\n`;
}

async function assertGeneratedOutputs(metadataPath, pricingPath, source) {
  const metadataSource = await readFile(metadataPath, 'utf8');
  assert.ok(
    metadataSource.includes(
      `// Snapshot: ${source.snapshotLabel} (SHA-256 ${source.snapshotDigest}).`,
    ),
    `${metadataPath} is stale; run npm run sync:model-metadata`,
  );
  const metadataModule = await loadTypeScriptModule(metadataSource);
  assert.deepEqual(
    metadataModule.GENERATED_MODELS_DEV_METADATA,
    source.projection.metadata,
    `${metadataPath} is stale; run npm run sync:model-metadata`,
  );
  assert.deepEqual(
    metadataModule.GENERATED_MODELS_DEV_MODEL_PROVIDER_OVERRIDES,
    source.projection.providerOverrides,
    `${metadataPath} is stale; run npm run sync:model-metadata`,
  );
  assert.deepEqual(
    metadataModule.GENERATED_MODELS_DEV_PROVIDER_FACTS,
    source.projection.providerFacts,
    `${metadataPath} is stale; run npm run sync:model-metadata`,
  );
  if (!pricingPath) return;
  const pricingSource = await readFile(pricingPath, 'utf8');
  assert.ok(
    pricingSource.includes(
      `// Snapshot: ${source.snapshotLabel} (SHA-256 ${source.snapshotDigest}).`,
    ),
    `${pricingPath} is stale; run npm run sync:model-metadata`,
  );
  const pricingModule = await loadTypeScriptModule(pricingSource);
  assert.deepEqual(
    pricingModule.GENERATED_MODEL_PRICING,
    source.projection.pricing,
    `${pricingPath} is stale; run npm run sync:model-metadata`,
  );
}

export async function loadTypeScriptModule(source) {
  const javascript = stripTypeScriptTypes(source, { mode: 'strip' });
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
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
    model.modalities?.input.some(
      (value) => value !== 'text' && value !== 'image' && value !== 'audio' && value !== 'pdf',
    ) ||
    model.modalities?.output.some(
      (value) => value !== 'text' && value !== 'image' && value !== 'audio',
    )
  ) {
    throw new Error(`models.dev model ${providerId}/${modelId} has unsupported modalities`);
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
            input: model.modalities.input,
            output: model.modalities.output,
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

// Every generated file names the exact repository-contained input projection.
// The copyright line is required by models.dev's MIT license and is repeated
// in LICENSE under THIRD-PARTY COMPONENTS. The digest binds generated output
// to the snapshot bytes that ship in the same source archive.
function snapshotHeader(handEditLine, source) {
  return [
    `// Generated by scripts/sync-model-metadata.mjs from ${SOURCE_URL}.`,
    '// models.dev is the upstream refresh source; this committed snapshot is the build input.',
    `// Snapshot: ${source.snapshotLabel} (SHA-256 ${source.snapshotDigest}).`,
    '// Upstream: anomalyco/models.dev (https://github.com/anomalyco/models.dev), MIT,',
    '// Copyright (c) 2025 models.dev. See LICENSE, THIRD-PARTY COMPONENTS.',
    handEditLine,
  ];
}

function buildPricingModule(pricing, source) {
  const lines = [
    ...snapshotHeader(
      '// Do not edit by hand; special access-path pricing belongs in builtin-pricing.ts.',
      source,
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
