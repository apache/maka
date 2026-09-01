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
import { fileURLToPath, pathToFileURL } from 'node:url';

// The projection lives in @maka/core because the Runtime Host runs it too.
// `prepare` fires before any workspace builds, so read the TypeScript source
// rather than a dist build that does not exist yet.
const projection = await loadTypeScriptModule(
  await readFile(
    fileURLToPath(new URL('../packages/core/src/models-dev-projection.ts', import.meta.url)),
    'utf8',
  ),
);
const { selectModelsDevCatalog, assertModelsDevProvider, collectProjectionRemovals } = projection;
const SOURCE_URL = projection.MODELS_DEV_SOURCE_URL;
export const PROVIDERS = projection.MODELS_DEV_PROVIDERS;
export const toMetadata = projection.projectModelsDevModel;
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

export async function main(argv = process.argv) {
  const refreshInputPath = option('--refresh-input', argv);
  const snapshotPath = option('--snapshot', argv) ?? DEFAULT_SNAPSHOT;
  const outputPath = option('--output', argv) ?? DEFAULT_OUTPUT;
  const pricingOutputPath =
    option('--pricing-output', argv) ??
    (outputPath === DEFAULT_OUTPUT ? DEFAULT_PRICING_OUTPUT : undefined);
  const refresh = argv.includes('--refresh');
  const check = argv.includes('--check');
  const drift = argv.includes('--drift');
  const acceptUpstreamRemovals = argv.includes('--accept-upstream-removals');
  if (drift && (refresh || check)) {
    throw new Error('--drift reports without writing and cannot combine with --refresh or --check');
  }
  if (refreshInputPath && !refresh && !drift) {
    throw new Error('--refresh-input requires --refresh or --drift');
  }
  if (acceptUpstreamRemovals && !refresh) {
    throw new Error('--accept-upstream-removals requires --refresh');
  }
  if (drift) {
    const report = await collectDrift(await loadSnapshot(snapshotPath), refreshInputPath);
    process.stdout.write(`${formatDrift(report)}\n`);
    return report;
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

// `options.onReject` decides what an unprojectable provider or model costs. A
// refresh has none, so the first bad shape aborts the whole snapshot rather
// than silently committing a catalog with a hole in it. The drift report
// passes one, because there a bad shape is the finding it exists to print and
// must not stop it comparing everything else.
function buildProjection(catalog, options = {}) {
  const onReject = options.onReject;
  const metadata = {};
  const pricing = [];
  const providerFacts = {};
  const providerOverrides = {};
  for (const [providerType, sourceId] of Object.entries(PROVIDERS)) {
    const provider = catalog[sourceId];
    try {
      assertModelsDevProvider(sourceId, provider);
    } catch (error) {
      if (!onReject) throw error;
      onReject('provider', providerType, error);
      continue;
    }
    providerFacts[providerType] = {
      id: provider.id,
      name: provider.name,
      ...(typeof provider.api === 'string' ? { api: provider.api } : {}),
      doc: provider.doc,
    };
    metadata[providerType] = {};
    providerOverrides[providerType] = {};
    const priced = !PRICING_EXCLUDED_PROVIDER_TYPES.has(providerType);
    const models = Object.entries(provider.models).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    for (const [id, model] of models) {
      let projected;
      try {
        projected = {
          metadata: toMetadata(sourceId, id, provider, model),
          override:
            model.provider === undefined
              ? undefined
              : toModelProviderOverride(sourceId, id, model.provider),
          pricing: priced ? toPricing(providerType, id, model) : undefined,
        };
      } catch (error) {
        if (!onReject) throw error;
        onReject('model', `${providerType}/${id}`, error);
        continue;
      }
      metadata[providerType][id] = projected.metadata;
      if (projected.override !== undefined)
        providerOverrides[providerType][id] = projected.override;
      if (projected.pricing !== undefined) pricing.push(projected.pricing);
    }
  }

  return { metadata, pricing, providerFacts, providerOverrides };
}

async function readUpstream(refreshInputPath) {
  if (refreshInputPath) {
    return {
      text: await readFile(refreshInputPath, 'utf8'),
      etag: null,
      retrievedAt: new Date().toISOString(),
    };
  }
  const response = await fetch(SOURCE_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`models.dev returned HTTP ${response.status}`);
  return {
    text: await response.text(),
    etag: response.headers.get('etag'),
    retrievedAt: new Date(response.headers.get('date') ?? Date.now()).toISOString(),
  };
}

async function refreshSnapshot(snapshotPath, refreshInputPath, options = {}) {
  const { text: sourceText, etag: sourceEtag, retrievedAt } = await readUpstream(refreshInputPath);
  const projection = buildProjection(selectModelsDevCatalog(JSON.parse(sourceText)));
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
  const removals = collectProjectionRemovals(previous, next);
  if (removals.length === 0) return;

  throw new Error(
    `models.dev refresh would remove committed projection paths: ${removals.join(', ')}; inspect the upstream change and rerun with --accept-upstream-removals to acknowledge it`,
  );
}

// `--check` only proves the generated modules match the committed snapshot.
// Nothing compared that snapshot against models.dev, which is how it stayed
// weeks behind upstream without anything reporting it. This walks the two one
// model at a time, so a shape the projector rejects becomes its own finding
// instead of aborting the whole comparison the way a refresh does.
const DRIFT_LIST_LIMIT = 20;

// Every section of the projection, flattened to one value per entity. The
// report reads sections through this table instead of naming them itself,
// which is how it went out comparing only two of the four. A section added to
// buildProjection is compared here without touching the comparison.
const PROJECTION_SECTIONS = {
  metadata: entitiesByProviderAndModel,
  // modelKey is `${providerType}:${id}`, so replacing the first colon yields
  // the label every other section already uses.
  pricing: (section) => new Map(section.map((entry) => [entry.modelKey.replace(':', '/'), entry])),
  providerFacts: (section) => new Map(Object.entries(section)),
  providerOverrides: entitiesByProviderAndModel,
};

async function collectDrift(snapshot, refreshInputPath) {
  const rejectedProviders = [];
  const rejectedModels = [];
  const rejected = new Set();
  // The raw catalog, not the selected one: a provider that vanished upstream
  // is the report's most important finding, and selection throws on it.
  const upstream = buildProjection(JSON.parse((await readUpstream(refreshInputPath)).text), {
    onReject: (kind, label, error) => {
      rejected.add(label);
      (kind === 'provider' ? rejectedProviders : rejectedModels).push(`${label}: ${error.message}`);
    },
  });
  const previous = projectionEntities(snapshot.projection);
  const next = projectionEntities(upstream);
  const report = { rejectedProviders, rejectedModels, added: [], removed: [], changed: [] };
  for (const label of [...new Set([...previous.keys(), ...next.keys()])].sort()) {
    const before = previous.get(label);
    const after = next.get(label);
    if (before === undefined) {
      report.added.push(label);
      continue;
    }
    if (after === undefined) {
      // A shape the projector rejected already has its own finding above. It
      // is not upstream saying the entity is gone.
      if (!isRejected(label, rejected)) report.removed.push(label);
      continue;
    }
    const fields = driftedFields(before, after);
    if (fields.length > 0) report.changed.push(`${label}: ${fields.join(', ')}`);
  }
  const drifted = Object.values(report).some((entries) => entries.length > 0);
  return { ...report, drifted };
}

function entitiesByProviderAndModel(section) {
  const entities = new Map();
  for (const [providerType, models] of Object.entries(section)) {
    for (const [id, value] of Object.entries(models)) entities.set(`${providerType}/${id}`, value);
  }
  return entities;
}

function projectionEntities(projection) {
  const entities = new Map();
  for (const [section, flatten] of Object.entries(PROJECTION_SECTIONS)) {
    for (const [label, value] of flatten(projection[section])) {
      const entity = entities.get(label);
      if (entity) entity[section] = value;
      else entities.set(label, { [section]: value });
    }
  }
  return entities;
}

function isRejected(label, rejected) {
  if (rejected.has(label)) return true;
  const slash = label.indexOf('/');
  return slash !== -1 && rejected.has(label.slice(0, slash));
}

function driftedFields(previous, next) {
  const fields = [];
  for (const section of Object.keys(PROJECTION_SECTIONS)) {
    const before = previous[section];
    const after = next[section];
    if (sameValue(before, after)) continue;
    if (isPlainObject(before) && isPlainObject(after)) {
      const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
      for (const key of keys) {
        if (!sameValue(before[key], after[key])) fields.push(`${section}.${key}`);
      }
      continue;
    }
    fields.push(section);
  }
  return fields;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Both sides are projector output, so their keys are already in one order.
function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function formatDrift(report) {
  const lines = [];
  for (const [label, entries] of [
    ['providers the projector rejects', report.rejectedProviders],
    ['models the projector rejects', report.rejectedModels],
    ['entries upstream has and the snapshot does not', report.added],
    ['entries the snapshot has and upstream does not', report.removed],
    ['entries whose projection changed', report.changed],
  ]) {
    if (entries.length === 0) continue;
    lines.push(`${label}: ${entries.length}`);
    for (const entry of entries.slice(0, DRIFT_LIST_LIMIT)) lines.push(`  ${entry}`);
    if (entries.length > DRIFT_LIST_LIMIT) {
      lines.push(`  ... and ${entries.length - DRIFT_LIST_LIMIT} more`);
    }
  }
  if (!report.drifted) return `${SOURCE_URL} matches the committed snapshot.`;
  return [`${SOURCE_URL} has drifted from the committed snapshot.`, ...lines].join('\n');
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
  // Drift is a finding, not a crash. Exit 2 so a caller can tell "upstream
  // moved" from "this command failed"; both reported 1 before, which made the
  // difference unreadable to the one job that has to act on it.
  if ((await main())?.drifted) process.exitCode = 2;
}

function option(name, argv) {
  const index = argv.indexOf(name);
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}
