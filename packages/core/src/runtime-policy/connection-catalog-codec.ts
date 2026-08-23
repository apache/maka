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

import {
  isRelayProviderType,
  PROVIDER_DEFAULTS,
  providerDefaultsOf,
  validateSlug,
  type ProviderType,
} from '../llm-connections.js';
import {
  DECLARABLE_RELAY_THINKING_LEVELS,
  isThinkingLevel,
  type RelayModelProfile,
  type ThinkingLevel,
} from '../model-thinking.js';
import type {
  ConnectionCatalogEntry,
  ConnectionCatalogEntryDraft,
  ConnectionCatalogEntryUpdate,
  ConnectionModel,
  ConnectionModelDiscoveryResult,
  ConnectionTarget,
  ConnectionTestSummary,
  ConnectionVersionBasis,
  CreateCatalogConnectionInput,
  RemoveCatalogConnectionInput,
  SetDefaultConnectionTargetInput,
  UpdateCatalogConnectionInput,
} from '../runtime-policy.js';
import {
  normalizeOptionalRequestBodyOverlay,
  RequestCustomizationValidationError,
  type JsonObject,
} from '../request-customization.js';
import {
  assertCanonicalValue,
  booleanValue,
  domainError,
  entityIdValue,
  exactRecord,
  integerValue,
  nonEmptyStringValue,
  positiveRevisionValue,
  revisionValue,
  stringValue,
} from './domain-codec.js';

export const CONNECTION_CATALOG_MAX_CONNECTIONS = 1_024;
export const CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION = 2_048;
export const CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS = 512;
export const CONNECTION_NAME_MAX_LENGTH = 256;
export const CONNECTION_MODEL_ID_MAX_LENGTH = 512;

export function normalizeCreateCatalogConnectionInput(
  value: unknown,
): CreateCatalogConnectionInput {
  const input = exactRecord(value, 'create connection input', [
    'expectedCatalogRevision',
    'connection',
  ]);
  return {
    expectedCatalogRevision: revisionValue(
      input.expectedCatalogRevision,
      'create connection expected catalog revision',
    ),
    connection: normalizeConnectionCatalogEntryDraft(input.connection),
  };
}

export function normalizeUpdateCatalogConnectionInput(
  value: unknown,
): UpdateCatalogConnectionInput {
  const input = exactRecord(value, 'update connection input', ['expected', 'changes']);
  return {
    expected: decodeConnectionVersionBasis(input.expected),
    changes: normalizeConnectionCatalogEntryUpdate(input.changes),
  };
}

export function normalizeRemoveCatalogConnectionInput(
  value: unknown,
): RemoveCatalogConnectionInput {
  const input = exactRecord(value, 'remove connection input', ['expected']);
  return { expected: decodeConnectionVersionBasis(input.expected) };
}

export function normalizeSetDefaultConnectionTargetInput(
  value: unknown,
): SetDefaultConnectionTargetInput {
  const input = exactRecord(value, 'set default target input', [
    'expectedCatalogRevision',
    'target',
  ]);
  return {
    expectedCatalogRevision: revisionValue(
      input.expectedCatalogRevision,
      'set default target expected catalog revision',
    ),
    target: input.target === null ? null : decodeConnectionTarget(input.target),
  };
}

export function normalizeConnectionCatalogEntryDraft(value: unknown): ConnectionCatalogEntryDraft {
  const item = exactRecord(
    value,
    'connection draft',
    [
      'slug',
      'name',
      'providerType',
      'baseUrl',
      'enabled',
      'enabledModelIds',
      'relayModelProfiles',
      'requestBodyOverlay',
    ],
    ['slug', 'name', 'providerType', 'enabled', 'enabledModelIds'],
  );
  const providerType = decodeProviderType(item.providerType);
  const baseUrl = normalizeCatalogConnectionBaseUrl(item.baseUrl, providerType);
  const enabledModelIds = decodeConnectionModelIds(item.enabledModelIds);
  const requestBodyOverlay =
    item.requestBodyOverlay === undefined
      ? undefined
      : decodeRequestBodyOverlay(item.requestBodyOverlay);
  const profiles =
    item.relayModelProfiles === undefined
      ? {}
      : nonEmptyRelayProfiles(item.relayModelProfiles, enabledModelIds);
  assertProfileFieldsFitProvider(profiles.relayModelProfiles, providerType);
  return {
    slug: decodeConnectionSlug(item.slug),
    name: decodeConnectionName(item.name),
    providerType,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    enabled: booleanValue(item.enabled, 'connection enabled'),
    enabledModelIds,
    ...profiles,
    ...(requestBodyOverlay === undefined ? {} : { requestBodyOverlay }),
  };
}

export function normalizeConnectionCatalogEntryUpdate(
  value: unknown,
): ConnectionCatalogEntryUpdate {
  const item = exactRecord(
    value,
    'connection update',
    ['name', 'baseUrl', 'enabled', 'enabledModelIds', 'relayModelProfiles', 'requestBodyOverlay'],
    ['name', 'enabled', 'enabledModelIds'],
  );
  const baseUrl = normalizeCatalogConnectionBaseUrl(item.baseUrl);
  const enabledModelIds = decodeConnectionModelIds(item.enabledModelIds);
  const requestBodyOverlay =
    item.requestBodyOverlay === undefined
      ? undefined
      : item.requestBodyOverlay === null
        ? null
        : (decodeRequestBodyOverlay(item.requestBodyOverlay) ?? null);
  // Tri-state profile instruction: an absent key stays absent (untouched),
  // null clears, a table replaces. An absent key must never materialize into
  // a clear — profile-blind writers omit the key by definition.
  return {
    name: decodeConnectionName(item.name),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    enabled: booleanValue(item.enabled, 'connection enabled'),
    enabledModelIds,
    ...(item.relayModelProfiles === undefined
      ? {}
      : profilesUpdateInstruction(item.relayModelProfiles, enabledModelIds)),
    ...(requestBodyOverlay === undefined ? {} : { requestBodyOverlay }),
  };
}

function profilesUpdateInstruction(
  value: unknown,
  enabledModelIds: readonly string[],
): { readonly relayModelProfiles: Readonly<Record<string, RelayModelProfile>> | null } {
  return {
    relayModelProfiles:
      value === null
        ? null
        : (nonEmptyRelayProfiles(value, enabledModelIds).relayModelProfiles ?? null),
  };
}

export function normalizeConnectionCatalogEntryUpdateForProvider(
  value: unknown,
  providerType: ProviderType,
): ConnectionCatalogEntryUpdate {
  const update = normalizeConnectionCatalogEntryUpdate(value);
  const baseUrl = normalizeCatalogConnectionBaseUrl(update.baseUrl, providerType);
  assertProfileFieldsFitProvider(update.relayModelProfiles, providerType);
  return {
    name: update.name,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    enabled: update.enabled,
    enabledModelIds: update.enabledModelIds,
    ...(update.relayModelProfiles === undefined
      ? {}
      : { relayModelProfiles: update.relayModelProfiles }),
    ...(update.requestBodyOverlay === undefined
      ? {}
      : { requestBodyOverlay: update.requestBodyOverlay }),
  };
}

/**
 * The relay profiles carried by catalog entries, keyed by model id. Strict
 * on purpose: writers (the settings UI) emit already-normalized tables, so
 * anything malformed here is a corrupt document or a foreign writer, and
 * the catalog fails loudly the way every exactRecord does. Profiles are
 * scoped to `enabledModelIds` — the store prunes them when the selection
 * changes, so a key outside the set marks a document the store never wrote.
 */
export function decodeRelayModelProfilesTable(
  value: unknown,
  enabledModelIds: readonly string[],
): Readonly<Record<string, RelayModelProfile>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw domainError('connection relay model profiles must be a record');
  }
  // fromEntries, not `table[modelId] = declared` on a `{}`: model ids are
  // arbitrary relay-supplied strings, and a literal `obj['__proto__'] = x`
  // assignment poisons the prototype instead of creating an own key — the
  // entry would then vanish from Object.entries and JSON.stringify (silent
  // data loss on the persistence roundtrip). fromEntries defines every key
  // as an own data property.
  const parsed: [string, RelayModelProfile][] = [];
  for (const [modelId, rawEntry] of Object.entries(value)) {
    decodeConnectionModelId(modelId);
    if (!enabledModelIds.includes(modelId)) {
      throw domainError(`relay model profile for ${modelId} is not an enabled model`);
    }
    const entry = exactRecord(
      rawEntry,
      `relay model profile for ${modelId}`,
      ['thinkingLevels', 'vision', 'contextWindow', 'serviceTier'],
      [],
    );
    const declared: {
      thinkingLevels?: readonly ThinkingLevel[];
      vision?: boolean;
      contextWindow?: number;
      serviceTier?: 'fast';
    } = {};
    if (entry.thinkingLevels !== undefined) {
      if (!Array.isArray(entry.thinkingLevels) || entry.thinkingLevels.length === 0) {
        throw domainError(`declared thinking levels for ${modelId} must be a non-empty array`);
      }
      if (new Set(entry.thinkingLevels).size !== entry.thinkingLevels.length) {
        throw domainError(`declared thinking levels for ${modelId} must not repeat`);
      }
      for (const level of entry.thinkingLevels) {
        if (
          !isThinkingLevel(level) ||
          !(DECLARABLE_RELAY_THINKING_LEVELS as readonly ThinkingLevel[]).includes(level)
        ) {
          // Not just "unknown": 'off' is a disable-wire encoding, not an
          // intensity tier, and no declaration may carry it (normalize drops
          // it at write; a persisted table containing it is foreign/corrupt).
          throw domainError(`declared thinking level for ${modelId} is not declarable`);
        }
      }
      declared.thinkingLevels = [...entry.thinkingLevels] as ThinkingLevel[];
    }
    if (entry.vision !== undefined) {
      declared.vision = booleanValue(entry.vision, `declared vision for ${modelId}`);
    }
    if (entry.contextWindow !== undefined) {
      declared.contextWindow = integerValue(
        entry.contextWindow,
        `declared context window for ${modelId}`,
        1,
        Number.MAX_SAFE_INTEGER,
      );
    }
    if (entry.serviceTier !== undefined) {
      if (entry.serviceTier !== 'fast') {
        throw domainError(`declared service tier for ${modelId} must be fast`);
      }
      declared.serviceTier = 'fast';
    }
    if (Object.keys(declared).length === 0) {
      throw domainError(`relay model profile for ${modelId} declares nothing`);
    }
    parsed.push([modelId, declared]);
  }
  return Object.fromEntries(parsed);
}

/**
 * Which declarations a provider can actually carry.
 *
 * `contextWindow` and `vision` state facts about a model. A user has them when
 * Maka does not — a model newer than the bundled snapshot, or any model on a
 * provider with no model-list endpoint — and that need is not confined to
 * relays (#1584), so they are legal everywhere.
 *
 * `thinkingLevels` and `serviceTier` name a wire feature instead. They encode
 * into request shapes only the OpenAI-compatible relays accept —
 * `reasoning_effort` tiers and priority processing — and
 * `supportsRelayFastServiceTier` gates the read side by provider for the same
 * reason. A table carrying them on another provider describes a request Maka
 * would never send: dead state at best, and on a provider whose wire rejects
 * the unknown value, a 400 the user cannot explain.
 */
function assertProfileFieldsFitProvider(
  profiles: Readonly<Record<string, RelayModelProfile>> | null | undefined,
  providerType: ProviderType,
): void {
  if (!profiles || isRelayProviderType(providerType)) return;
  for (const [modelId, profile] of Object.entries(profiles)) {
    if (profile.thinkingLevels !== undefined) {
      throw domainError(
        `declared thinking levels for ${modelId} require an OpenAI-compatible connection`,
      );
    }
    if (profile.serviceTier !== undefined) {
      throw domainError(
        `declared service tier for ${modelId} requires an OpenAI-compatible connection`,
      );
    }
  }
}

// An empty table is not a state worth storing: drafts/canonical entries omit
// the key, and updates treat it as the same instruction as `null` (clear).
function nonEmptyRelayProfiles(
  value: unknown,
  enabledModelIds: readonly string[],
): {
  readonly relayModelProfiles?: Readonly<Record<string, RelayModelProfile>>;
} {
  const table = decodeRelayModelProfilesTable(value, enabledModelIds);
  return Object.keys(table).length > 0 ? { relayModelProfiles: table } : {};
}

export function decodeCanonicalConnectionCatalogEntry(value: unknown): ConnectionCatalogEntry {
  const item = exactRecord(
    value,
    'connection catalog entry',
    [
      'connectionId',
      'revision',
      'slug',
      'name',
      'providerType',
      'baseUrl',
      'enabled',
      'enabledModelIds',
      'relayModelProfiles',
      'requestBodyOverlay',
      'models',
      'modelSource',
      'modelsFetchedAt',
      'lastTest',
    ],
    [
      'connectionId',
      'revision',
      'slug',
      'name',
      'providerType',
      'enabled',
      'enabledModelIds',
      'models',
    ],
  );
  const draft = normalizeConnectionCatalogEntryDraft({
    slug: item.slug,
    name: item.name,
    providerType: item.providerType,
    ...(item.baseUrl === undefined ? {} : { baseUrl: item.baseUrl }),
    enabled: item.enabled,
    enabledModelIds: item.enabledModelIds,
    ...(item.relayModelProfiles === undefined
      ? {}
      : { relayModelProfiles: item.relayModelProfiles }),
    ...(item.requestBodyOverlay === undefined
      ? {}
      : { requestBodyOverlay: item.requestBodyOverlay }),
  });
  if (
    !Array.isArray(item.models) ||
    item.models.length > CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION
  ) {
    throw domainError('connection models must be a bounded array');
  }
  const models = item.models.map(decodeConnectionModel);
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw domainError('connection model ids must be unique');
  }
  if (
    item.modelSource !== undefined &&
    item.modelSource !== 'fetched' &&
    item.modelSource !== 'fallback'
  ) {
    throw domainError('connection model source is invalid');
  }
  if ((item.modelSource === undefined) !== (item.modelsFetchedAt === undefined)) {
    throw domainError('connection model source and fetched time must occur together');
  }
  if (item.modelSource === undefined && models.length > 0) {
    throw domainError('connection models must be empty before model discovery');
  }
  const decoded: ConnectionCatalogEntry = {
    ...draft,
    connectionId: entityIdValue(item.connectionId, 'connection id'),
    revision: positiveRevisionValue(item.revision, 'connection revision'),
    models,
    ...(item.modelSource === undefined ? {} : { modelSource: item.modelSource }),
    ...(item.modelsFetchedAt === undefined
      ? {}
      : {
          modelsFetchedAt: integerValue(
            item.modelsFetchedAt,
            'models fetched at',
            0,
            Number.MAX_SAFE_INTEGER,
          ),
        }),
    ...(item.lastTest === undefined
      ? {}
      : { lastTest: decodeConnectionTestSummary(item.lastTest) }),
  };
  assertCanonicalValue(value, decoded, 'connection catalog entry');
  return decoded;
}

export function decodeConnectionVersionBasis(value: unknown): ConnectionVersionBasis {
  const item = exactRecord(value, 'connection basis', ['connectionId', 'revision']);
  return {
    connectionId: entityIdValue(item.connectionId, 'connection id'),
    revision: positiveRevisionValue(item.revision, 'connection revision'),
  };
}

export function decodeConnectionTarget(value: unknown): ConnectionTarget {
  const item = exactRecord(value, 'connection target', ['connectionId', 'modelId']);
  return {
    connectionId: entityIdValue(item.connectionId, 'connection id'),
    modelId: decodeConnectionModelId(item.modelId),
  };
}

export function decodeConnectionModel(value: unknown): ConnectionModel {
  const item = exactRecord(
    value,
    'connection model',
    ['id', 'displayName', 'apiProtocol', 'contextWindow', 'maxOutputTokens', 'capabilities'],
    ['id'],
  );
  if (
    item.apiProtocol !== undefined &&
    item.apiProtocol !== 'openai-chat' &&
    item.apiProtocol !== 'openai-responses' &&
    item.apiProtocol !== 'anthropic-messages'
  ) {
    throw domainError('connection model API protocol is invalid');
  }
  let capabilities: ConnectionModel['capabilities'];
  if (item.capabilities !== undefined) {
    const raw = exactRecord(
      item.capabilities,
      'connection model capabilities',
      ['chat', 'vision', 'reasoning', 'functionCalling', 'imageGeneration', 'webSearch'],
      [],
    );
    capabilities = {};
    for (const key of Object.keys(raw)) {
      (capabilities as Record<string, boolean>)[key] = booleanValue(
        raw[key],
        `connection model capability ${key}`,
      );
    }
  }
  return {
    id: decodeConnectionModelId(item.id),
    ...(item.displayName === undefined
      ? {}
      : { displayName: stringValue(item.displayName, 'model display name', 512) }),
    ...(item.apiProtocol === undefined ? {} : { apiProtocol: item.apiProtocol }),
    ...(item.contextWindow === undefined
      ? {}
      : {
          contextWindow: integerValue(
            item.contextWindow,
            'model context window',
            1,
            Number.MAX_SAFE_INTEGER,
          ),
        }),
    ...(item.maxOutputTokens === undefined
      ? {}
      : {
          maxOutputTokens: integerValue(
            item.maxOutputTokens,
            'model max output tokens',
            1,
            Number.MAX_SAFE_INTEGER,
          ),
        }),
    ...(capabilities === undefined ? {} : { capabilities }),
  };
}

export function decodeConnectionTestSummary(value: unknown): ConnectionTestSummary {
  const item = exactRecord(
    value,
    'connection test summary',
    ['status', 'checkedAt', 'errorClass'],
    ['status', 'checkedAt'],
  );
  if (item.status !== 'verified' && item.status !== 'needs_reauth' && item.status !== 'error') {
    throw domainError('connection test status is invalid');
  }
  if (
    item.errorClass !== undefined &&
    item.errorClass !== 'auth' &&
    item.errorClass !== 'timeout' &&
    item.errorClass !== 'provider_unavailable' &&
    item.errorClass !== 'network' &&
    item.errorClass !== 'unknown'
  ) {
    throw domainError('connection test error class is invalid');
  }
  return {
    status: item.status,
    checkedAt: nonEmptyStringValue(item.checkedAt, 'connection test checkedAt', 128),
    ...(item.errorClass === undefined ? {} : { errorClass: item.errorClass }),
  };
}

export function normalizeConnectionModelDiscoveryResult(
  value: unknown,
): ConnectionModelDiscoveryResult {
  const item = exactRecord(value, 'model discovery result', ['models', 'source', 'fetchedAt']);
  if (
    !Array.isArray(item.models) ||
    item.models.length > CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION
  ) {
    throw domainError('model discovery models must be a bounded array');
  }
  const models = item.models.map(decodeConnectionModel);
  if (new Set(models.map((model) => model.id)).size !== models.length) {
    throw domainError('model discovery model ids must be unique');
  }
  if (item.source !== 'fetched' && item.source !== 'fallback') {
    throw domainError('model discovery source is invalid');
  }
  return {
    models,
    source: item.source,
    fetchedAt: integerValue(
      item.fetchedAt,
      'model discovery fetchedAt',
      0,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

export function decodeConnectionSlug(value: unknown): string {
  if (typeof value !== 'string') throw domainError('connection slug must be a string');
  const error = validateSlug(value);
  if (error) throw domainError(`connection slug: ${error}`);
  return value;
}

export function decodeConnectionName(value: unknown): string {
  return stringValue(value, 'connection name', CONNECTION_NAME_MAX_LENGTH);
}

function decodeRequestBodyOverlay(value: unknown): JsonObject | undefined {
  try {
    return normalizeOptionalRequestBodyOverlay(value);
  } catch (error) {
    if (error instanceof RequestCustomizationValidationError) {
      throw domainError(error.message);
    }
    throw error;
  }
}

export function decodeConnectionModelId(value: unknown): string {
  return nonEmptyStringValue(value, 'model id', CONNECTION_MODEL_ID_MAX_LENGTH);
}

function decodeConnectionModelIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > CONNECTION_CATALOG_MAX_ENABLED_MODEL_IDS) {
    throw domainError('enabled model ids must be a bounded array');
  }
  const modelIds = value.map(decodeConnectionModelId);
  if (new Set(modelIds).size !== modelIds.length) {
    throw domainError('enabled model ids must be unique');
  }
  return modelIds;
}

export function decodeProviderType(value: unknown): ProviderType {
  if (typeof value !== 'string' || providerDefaultsOf(value) === undefined) {
    throw domainError('connection provider type is not registered');
  }
  return value as ProviderType;
}

export function normalizeCatalogConnectionBaseUrl(
  value: unknown,
  providerType?: ProviderType,
): string | undefined {
  if (value === undefined) return undefined;
  const raw = stringValue(value, 'connection base URL', 2_048);
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw domainError('connection base URL must be a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw domainError('connection base URL must use http or https');
  }
  if (parsed.username || parsed.password) {
    throw domainError('connection base URL must not contain credentials');
  }
  if (trimmed.includes('?') || trimmed.includes('#')) {
    throw domainError('connection base URL must not contain a query or fragment');
  }
  const canonical = parsed.toString();
  if (new TextEncoder().encode(canonical).byteLength > 2_048) {
    throw domainError('connection base URL must not exceed 2048 bytes');
  }
  const providerDefault =
    providerType === undefined ? undefined : canonicalProviderBaseUrl(providerType);
  const override = canonical === providerDefault ? undefined : canonical;
  if (
    override !== undefined &&
    providerType &&
    PROVIDER_DEFAULTS[providerType].authKind === 'oauth_token'
  ) {
    throw domainError('OAuth provider endpoint cannot be overridden');
  }
  return override;
}

export function decodeCanonicalConnectionBaseUrl(
  value: unknown,
  providerType: ProviderType,
): string | undefined {
  const decoded = normalizeCatalogConnectionBaseUrl(value, providerType);
  if (value !== decoded) throw domainError('connection base URL must be canonical');
  return decoded;
}

function canonicalProviderBaseUrl(providerType: ProviderType): string | undefined {
  const raw = PROVIDER_DEFAULTS[providerType].baseUrl.trim();
  if (!raw) return undefined;
  try {
    return new URL(raw).toString();
  } catch {
    return undefined;
  }
}
