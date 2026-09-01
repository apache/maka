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

import type {
  LlmConnection,
  ModelDiscoverySource,
  ModelInfo,
  ProviderDefaults,
  ProviderType,
} from './llm-connections.js';
import {
  classifyConnectionModelInventory,
  CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS,
  PROVIDER_REGISTRY,
  providerDefaultsOf,
  providerSupportsModelDiscovery,
  type ConnectionModelInventory,
} from './llm-connections.js';
import type { PricingConfig } from './usage-stats/types.js';
import {
  curatedCatalogFallbackModelsForProvider,
  lookupModelMetadata,
  resolveModelVisionSupport,
} from './model-metadata.js';
import {
  relayModelProfile,
  thinkingVariantsForConnection,
  type RelayModelProfiles,
  type ThinkingLevel,
} from './model-thinking.js';
import { pricingModelKey } from './usage-stats/pricing.js';

export type ModelUnavailableReason =
  | 'none'
  | 'not_in_live_list'
  | 'unsupported_for_chat'
  | 'provider_removed'
  | 'auth'
  | 'stale';

export type ModelCatalogLifecycle =
  | 'active'
  | 'beta'
  | 'alpha'
  | 'deprecated'
  | 'retired'
  | 'unknown';

export interface KnownModelCapabilities {
  chat?: true;
  vision?: true;
  reasoning?: true;
  functionCalling?: true;
  parallelToolCalls?: true;
  imageGeneration?: true;
  webSearch?: true;
}

export interface ModelCatalogPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cacheReadUsdPer1M?: number;
  cacheWriteUsdPer1M?: number;
  source: 'builtin' | 'user_override';
}

export interface ModelCatalogEntry {
  id: string;
  displayName?: string;
  description?: string;
  providerType: ProviderType;
  connectionSlug?: string;
  source: 'provider_api' | 'static_catalog' | 'unknown';
  unavailableReason: ModelUnavailableReason;
  canUseAsChatDefault: boolean;
  isDefault: boolean;
  capabilities: KnownModelCapabilities;
  /**
   * Reasoning levels this model offers on this connection, in display order;
   * empty for a non-reasoning model. Part of the entry rather than a second
   * lookup because a picker that lists a model always has to render its
   * thinking choices, and two projections of one model's facts drifted: the
   * entry's capabilities ignored the user's relay declaration that the
   * thinking projection honoured.
   */
  thinkingLevels: readonly ThinkingLevel[];
  lifecycle: ModelCatalogLifecycle;
  docsUrl?: string;
  contextWindow?: number;
  inputLimit?: number;
  maxOutputTokens?: number;
  knowledgeCutoff?: string;
  structuredOutput?: boolean;
  lastUpdated?: string;
  modalities?: ModelInfo['modalities'];
  pricing?: ModelCatalogPricing;
  provenance: {
    modelSource?: ModelDiscoverySource;
    modelsFetchedAt?: number;
    pricingModelKey?: string;
  };
}

export interface BuildConnectionModelCatalogInput {
  connection: Pick<
    LlmConnection,
    | 'slug'
    | 'providerType'
    | 'defaultModel'
    | 'enabledModelIds'
    | 'models'
    | 'modelSource'
    | 'modelsFetchedAt'
    | 'relayModelProfiles'
  >;
  /** Ids the catalog must list even when no inventory describes them (#1584). */
  savedModelIds?: Iterable<string | undefined | null>;
  fallbackModels?: string[];
  now?: number;
  staleAfterMs?: number;
  providerAvailable?: boolean;
  authOk?: boolean;
  pricing?: Iterable<PricingConfig>;
  pricingSource?: 'builtin' | 'user_override';
}

export interface BuildModelCatalogInput {
  providerType: ProviderType;
  connectionSlug?: string;
  defaultModel?: string;
  models?: ModelInfo[];
  modelSource?: ModelDiscoverySource;
  modelsFetchedAt?: number;
  fallbackModels?: string[];
  now?: number;
  staleAfterMs?: number;
  providerAvailable?: boolean;
  authOk?: boolean;
  pricing?: Iterable<PricingConfig>;
  pricingSource?: 'builtin' | 'user_override';
  /** Ids the catalog must list even when no inventory describes them (#1584). */
  savedModelIds?: Iterable<string | undefined | null>;
  /** Per-model user declarations; authoritative over every catalog source. */
  relayModelProfiles?: RelayModelProfiles;
}

const DEFAULT_STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export function buildModelCatalogEntries(input: BuildModelCatalogInput): ModelCatalogEntry[] {
  const liveModels = input.models;
  const modelSource =
    input.modelSource ??
    (liveModels !== undefined && liveModels.length > 0 ? 'fetched' : 'fallback');
  // The RAW `modelSource`, not a source inferred from the array, distinguishes
  // a failed discovery from an explicit empty provider response.
  const inventory = classifyConnectionModelInventory({
    providerType: input.providerType,
    models: input.models,
    modelSource: input.modelSource,
  });
  const normalizedDefaultModel = input.defaultModel?.trim();
  const source = inventory === 'live' ? 'provider_api' : 'static_catalog';
  // An empty array without a successful discovery source is the persisted
  // shape of a failed or not-yet-run discovery. It must not hide the static
  // fallback catalog from the picker. An empty fetched array is different: it
  // is an authoritative provider response and should remain empty.
  const rawModels =
    liveModels !== undefined && (liveModels.length > 0 || modelSource === 'fetched')
      ? liveModels
      : (input.fallbackModels ?? []).map((id) => ({
          id,
          ...displayNameForKnownModel(input.providerType, id),
        }));
  const savedModelIds = normalizedIdSet(input.savedModelIds);
  const ctx: EntryContext = {
    input,
    modelSource,
    normalizedDefaultModel,
  };
  const seen = new Set<string>();
  const entries = rawModels
    .filter((model) => {
      const id = model.id.trim();
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((model) => makeEntry(ctx, model, source));

  if (normalizedDefaultModel && !seen.has(normalizedDefaultModel)) {
    entries.unshift(makeMissingEntry(ctx, normalizedDefaultModel, inventory, { isDefault: true }));
    seen.add(normalizedDefaultModel);
  }

  for (const id of savedModelIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(makeMissingEntry(ctx, id, inventory));
  }

  return entries;
}

/**
 * The offerable models a provider ships for a connection: its curated catalog
 * list when the bundled metadata has one, its registry list otherwise, minus
 * anything quarantined.
 */
function providerFallbackModelIds(
  providerType: ProviderType,
  defaults: Pick<ProviderDefaults, 'fallbackModels' | 'brokenModelIds'>,
): string[] {
  const broken = new Set(defaults.brokenModelIds ?? []);
  const curated = curatedCatalogFallbackModelsForProvider(providerType);
  return [...(curated ?? defaults.fallbackModels)].filter((id) => !broken.has(id));
}

/**
 * The most fallback rows a connection's catalog can gain beyond what the
 * connection itself stores.
 *
 * A provider with no model-list endpoint has its whole shipped inventory
 * prepended to the connection's own models rather than substituted for them,
 * so its catalog is larger than the persisted lists it draws from — and the
 * wire bound that admits such a catalog has to allow for the difference. It is
 * derived from the registry rather than written down beside it: a provider
 * added or a curated list grown would otherwise leave a hand-written bound
 * quietly too small, which is exactly how a valid persisted catalog became
 * unencodable. Providers that do discover models substitute their fallback
 * list instead of prepending it, so they add nothing here.
 */
export const MAX_PREPENDED_FALLBACK_MODELS: number = Object.keys(PROVIDER_REGISTRY).reduce(
  (largest, providerType) => {
    if (providerSupportsModelDiscovery(providerType as ProviderType)) return largest;
    const defaults = providerDefaultsOf(providerType);
    if (!defaults) return largest;
    return Math.max(
      largest,
      providerFallbackModelIds(providerType as ProviderType, defaults).length,
    );
  },
  0,
);

export function buildConnectionModelCatalogEntries(
  input: BuildConnectionModelCatalogInput,
): ModelCatalogEntry[] {
  const { connection } = input;
  const defaults = providerDefaultsOf(connection.providerType);
  // Unknown providerType (legacy seed, or a connection persisted on a branch
  // that registers a provider this build doesn't know) → no catalog entries.
  // Mirrors `isRealConnection` in connection-readiness.ts.
  if (!defaults) return [];
  const supportsModelDiscovery = providerSupportsModelDiscovery(connection.providerType);
  // Quarantined ids never surface as offerable entries — from any source,
  // including inventories stored or selections made before the quarantine —
  // mirroring the `authorizeConnectionModel` veto.
  const broken = new Set(defaults.brokenModelIds ?? []);
  const fallbackModels = providerFallbackModelIds(connection.providerType, defaults);
  // A quarantined id persisted as this connection's `defaultModel` must not
  // re-enter the catalog either. `models` and `enabledModelIds` are filtered
  // below, but a broken default reaches `makeMissingDefaultEntry` unfiltered and
  // would be re-added as a selectable `provider_default` row — picker-visible
  // and default-capable while `authorizeConnectionModel` vetoes the same id. A
  // reachable persisted state: the id was picker-visible before the quarantine.
  // Dropping it leaves the connection with no valid default (readiness reports
  // `missing_model`), which is what a model that can no longer send warrants.
  const defaultModel = broken.has((connection.defaultModel ?? '').trim())
    ? undefined
    : connection.defaultModel;
  const fallbackModelIds = new Set(fallbackModels);
  const projectedModelsById = new Map(
    (connection.models ?? []).filter(({ id }) => !broken.has(id)).map((model) => [model.id, model]),
  );
  // Fallback providers have no live inventory, but a projected connection can
  // still carry enabled model-facts entries that are absent from the static
  // list. Keep both sets in the catalog so those user-declared models retain
  // their metadata and provenance.
  const models = supportsModelDiscovery
    ? connection.models?.filter(({ id }) => !broken.has(id))
    : [
        ...fallbackModels.map(
          (id) =>
            projectedModelsById.get(id) ?? {
              id,
              ...displayNameForKnownModel(connection.providerType, id),
            },
        ),
        ...(connection.models ?? []).filter(
          (model) => !broken.has(model.id) && !fallbackModelIds.has(model.id),
        ),
      ];
  return buildModelCatalogEntries({
    providerType: connection.providerType,
    connectionSlug: connection.slug,
    defaultModel,
    models,
    modelSource: supportsModelDiscovery ? connection.modelSource : 'fallback',
    modelsFetchedAt: supportsModelDiscovery ? connection.modelsFetchedAt : undefined,
    fallbackModels: supportsModelDiscovery
      ? (input.fallbackModels ?? fallbackModels)
      : fallbackModels,
    now: input.now,
    staleAfterMs: input.staleAfterMs,
    // A retired provider's models stay listed so an existing connection still
    // renders, but they resolve to `provider_removed` and stop being selectable.
    // Without this the pickers would keep offering models that can no longer
    // send — `runtimeAdapter: 'unavailable'` blocks the send, not the choice.
    providerAvailable: defaults.retired === true ? false : input.providerAvailable,
    authOk: input.authOk,
    pricing: input.pricing,
    pricingSource: input.pricingSource,
    ...(connection.relayModelProfiles ? { relayModelProfiles: connection.relayModelProfiles } : {}),
    // Enabling a model IS a user choice — the raw array is written only by the
    // user, in connection settings — so it projects an entry even when no
    // catalog describes the id. Without this a model the user enabled on a
    // provider whose `models` is a release snapshot vanished from every picker
    // (#1584), and fixing it at one call site left the others broken. The raw
    // array, not `connectionEnabledModelIds`: that one folds in `defaultModel`,
    // which the builder already lists on its own.
    savedModelIds: [...(connection.enabledModelIds ?? []), ...(input.savedModelIds ?? [])].filter(
      (id) => !broken.has(id ?? ''),
    ),
  });
}

/**
 * Pre-readiness normalization for ChatGPT-subscription (Codex)
 * connections: models the subscription cannot serve are filtered out of
 * the enabled list and the default falls back to the first servable
 * model, so the readiness gate below judges the models that would
 * actually be used. Pure; returns the input unchanged for non-Codex
 * providers. Moved from the former desktop send gate (#1038) so onboarding
 * and the session compatibility projection share one normalization.
 */
export function normalizeOpenAiCodexConnection<
  T extends Pick<LlmConnection, 'providerType' | 'models' | 'defaultModel'>,
>(connection: T): T {
  if (connection.providerType !== 'openai-codex') return connection;
  const fallbackModels = PROVIDER_REGISTRY['openai-codex'].fallbackModels;
  const safeModels = (connection.models ?? []).filter(
    (entry) => entry.id && !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(entry.id),
  );
  const models = safeModels.length ? safeModels : fallbackModels.map((id) => ({ id }));
  const enabledModelIds = new Set(models.map((entry) => entry.id));
  const defaultModel =
    connection.defaultModel &&
    !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(connection.defaultModel) &&
    enabledModelIds.has(connection.defaultModel)
      ? connection.defaultModel
      : (models[0]?.id ?? fallbackModels[0] ?? connection.defaultModel);
  if (models === connection.models && defaultModel === connection.defaultModel) return connection;
  return { ...connection, defaultModel, models };
}

/**
 * A connection's catalog as the Host resolves it. The one entry point for
 * "what models does this connection have, and what is true about them" —
 * Host projection and its tests resolve through here so the provider rules
 * that shape the list (the Codex subscription's servable set) cannot be
 * applied in one place and forgotten in another.
 */
export function resolveConnectionModelCatalog(
  connection: BuildConnectionModelCatalogInput['connection'],
): ModelCatalogEntry[] {
  return buildConnectionModelCatalogEntries({
    connection: normalizeOpenAiCodexConnection(connection),
  });
}

/**
 * The per-build facts every entry in one catalog shares. Threading them as one
 * value keeps the entry builders' remaining parameters to what actually varies
 * between an entry and its neighbours.
 */
interface EntryContext {
  readonly input: BuildModelCatalogInput;
  readonly modelSource: ModelDiscoverySource;
  readonly normalizedDefaultModel: string | undefined;
}

/**
 * The facts an entry cannot derive from its model row. A model the catalog
 * never listed has no row to derive them from: its unavailability is a
 * property of the inventory rather than of the model, and a missing default
 * is default by construction.
 */
interface EntryOverrides {
  readonly unavailableReason?: ModelUnavailableReason;
  readonly isDefault?: boolean;
}

function makeEntry(
  ctx: EntryContext,
  model: ModelInfo,
  source: ModelCatalogEntry['source'],
  overrides: EntryOverrides = {},
): ModelCatalogEntry {
  const { input, modelSource, normalizedDefaultModel } = ctx;
  const normalizedModel = { ...model, id: model.id.trim() };
  const pricing = findPricing(input, normalizedModel.id);
  const metadata = lookupModelMetadata(input.providerType, normalizedModel.id);
  const contextWindow = normalizedModel.contextWindow ?? metadata.contextWindow;
  const inputLimit = normalizedModel.inputLimit ?? metadata.inputLimit;
  const maxOutputTokens = normalizedModel.maxOutputTokens ?? metadata.maxOutputTokens;
  const description = normalizedModel.description ?? metadata.description;
  const knowledgeCutoff = normalizedModel.knowledgeCutoff ?? metadata.knowledgeCutoff;
  const structuredOutput = normalizedModel.structuredOutput ?? metadata.structuredOutput;
  const lastUpdated = normalizedModel.lastUpdated ?? metadata.lastUpdated;
  const modalities = normalizedModel.modalities ?? metadata.modalities;
  // The user's per-model declaration outranks every catalog source, so both
  // capability reads that honour it — vision and thinking — resolve here
  // rather than being recomputed by whoever renders the entry.
  const thinkingContext = {
    providerType: input.providerType,
    ...(input.relayModelProfiles ? { relayModelProfiles: input.relayModelProfiles } : {}),
  };
  const capabilities = {
    ...mergeCapabilities(normalizedModel.capabilities, metadata.capabilities),
    vision: resolveModelVisionSupport(
      input.providerType,
      [normalizedModel],
      normalizedModel.id,
      relayModelProfile(thinkingContext, normalizedModel.id)?.vision,
    ),
  };
  // `modalities` too, not just `capabilities`: both are merged from the
  // provider row and the bundled metadata a few lines up, and the chat guard
  // reads the modality. Passing the unmerged `normalizedModel.modalities`
  // meant a bundled image-only model reached the guard with no output
  // declaration at all.
  const unavailableReason =
    overrides.unavailableReason ??
    deriveModelUnavailableReason(input, {
      ...normalizedModel,
      capabilities,
      ...(modalities !== undefined ? { modalities } : {}),
    });
  return {
    id: normalizedModel.id,
    ...displayNameForModel(input.providerType, normalizedModel),
    ...(description !== undefined ? { description } : {}),
    providerType: input.providerType,
    ...(input.connectionSlug ? { connectionSlug: input.connectionSlug } : {}),
    source,
    unavailableReason,
    canUseAsChatDefault: canUseUnavailableReasonAsDefault(unavailableReason),
    isDefault: overrides.isDefault ?? normalizedModel.id === normalizedDefaultModel,
    capabilities: normalizeCapabilities(capabilities),
    thinkingLevels: thinkingVariantsForConnection(thinkingContext, normalizedModel.id),
    lifecycle: metadata.lifecycle ?? 'unknown',
    ...(metadata.docsUrl ? { docsUrl: metadata.docsUrl } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(inputLimit !== undefined ? { inputLimit } : {}),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
    ...(knowledgeCutoff !== undefined ? { knowledgeCutoff } : {}),
    ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    ...(lastUpdated !== undefined ? { lastUpdated } : {}),
    ...(modalities !== undefined ? { modalities } : {}),
    ...(pricing ? { pricing } : {}),
    provenance: {
      modelSource,
      ...(input.modelsFetchedAt ? { modelsFetchedAt: input.modelsFetchedAt } : {}),
      ...(pricing
        ? { pricingModelKey: pricingModelKey(input.providerType, normalizedModel.id) }
        : {}),
    },
  };
}

/**
 * An entry for an id no catalog row describes. It is `makeEntry` over a bare
 * model row: every field then resolves from the bundled metadata alone, which
 * is exactly what these entries carried when they were built separately.
 */
function makeMissingEntry(
  ctx: EntryContext,
  id: string,
  inventory: ConnectionModelInventory,
  overrides: Omit<EntryOverrides, 'unavailableReason'> = {},
): ModelCatalogEntry {
  return makeEntry(ctx, { id }, 'unknown', {
    unavailableReason: missingEntryUnavailableReason(ctx.input, inventory),
    ...overrides,
  });
}

function mergeCapabilities(
  providerCapabilities: ModelInfo['capabilities'] | undefined,
  metadataCapabilities: ModelInfo['capabilities'] | undefined,
): ModelInfo['capabilities'] | undefined {
  if (!providerCapabilities) return metadataCapabilities;
  if (!metadataCapabilities) return providerCapabilities;
  return {
    chat: providerCapabilities.chat ?? metadataCapabilities.chat,
    vision: providerCapabilities.vision ?? metadataCapabilities.vision,
    reasoning: providerCapabilities.reasoning ?? metadataCapabilities.reasoning,
    functionCalling: providerCapabilities.functionCalling ?? metadataCapabilities.functionCalling,
    parallelToolCalls:
      providerCapabilities.parallelToolCalls ?? metadataCapabilities.parallelToolCalls,
    imageGeneration: providerCapabilities.imageGeneration ?? metadataCapabilities.imageGeneration,
    webSearch: providerCapabilities.webSearch ?? metadataCapabilities.webSearch,
  };
}

function displayNameForModel(
  providerType: ProviderType,
  model: ModelInfo,
): { displayName?: string } {
  const displayName = model.displayName?.trim();
  if (displayName && displayName !== model.id) return { displayName };
  return displayNameForKnownModel(providerType, model.id);
}

function displayNameForKnownModel(
  providerType: ProviderType,
  id: string,
): { displayName?: string } {
  const displayName = lookupModelMetadata(providerType, id).displayName;
  return displayName ? { displayName } : {};
}

function deriveModelUnavailableReason(
  input: Pick<
    BuildModelCatalogInput,
    | 'providerType'
    | 'providerAvailable'
    | 'authOk'
    | 'models'
    | 'modelSource'
    | 'modelsFetchedAt'
    | 'now'
    | 'staleAfterMs'
  >,
  model: ModelInfo,
): ModelUnavailableReason {
  const providerOrAuthReason = providerOrAuthUnavailableReason(input);
  if (providerOrAuthReason) return providerOrAuthReason;
  if (isModelExplicitlyUnsupportedForChat(model)) return 'unsupported_for_chat';
  if (isStale(input)) return 'stale';
  return 'none';
}

function providerOrAuthUnavailableReason(
  input: Pick<BuildModelCatalogInput, 'providerAvailable' | 'authOk'>,
): Extract<ModelUnavailableReason, 'provider_removed' | 'auth'> | null {
  if (input.providerAvailable === false) return 'provider_removed';
  if (input.authOk === false) return 'auth';
  return null;
}

function missingEntryUnavailableReason(
  input: Pick<BuildModelCatalogInput, 'providerAvailable' | 'authOk' | 'models'>,
  inventory: ConnectionModelInventory,
): ModelUnavailableReason {
  const providerOrAuthReason = providerOrAuthUnavailableReason(input);
  if (providerOrAuthReason) return providerOrAuthReason;
  // Only a live list can say a model is absent. A snapshot describes the
  // provider at release, so a model missing from it is simply one Maka has
  // never heard of — not one this account cannot run (#1584).
  return inventory === 'live' ? 'not_in_live_list' : 'none';
}

function isStale(
  input: Pick<
    BuildModelCatalogInput,
    'providerType' | 'models' | 'modelSource' | 'modelsFetchedAt' | 'now' | 'staleAfterMs'
  >,
): boolean {
  if (input.modelsFetchedAt === undefined) return false;
  // Only a live list can go stale. A snapshot is as current as the build.
  if (classifyConnectionModelInventory(input) !== 'live') return false;
  const now = input.now ?? Date.now();
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  return now - input.modelsFetchedAt > staleAfterMs;
}

/**
 * Whether a declared output modality rules the model out of chat.
 *
 * A model that answers only in images or only in audio cannot hold a
 * conversation, and this is the form that fact actually arrives in: the
 * generated metadata records `modalities.output` for every such model and has
 * never set `capabilities.imageGeneration` for any of them, so the capability
 * check below could not fire on bundled data.
 *
 * An EMPTY list is not evidence. `modalities.output` is typed to text, image,
 * and audio, so a video model's real output has no representation and
 * serializes as `[]` — the same shape a future generator bug would produce.
 * Only a non-empty list says something, and what it says is what it lists.
 */
function declaresNoTextOutput(model: ModelInfo): boolean {
  const output = model.modalities?.output;
  if (output === undefined || output.length === 0) return false;
  return !output.includes('text');
}

export function isModelExplicitlyUnsupportedForChat(model: ModelInfo): boolean {
  const caps = model.capabilities;
  if (caps?.chat === false) return true;
  // Only an explicit `chat: true` outranks the modality. `reasoning` and
  // `functionCalling` do not: a TTS model carrying `reasoning: true` is
  // describing how it composes speech, and it still cannot answer in text.
  if (caps?.chat !== true && declaresNoTextOutput(model)) return true;
  if (!caps) return false;
  return (
    caps.imageGeneration === true &&
    caps.chat !== true &&
    caps.reasoning !== true &&
    caps.functionCalling !== true
  );
}

function normalizeCapabilities(caps: ModelInfo['capabilities']): KnownModelCapabilities {
  if (!caps) return {};
  return {
    ...(caps.chat === true ? { chat: true as const } : {}),
    ...(caps.vision === true ? { vision: true as const } : {}),
    ...(caps.reasoning === true ? { reasoning: true as const } : {}),
    ...(caps.functionCalling === true ? { functionCalling: true as const } : {}),
    ...(caps.parallelToolCalls === true ? { parallelToolCalls: true as const } : {}),
    ...(caps.imageGeneration === true ? { imageGeneration: true as const } : {}),
    ...(caps.webSearch === true ? { webSearch: true as const } : {}),
  };
}

function canUseUnavailableReasonAsDefault(reason: ModelUnavailableReason): boolean {
  // `stale` and `not_in_live_list` are both things worth saying and neither is
  // a fact about what the account can run. A provider that did not mention a
  // model in its last response has not refused it; only the provider itself
  // can do that, when the request goes out (#1584).
  return reason === 'none' || reason === 'stale' || reason === 'not_in_live_list';
}

function normalizedIdSet(ids: Iterable<string | undefined | null> | undefined): Set<string> {
  const result = new Set<string>();
  for (const id of ids ?? []) {
    const trimmed = id?.trim();
    if (trimmed) result.add(trimmed);
  }
  return result;
}

function findPricing(input: BuildModelCatalogInput, id: string): ModelCatalogPricing | null {
  if (!input.pricing) return null;
  const modelKey = pricingModelKey(input.providerType, id);
  for (const item of input.pricing) {
    if (item.modelKey !== modelKey) continue;
    return {
      inputUsdPer1M: item.inputUsdPer1M,
      outputUsdPer1M: item.outputUsdPer1M,
      ...(item.cacheReadUsdPer1M !== undefined
        ? { cacheReadUsdPer1M: item.cacheReadUsdPer1M }
        : {}),
      ...(item.cacheWriteUsdPer1M !== undefined
        ? { cacheWriteUsdPer1M: item.cacheWriteUsdPer1M }
        : {}),
      source: input.pricingSource ?? 'builtin',
    };
  }
  return null;
}
