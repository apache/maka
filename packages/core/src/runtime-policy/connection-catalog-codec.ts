import { PROVIDER_DEFAULTS, validateSlug, type ProviderType } from '../llm-connections.js';
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

const PROVIDER_TYPES = new Set<string>(Object.keys(PROVIDER_DEFAULTS));

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
    ['slug', 'name', 'providerType', 'baseUrl', 'enabled', 'enabledModelIds'],
    ['slug', 'name', 'providerType', 'enabled', 'enabledModelIds'],
  );
  const providerType = decodeProviderType(item.providerType);
  const baseUrl = normalizeCatalogConnectionBaseUrl(item.baseUrl, providerType);
  return {
    slug: decodeConnectionSlug(item.slug),
    name: decodeConnectionName(item.name),
    providerType,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    enabled: booleanValue(item.enabled, 'connection enabled'),
    enabledModelIds: decodeConnectionModelIds(item.enabledModelIds),
  };
}

export function normalizeConnectionCatalogEntryUpdate(
  value: unknown,
): ConnectionCatalogEntryUpdate {
  const item = exactRecord(
    value,
    'connection update',
    ['name', 'baseUrl', 'enabled', 'enabledModelIds'],
    ['name', 'enabled', 'enabledModelIds'],
  );
  const baseUrl = normalizeCatalogConnectionBaseUrl(item.baseUrl);
  return {
    name: decodeConnectionName(item.name),
    ...(baseUrl === undefined ? {} : { baseUrl }),
    enabled: booleanValue(item.enabled, 'connection enabled'),
    enabledModelIds: decodeConnectionModelIds(item.enabledModelIds),
  };
}

export function normalizeConnectionCatalogEntryUpdateForProvider(
  value: unknown,
  providerType: ProviderType,
): ConnectionCatalogEntryUpdate {
  const update = normalizeConnectionCatalogEntryUpdate(value);
  const baseUrl = normalizeCatalogConnectionBaseUrl(update.baseUrl, providerType);
  return {
    name: update.name,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    enabled: update.enabled,
    enabledModelIds: update.enabledModelIds,
  };
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
  if (typeof value !== 'string' || !PROVIDER_TYPES.has(value)) {
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
