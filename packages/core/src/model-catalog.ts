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
  ProviderType,
} from './llm-connections.js';
import {
  classifyConnectionModelInventory,
  PROVIDER_DEFAULTS,
  providerSupportsModelDiscovery,
  type ConnectionModelInventory,
} from './llm-connections.js';
import type { PricingConfig } from './usage-stats/types.js';
import {
  curatedCatalogFallbackModelsForProvider,
  hasModelMetadata,
  lookupModelMetadata,
} from './model-metadata.js';
import { pricingModelKey } from './usage-stats/pricing.js';

export type ModelCapabilitySource = 'provider_api' | 'static_catalog' | 'user_override' | 'unknown';

export type ModelUnavailableReason =
  | 'none'
  | 'not_in_live_list'
  | 'unsupported_for_chat'
  | 'provider_removed'
  | 'auth'
  | 'stale';

export type ModelCatalogAvailability = 'available' | 'warning' | 'blocked';
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
}

export interface ModelCatalogPricing {
  inputUsdPer1M: number;
  outputUsdPer1M: number;
  cacheReadUsdPer1M?: number;
  cacheWriteUsdPer1M?: number;
  source: 'builtin' | 'user_override';
}

export type ModelCatalogUserChoiceSource =
  | 'connection_default'
  | 'saved_model'
  | 'session_model'
  | 'daily_review_model';

export type SavedModelChoice =
  | string
  | {
      id: string;
      source: Exclude<ModelCatalogUserChoiceSource, 'connection_default'>;
    };

export interface ModelCatalogProvenanceSources {
  providerInventory?: true;
  staticCatalog?: true;
  userChoice?: ModelCatalogUserChoiceSource[];
}

export interface ModelCatalogEntry {
  id: string;
  displayName?: string;
  description?: string;
  providerType: ProviderType;
  connectionSlug?: string;
  source: 'provider_api' | 'static_catalog' | 'unknown';
  capabilitySource: ModelCapabilitySource;
  unavailableReason: ModelUnavailableReason;
  availability: ModelCatalogAvailability;
  canUseAsChatDefault: boolean;
  isDefault: boolean;
  capabilities: KnownModelCapabilities;
  lifecycle: ModelCatalogLifecycle;
  recommendedRank?: number;
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
    userChoice?: true;
    sources?: ModelCatalogProvenanceSources;
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
  >;
  savedModelIds?: Iterable<SavedModelChoice | undefined | null>;
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
  savedModelIds?: Iterable<SavedModelChoice | undefined | null>;
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
  const recommendedRanks = recommendedRanksForProvider(input.providerType, input.fallbackModels);
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
  const savedChoiceSources = savedChoiceSourcesById(input.savedModelIds);
  const seen = new Set<string>();
  const entries = rawModels
    .filter((model) => {
      const id = model.id.trim();
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((model) =>
      makeEntry(
        input,
        model,
        source,
        modelSource,
        savedChoiceSources,
        normalizedDefaultModel,
        recommendedRanks,
      ),
    );

  if (normalizedDefaultModel && !seen.has(normalizedDefaultModel)) {
    entries.unshift(
      makeMissingDefaultEntry(
        input,
        normalizedDefaultModel,
        modelSource,
        inventory,
        savedChoiceSources,
        normalizedDefaultModel,
        recommendedRanks,
      ),
    );
    seen.add(normalizedDefaultModel);
  }

  for (const id of savedChoiceSources.keys()) {
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(
      makeMissingUserChoiceEntry(
        input,
        id,
        modelSource,
        inventory,
        savedChoiceSources,
        normalizedDefaultModel,
        recommendedRanks,
      ),
    );
  }

  return entries;
}

export function buildConnectionModelCatalogEntries(
  input: BuildConnectionModelCatalogInput,
): ModelCatalogEntry[] {
  const { connection } = input;
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  // Unknown providerType (legacy seed, or a connection persisted on a branch
  // that registers a provider this build doesn't know) → no catalog entries.
  // Mirrors `isRealConnection` in connection-readiness.ts.
  if (!defaults) return [];
  const supportsModelDiscovery = providerSupportsModelDiscovery(connection.providerType);
  const catalogFallbackModels = curatedCatalogFallbackModelsForProvider(connection.providerType);
  // Quarantined ids never surface as offerable entries — from any source,
  // including inventories stored or selections made before the quarantine —
  // mirroring the `authorizeConnectionModel` veto.
  const broken = new Set(defaults.brokenModelIds ?? []);
  const fallbackModels = [...(catalogFallbackModels ?? defaults.fallbackModels)].filter(
    (id) => !broken.has(id),
  );
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
  return buildModelCatalogEntries({
    providerType: connection.providerType,
    connectionSlug: connection.slug,
    defaultModel,
    models: connection.models?.filter(({ id }) => !broken.has(id)),
    modelSource: connection.modelSource,
    modelsFetchedAt: connection.modelsFetchedAt,
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
    // Enabling a model IS a user choice — the raw array is written only by the
    // user, in connection settings — so it projects an entry even when no
    // catalog describes the id. Without this a model the user enabled on a
    // provider whose `models` is a release snapshot vanished from every picker
    // (#1584), and fixing it at one call site left the others broken. The raw
    // array, not `connectionEnabledModelIds`: that one folds in `defaultModel`,
    // which `provenanceSources` already reports as `connection_default`.
    savedModelIds: [...(connection.enabledModelIds ?? []), ...(input.savedModelIds ?? [])].filter(
      (choice) => !broken.has(typeof choice === 'string' ? choice : (choice?.id ?? '')),
    ),
  });
}

export function validateChatDefaultModel(input: BuildModelCatalogInput):
  | {
      ok: true;
      entry: ModelCatalogEntry;
    }
  | {
      ok: false;
      reason: Exclude<ModelUnavailableReason, 'none' | 'stale'>;
      entry?: ModelCatalogEntry;
    } {
  const defaultModel = input.defaultModel?.trim();
  if (!defaultModel) {
    return { ok: false, reason: 'not_in_live_list' };
  }
  const entry = buildModelCatalogEntries(input).find((candidate) => candidate.id === defaultModel);
  if (!entry) {
    return { ok: false, reason: 'not_in_live_list' };
  }
  if (entry.canUseAsChatDefault) return { ok: true, entry };
  const reason =
    entry.unavailableReason === 'stale' || entry.unavailableReason === 'none'
      ? 'unsupported_for_chat'
      : entry.unavailableReason;
  return { ok: false, reason, entry };
}

function makeEntry(
  input: BuildModelCatalogInput,
  model: ModelInfo,
  source: ModelCatalogEntry['source'],
  modelSource: ModelDiscoverySource,
  savedChoiceSources: ReadonlyMap<string, ModelCatalogUserChoiceSource[]>,
  normalizedDefaultModel: string | undefined,
  recommendedRanks: ReadonlyMap<string, number>,
): ModelCatalogEntry {
  const normalizedModel = { ...model, id: model.id.trim() };
  const pricing = findPricing(input, normalizedModel.id);
  const metadata = lookupModelMetadata(input.providerType, normalizedModel.id);
  const recommendedRank = recommendedRanks.get(normalizedModel.id);
  const contextWindow = normalizedModel.contextWindow ?? metadata.contextWindow;
  const inputLimit = normalizedModel.inputLimit ?? metadata.inputLimit;
  const maxOutputTokens = normalizedModel.maxOutputTokens ?? metadata.maxOutputTokens;
  const description = normalizedModel.description ?? metadata.description;
  const knowledgeCutoff = normalizedModel.knowledgeCutoff ?? metadata.knowledgeCutoff;
  const structuredOutput = normalizedModel.structuredOutput ?? metadata.structuredOutput;
  const lastUpdated = normalizedModel.lastUpdated ?? metadata.lastUpdated;
  const modalities = normalizedModel.modalities ?? metadata.modalities;
  const capabilities = mergeCapabilities(normalizedModel.capabilities, metadata.capabilities);
  // `modalities` too, not just `capabilities`: both are merged from the
  // provider row and the bundled metadata a few lines up, and the chat guard
  // reads the modality. Passing the unmerged `normalizedModel.modalities`
  // meant a bundled image-only model reached the guard with no output
  // declaration at all.
  const unavailableReason = deriveModelUnavailableReason(input, {
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
    capabilitySource: normalizedModel.capabilities
      ? source
      : metadata.capabilities
        ? 'static_catalog'
        : 'unknown',
    unavailableReason,
    availability: availabilityOf(unavailableReason),
    canUseAsChatDefault: canUseUnavailableReasonAsDefault(unavailableReason),
    isDefault: normalizedModel.id === normalizedDefaultModel,
    capabilities: normalizeCapabilities(capabilities),
    lifecycle: metadata.lifecycle ?? 'unknown',
    ...(recommendedRank ? { recommendedRank } : {}),
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
      sources: provenanceSources(
        input,
        normalizedModel.id,
        source,
        savedChoiceSources,
        normalizedDefaultModel,
      ),
    },
  };
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
  };
}

function makeMissingDefaultEntry(
  input: BuildModelCatalogInput,
  id: string,
  modelSource: ModelDiscoverySource,
  inventory: ConnectionModelInventory,
  savedChoiceSources: ReadonlyMap<string, ModelCatalogUserChoiceSource[]>,
  normalizedDefaultModel: string | undefined,
  recommendedRanks: ReadonlyMap<string, number>,
): ModelCatalogEntry {
  const unavailableReason = missingEntryUnavailableReason(input, inventory);
  const metadata = lookupModelMetadata(input.providerType, id);
  const recommendedRank = recommendedRanks.get(id);
  return {
    id,
    ...displayNameForKnownModel(input.providerType, id),
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
    providerType: input.providerType,
    ...(input.connectionSlug ? { connectionSlug: input.connectionSlug } : {}),
    source: 'unknown',
    capabilitySource: metadata.capabilities ? 'static_catalog' : 'unknown',
    unavailableReason,
    availability: availabilityOf(unavailableReason),
    canUseAsChatDefault: canUseUnavailableReasonAsDefault(unavailableReason),
    isDefault: true,
    capabilities: normalizeCapabilities(metadata.capabilities),
    lifecycle: metadata.lifecycle ?? 'unknown',
    ...(recommendedRank ? { recommendedRank } : {}),
    ...(metadata.docsUrl ? { docsUrl: metadata.docsUrl } : {}),
    ...(metadata.contextWindow !== undefined ? { contextWindow: metadata.contextWindow } : {}),
    ...(metadata.inputLimit !== undefined ? { inputLimit: metadata.inputLimit } : {}),
    ...(metadata.maxOutputTokens !== undefined
      ? { maxOutputTokens: metadata.maxOutputTokens }
      : {}),
    ...(metadata.knowledgeCutoff !== undefined
      ? { knowledgeCutoff: metadata.knowledgeCutoff }
      : {}),
    ...(metadata.structuredOutput !== undefined
      ? { structuredOutput: metadata.structuredOutput }
      : {}),
    ...(metadata.lastUpdated !== undefined ? { lastUpdated: metadata.lastUpdated } : {}),
    ...(metadata.modalities !== undefined ? { modalities: metadata.modalities } : {}),
    provenance: {
      modelSource,
      ...(input.modelsFetchedAt ? { modelsFetchedAt: input.modelsFetchedAt } : {}),
      sources: provenanceSources(input, id, 'unknown', savedChoiceSources, normalizedDefaultModel),
    },
  };
}

function makeMissingUserChoiceEntry(
  input: BuildModelCatalogInput,
  id: string,
  modelSource: ModelDiscoverySource,
  inventory: ConnectionModelInventory,
  savedChoiceSources: ReadonlyMap<string, ModelCatalogUserChoiceSource[]>,
  normalizedDefaultModel: string | undefined,
  recommendedRanks: ReadonlyMap<string, number>,
): ModelCatalogEntry {
  const unavailableReason = missingEntryUnavailableReason(input, inventory);
  const metadata = lookupModelMetadata(input.providerType, id);
  const recommendedRank = recommendedRanks.get(id);
  return {
    id,
    ...displayNameForKnownModel(input.providerType, id),
    ...(metadata.description !== undefined ? { description: metadata.description } : {}),
    providerType: input.providerType,
    ...(input.connectionSlug ? { connectionSlug: input.connectionSlug } : {}),
    source: 'unknown',
    capabilitySource: metadata.capabilities ? 'static_catalog' : 'unknown',
    unavailableReason,
    availability: availabilityOf(unavailableReason),
    canUseAsChatDefault: canUseUnavailableReasonAsDefault(unavailableReason),
    isDefault: id === normalizedDefaultModel,
    capabilities: normalizeCapabilities(metadata.capabilities),
    lifecycle: metadata.lifecycle ?? 'unknown',
    ...(recommendedRank ? { recommendedRank } : {}),
    ...(metadata.docsUrl ? { docsUrl: metadata.docsUrl } : {}),
    ...(metadata.contextWindow !== undefined ? { contextWindow: metadata.contextWindow } : {}),
    ...(metadata.inputLimit !== undefined ? { inputLimit: metadata.inputLimit } : {}),
    ...(metadata.maxOutputTokens !== undefined
      ? { maxOutputTokens: metadata.maxOutputTokens }
      : {}),
    ...(metadata.knowledgeCutoff !== undefined
      ? { knowledgeCutoff: metadata.knowledgeCutoff }
      : {}),
    ...(metadata.structuredOutput !== undefined
      ? { structuredOutput: metadata.structuredOutput }
      : {}),
    ...(metadata.lastUpdated !== undefined ? { lastUpdated: metadata.lastUpdated } : {}),
    ...(metadata.modalities !== undefined ? { modalities: metadata.modalities } : {}),
    provenance: {
      modelSource,
      ...(input.modelsFetchedAt ? { modelsFetchedAt: input.modelsFetchedAt } : {}),
      userChoice: true,
      sources: provenanceSources(input, id, 'unknown', savedChoiceSources, normalizedDefaultModel),
    },
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

function provenanceSources(
  input: Pick<BuildModelCatalogInput, 'providerType'>,
  id: string,
  source: ModelCatalogEntry['source'],
  savedChoiceSources: ReadonlyMap<string, ModelCatalogUserChoiceSource[]>,
  normalizedDefaultModel: string | undefined,
): ModelCatalogProvenanceSources {
  const userChoice = userChoiceSources(id, savedChoiceSources, normalizedDefaultModel);
  return {
    ...(source === 'provider_api' ? { providerInventory: true as const } : {}),
    ...(source === 'static_catalog' || hasModelMetadata(input.providerType, id)
      ? { staticCatalog: true as const }
      : {}),
    ...(userChoice.length > 0 ? { userChoice } : {}),
  };
}

function recommendedRanksForProvider(
  providerType: ProviderType,
  fallbackModels: readonly string[] | undefined,
): Map<string, number> {
  const ids = curatedCatalogFallbackModelsForProvider(providerType) ?? fallbackModels ?? [];
  const result = new Map<string, number>();
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || result.has(trimmed)) continue;
    result.set(trimmed, result.size + 1);
  }
  return result;
}

function userChoiceSources(
  id: string,
  savedChoiceSources: ReadonlyMap<string, ModelCatalogUserChoiceSource[]>,
  normalizedDefaultModel: string | undefined,
): ModelCatalogUserChoiceSource[] {
  const sources: ModelCatalogUserChoiceSource[] = [];
  if (id === normalizedDefaultModel) sources.push('connection_default');
  for (const source of savedChoiceSources.get(id) ?? []) {
    if (!sources.includes(source)) sources.push(source);
  }
  return sources;
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
  };
}

function availabilityOf(reason: ModelUnavailableReason): ModelCatalogAvailability {
  if (reason === 'none') return 'available';
  // `stale` and `not_in_live_list` are both things worth saying and neither is
  // a fact about what the account can run. A provider that did not mention a
  // model in its last response has not refused it; only the provider itself
  // can do that, when the request goes out (#1584).
  if (reason === 'stale' || reason === 'not_in_live_list') return 'warning';
  return 'blocked';
}

function canUseUnavailableReasonAsDefault(reason: ModelUnavailableReason): boolean {
  return reason === 'none' || reason === 'stale' || reason === 'not_in_live_list';
}

function savedChoiceSourcesById(
  choices: Iterable<SavedModelChoice | undefined | null> | undefined,
): Map<string, ModelCatalogUserChoiceSource[]> {
  const result = new Map<string, ModelCatalogUserChoiceSource[]>();
  if (!choices) return result;
  for (const choice of choices) {
    if (!choice) continue;
    const id = typeof choice === 'string' ? choice.trim() : choice.id.trim();
    if (!id) continue;
    const source = typeof choice === 'string' ? 'saved_model' : choice.source;
    const sources = result.get(id) ?? [];
    if (!sources.includes(source)) sources.push(source);
    result.set(id, sources);
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
