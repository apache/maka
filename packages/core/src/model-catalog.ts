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
  CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS,
  connectionEnabledModelIds,
  PROVIDER_REGISTRY,
  providerDefaultsOf,
  providerFallbackModelIds,
  providerSupportsModelDiscovery,
  type HostResolvedConnectionCatalog,
} from './llm-connections.js';
import { lookupModelMetadata, resolveModelVisionSupport } from './model-metadata.js';
import {
  relayModelProfile,
  thinkingVariantsForConnection,
  type RelayModelProfiles,
  type ThinkingLevel,
} from './model-thinking.js';

/**
 * One model as the Host resolved it for one connection.
 *
 * Every field here has a reader. The entry crosses the wire and then the
 * desktop IPC boundary, so a field nothing renders is paid for on every
 * catalog read by every attached client — and the ones that were here
 * (`providerType`, `connectionSlug`, `source`, `unavailableReason`,
 * `lifecycle`, `inputLimit`, `maxOutputTokens`, `structuredOutput`,
 * `lastUpdated`, `modalities`, `provenance`, `pricing`, and every capability
 * but vision) had none. They are not needed today; when a surface actually asks
 * for one, add it back with the reader that wants it. `makeEntry` still
 * consults all of those facts to decide `canUseAsChatDefault` — they simply
 * stop being shipped.
 *
 * `pricing` was the one that had no producer either: nothing ever passed rates
 * in, so the field, its two builder inputs and its wire decoder existed for a
 * picker that shows a rate beside a model. That picker can arrive with them.
 * Cost accounting never depended on it — `record-llm-call.ts` prices a call
 * from `pricingModelKey` when the call is recorded.
 */
export interface ModelCatalogEntry {
  id: string;
  displayName?: string;
  description?: string;
  /** False when this connection cannot hold a chat on this model. */
  canUseAsChatDefault: boolean;
  isDefault: boolean;
  /** Exact capability projection used by model-facing attachment composition. */
  supportsVision: boolean;
  /**
   * Reasoning levels this model offers on this connection, in display order;
   * empty for a non-reasoning model. Part of the entry rather than a second
   * lookup because a picker that lists a model always has to render its
   * thinking choices, and two projections of one model's facts drifted: the
   * entry's capabilities ignored the user's relay declaration that the
   * thinking projection honoured.
   */
  thinkingLevels: readonly ThinkingLevel[];
  contextWindow?: number;
  knowledgeCutoff?: string;
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
    | 'relayModelProfiles'
  >;
}

export interface BuildModelCatalogInput {
  providerType: ProviderType;
  defaultModel?: string;
  models?: ModelInfo[];
  modelSource?: ModelDiscoverySource;
  fallbackModels?: string[];
  /** A provider Maka has retired: its models list but can no longer be chosen. */
  providerRetired?: boolean;
  /** Ids the catalog must list even when no inventory describes them (#1584). */
  savedModelIds?: Iterable<string | undefined | null>;
  /** Per-model user declarations; authoritative over every catalog source. */
  relayModelProfiles?: RelayModelProfiles;
}

export function buildModelCatalogEntries(input: BuildModelCatalogInput): ModelCatalogEntry[] {
  const liveModels = input.models;
  const modelSource =
    input.modelSource ??
    (liveModels !== undefined && liveModels.length > 0 ? 'fetched' : 'fallback');
  const normalizedDefaultModel = input.defaultModel?.trim();
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
  const ctx: EntryContext = { input, normalizedDefaultModel };
  const seen = new Set<string>();
  const entries = rawModels
    .filter((model) => {
      const id = model.id.trim();
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .map((model) => makeEntry(ctx, model));

  if (normalizedDefaultModel && !seen.has(normalizedDefaultModel)) {
    entries.unshift(makeEntry(ctx, { id: normalizedDefaultModel }, { isDefault: true }));
    seen.add(normalizedDefaultModel);
  }

  for (const id of savedModelIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push(makeEntry(ctx, { id }));
  }

  return entries;
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
 * added or a baseline grown would otherwise leave a hand-written bound
 * quietly too small, which is exactly how a valid persisted catalog became
 * unencodable. Providers that do discover models substitute their fallback
 * list instead of prepending it, so they add nothing here.
 */
// What a model row may carry on the wire. The producer reads them here and the
// decoder enforces them: an over-long string caught only on arrival is one the
// catalog already built.
export const CONNECTION_MODEL_DISPLAY_NAME_MAX_LENGTH = 512;
export const CONNECTION_MODEL_DESCRIPTION_MAX_LENGTH = 2_048;

export const MAX_PREPENDED_FALLBACK_MODELS: number = Object.keys(PROVIDER_REGISTRY).reduce(
  (largest, providerType) => {
    if (providerSupportsModelDiscovery(providerType as ProviderType)) return largest;
    const defaults = providerDefaultsOf(providerType);
    if (!defaults) return largest;
    return Math.max(largest, providerFallbackModelIds(defaults).length);
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
  const fallbackModels = providerFallbackModelIds(defaults);
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
  // their metadata.
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
    defaultModel,
    models,
    modelSource: supportsModelDiscovery ? connection.modelSource : 'fallback',
    fallbackModels,
    // A retired provider's models stay listed so an existing connection still
    // renders, but they stop being selectable. Without this the pickers would
    // keep offering models that can no longer send — `runtimeAdapter:
    // 'unavailable'` blocks the send, not the choice.
    providerRetired: defaults.retired === true,
    ...(connection.relayModelProfiles ? { relayModelProfiles: connection.relayModelProfiles } : {}),
    // Enabling a model IS a user choice — the raw array is written only by the
    // user, in connection settings — so it projects an entry even when no
    // catalog describes the id. Without this a model the user enabled on a
    // provider whose `models` is a release snapshot vanished from every picker
    // (#1584), and fixing it at one call site left the others broken. The raw
    // array, not `connectionEnabledModelIds`: that one folds in `defaultModel`,
    // which the builder already lists on its own.
    savedModelIds: (connection.enabledModelIds ?? []).filter((id) => !broken.has(id)),
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
  T extends Pick<LlmConnection, 'providerType' | 'models' | 'defaultModel' | 'enabledModelIds'>,
>(connection: T): T {
  if (connection.providerType !== 'openai-codex') return connection;
  const fallbackModels = providerFallbackModelIds(PROVIDER_REGISTRY['openai-codex']);
  const safeModels = (connection.models ?? []).filter(
    (entry) => entry.id && !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(entry.id),
  );
  const models = safeModels.length ? safeModels : fallbackModels.map((id) => ({ id }));
  // The stored selection is filtered by the same rule as the inventory. An id
  // this subscription cannot serve was picker-visible once, so it is still in
  // `enabledModelIds` on a connection saved back then; leaving it there put it
  // back into the catalog as a model no inventory lists — selectable, and
  // failing at the provider when a scheduled run finally sent to it.
  const servableEnabledModelIds = connection.enabledModelIds?.filter(
    (id) => !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(id),
  );
  const enabledModelIds =
    servableEnabledModelIds?.length === connection.enabledModelIds?.length
      ? connection.enabledModelIds
      : servableEnabledModelIds;
  const listedModelIds = new Set(models.map((entry) => entry.id));
  const defaultModel =
    connection.defaultModel &&
    !CODEX_SUBSCRIPTION_UNSUPPORTED_CHATGPT_MODELS.has(connection.defaultModel) &&
    listedModelIds.has(connection.defaultModel)
      ? connection.defaultModel
      : (models[0]?.id ?? fallbackModels[0] ?? connection.defaultModel);
  if (
    models === connection.models &&
    defaultModel === connection.defaultModel &&
    enabledModelIds === connection.enabledModelIds
  ) {
    return connection;
  }
  return { ...connection, defaultModel, models, enabledModelIds };
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

/** A connection editor's unsaved model state. */
export interface ConnectionModelDraft {
  readonly models: readonly ModelInfo[];
  readonly modelSource: ModelDiscoverySource;
  readonly enabledModelIds: readonly string[];
}

/**
 * The catalog to show for a connection being edited.
 *
 * While the draft still matches what is committed, the Host has already
 * resolved this exact connection and its entries are the answer. Resolving
 * again against a client's own bundled metadata would replace a possibly
 * newer Host's display names and eligibility decisions with local guesses —
 * the disagreement the projection exists to end.
 *
 * The other branch is the client-side resolution an editor legitimately needs:
 * once the draft diverges — model rows just fetched, ids just ticked — it
 * describes a connection the Host has never been told about and so cannot
 * have resolved.
 */
export function resolveDraftConnectionModelCatalog(
  connection: BuildConnectionModelCatalogInput['connection'] & HostResolvedConnectionCatalog,
  draft: ConnectionModelDraft,
): readonly ModelCatalogEntry[] {
  if (draftMatchesConnection(connection, draft)) return connection.catalogEntries;
  return resolveConnectionModelCatalog({
    ...connection,
    enabledModelIds: [...draft.enabledModelIds],
    models:
      draft.modelSource === 'fetched' || draft.models.length > 0 ? [...draft.models] : undefined,
    modelSource: draft.modelSource,
  });
}

function draftMatchesConnection(
  connection: Pick<LlmConnection, 'defaultModel' | 'enabledModelIds' | 'models' | 'modelSource'>,
  draft: ConnectionModelDraft,
): boolean {
  if (draft.modelSource !== (connection.modelSource ?? 'fallback')) return false;
  const enabled = connectionEnabledModelIds(connection);
  if (draft.enabledModelIds.length !== enabled.length) return false;
  if (draft.enabledModelIds.some((id, index) => id !== enabled[index])) return false;
  return modelRowsEqual(draft.models, connection.models ?? []);
}

/**
 * Every stored field `makeEntry` reads, and only those. Comparing ids alone
 * would keep showing the Host's entries for rows the user just re-fetched,
 * whose facts may differ under the same id; comparing fields no entry is built
 * from would throw the Host's entries away over a change nothing can render.
 */
export function modelRowsEqual(left: readonly ModelInfo[], right: readonly ModelInfo[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((model, index) => {
    const other = right[index];
    return (
      model.id === other.id &&
      model.displayName === other.displayName &&
      model.description === other.description &&
      model.contextWindow === other.contextWindow &&
      model.knowledgeCutoff === other.knowledgeCutoff &&
      modalitiesEqual(model.modalities, other.modalities) &&
      model.capabilities?.chat === other.capabilities?.chat &&
      model.capabilities?.vision === other.capabilities?.vision &&
      model.capabilities?.reasoning === other.capabilities?.reasoning &&
      model.capabilities?.functionCalling === other.capabilities?.functionCalling &&
      model.capabilities?.imageGeneration === other.capabilities?.imageGeneration
    );
  });
}

function modalitiesEqual(left: ModelInfo['modalities'], right: ModelInfo['modalities']): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.input.length === right.input.length &&
    left.input.every((value, index) => value === right.input[index]) &&
    left.output.length === right.output.length &&
    left.output.every((value, index) => value === right.output[index])
  );
}

/**
 * The per-build facts every entry in one catalog shares. Threading them as one
 * value keeps the entry builders' remaining parameters to what actually varies
 * between an entry and its neighbours.
 */
interface EntryContext {
  readonly input: BuildModelCatalogInput;
  readonly normalizedDefaultModel: string | undefined;
}

/** The one fact an entry cannot derive: a missing default is default by construction. */
interface EntryOverrides {
  readonly isDefault?: boolean;
}

/**
 * One entry, from a model row or from a bare id no inventory describes. The
 * bare-id case is the same construction: every field then resolves from the
 * bundled metadata alone, which is what those entries carried when they were
 * built by a separate function.
 */
function makeEntry(
  ctx: EntryContext,
  model: ModelInfo,
  overrides: EntryOverrides = {},
): ModelCatalogEntry {
  const { input, normalizedDefaultModel } = ctx;
  const normalizedModel = { ...model, id: model.id.trim() };
  const metadata = lookupModelMetadata(input.providerType, normalizedModel.id);
  const contextWindow = normalizedModel.contextWindow ?? metadata.contextWindow;
  const description = normalizedModel.description ?? metadata.description;
  const knowledgeCutoff = normalizedModel.knowledgeCutoff ?? metadata.knowledgeCutoff;
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
  // Retirement and an explicit "cannot chat" are the only two vetoes. Absence
  // from a live list is NOT one: a provider that did not mention a model has
  // not refused it, and only the provider can refuse, when the request goes
  // out (#1584). So an id the user enabled that no inventory describes stays
  // selectable, and reaches here as a bare row whose metadata says nothing.
  const canUseAsChatDefault =
    input.providerRetired !== true &&
    !isModelExplicitlyUnsupportedForChat({
      ...normalizedModel,
      capabilities,
      ...(modalities !== undefined ? { modalities } : {}),
    });
  return {
    id: normalizedModel.id,
    ...displayNameForModel(input.providerType, normalizedModel),
    ...(description !== undefined
      ? { description: withinWireLimit(description, CONNECTION_MODEL_DESCRIPTION_MAX_LENGTH) }
      : {}),
    canUseAsChatDefault,
    isDefault: overrides.isDefault ?? normalizedModel.id === normalizedDefaultModel,
    supportsVision: capabilities.vision === true,
    thinkingLevels: thinkingVariantsForConnection(thinkingContext, normalizedModel.id),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(knowledgeCutoff !== undefined ? { knowledgeCutoff } : {}),
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
    webSearch: providerCapabilities.webSearch ?? metadataCapabilities.webSearch,
  };
}

function displayNameForModel(
  providerType: ProviderType,
  model: ModelInfo,
): { displayName?: string } {
  const displayName = model.displayName?.trim();
  if (displayName && displayName !== model.id) {
    return { displayName: withinWireLimit(displayName, CONNECTION_MODEL_DISPLAY_NAME_MAX_LENGTH) };
  }
  return displayNameForKnownModel(providerType, model.id);
}

function displayNameForKnownModel(
  providerType: ProviderType,
  id: string,
): { displayName?: string } {
  const displayName = lookupModelMetadata(providerType, id).displayName;
  return displayName
    ? { displayName: withinWireLimit(displayName, CONNECTION_MODEL_DISPLAY_NAME_MAX_LENGTH) }
    : {};
}

/**
 * Entries are what the connection catalog puts on the wire, and its decoder
 * refuses an over-long string by failing the whole catalog read. Every text a
 * model row or metadata table can carry passes through here, so this is where
 * a source that grew past the bound gets cut rather than where it takes the
 * catalog down.
 */
function withinWireLimit(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : value.slice(0, maxLength);
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
 * An EMPTY list is not evidence. A provider that declared no output modality
 * and a generator bug that dropped them produce the same shape. Only a
 * non-empty list says something, and what it says is what it lists.
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

function normalizedIdSet(ids: Iterable<string | undefined | null> | undefined): Set<string> {
  const result = new Set<string>();
  for (const id of ids ?? []) {
    const trimmed = id?.trim();
    if (trimmed) result.add(trimmed);
  }
  return result;
}
