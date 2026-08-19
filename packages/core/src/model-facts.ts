import type { ModelInfo, ProviderType } from './llm-connections.js';
import type { ConnectionCatalogEntry, ConnectionCatalogSnapshot } from './runtime-policy.js';

export const MODEL_FACTS_SCHEMA_VERSION = 1 as const;
export const MODEL_FACT_KEY_MAX_LENGTH = 512;
export const MODEL_FACTS_MAX_OVERRIDES = 512;

export type ModelFactOverride = Readonly<Partial<Omit<ModelInfo, 'id'>>>;
export type ModelFactOverrides = Readonly<Record<string, ModelFactOverride>>;

export interface ModelFactsDocument {
  readonly schemaVersion: typeof MODEL_FACTS_SCHEMA_VERSION;
  readonly overrides: ModelFactOverrides;
}

const PROVIDER_ID_PATTERN = /^[^:\s]{1,128}$/;
// Model ids may contain colons (for example, Ollama's `gpt-oss:120b`). The
// provider is the only component that is constrained to the first separator.
const MODEL_ID_PATTERN = /^[^\s]{1,256}$/;
const PROVIDER_MODEL_KEY_PATTERN = /^([^:\s]{1,128}):([^\s]{1,256})$/;
const MAX_FACT_NUMBER = 10_000_000_000;

export function modelFactKey(providerType: ProviderType | string, modelId: string): string {
  const provider = providerType.trim();
  const model = modelId.trim();
  if (!provider || !model || !PROVIDER_ID_PATTERN.test(provider) || !MODEL_ID_PATTERN.test(model)) {
    throw new Error('Model fact keys must use a non-empty provider:model identifier');
  }
  const key = `${provider}:${model}`;
  if (key.length > MODEL_FACT_KEY_MAX_LENGTH) throw new Error('Model fact key is too long');
  return key;
}

export function lookupModelFactOverride(
  overrides: ModelFactOverrides | undefined,
  providerType: ProviderType | string,
  modelId: string,
): ModelFactOverride | undefined {
  if (!overrides) return undefined;
  try {
    return overrides[modelFactKey(providerType, modelId)];
  } catch {
    return undefined;
  }
}

/** Return model ids with facts for one provider without exposing other providers. */
export function modelFactOverrideIdsForProvider(
  overrides: ModelFactOverrides | undefined,
  providerType: ProviderType | string,
): string[] {
  if (!overrides) return [];
  const prefix = `${providerType.trim()}:`;
  return Object.keys(overrides)
    .filter((key) => key.startsWith(prefix))
    .map((key) => key.slice(prefix.length));
}

export function decodeModelFactsDocument(value: unknown): ModelFactsDocument {
  if (!isRecord(value) || value.schemaVersion !== MODEL_FACTS_SCHEMA_VERSION) {
    throw new Error('model-facts.json has an unsupported schema');
  }
  if (!isRecord(value.overrides)) throw new Error('model-facts.json.overrides must be an object');
  const keys = Object.keys(value.overrides);
  if (keys.length > MODEL_FACTS_MAX_OVERRIDES)
    throw new Error('model-facts.json has too many overrides');
  const overrides: Record<string, ModelFactOverride> = {};
  for (const key of keys) {
    const match = PROVIDER_MODEL_KEY_PATTERN.exec(key);
    if (!match || key.length > MODEL_FACT_KEY_MAX_LENGTH) throw new Error('Invalid model fact key');
    overrides[key] = normalizeModelFactOverride(value.overrides[key]);
  }
  return { schemaVersion: MODEL_FACTS_SCHEMA_VERSION, overrides };
}

export function normalizeModelFactOverride(value: unknown): ModelFactOverride {
  if (!isRecord(value)) throw new Error('Model fact override must be an object');
  const allowed = new Set([
    'displayName',
    'description',
    'apiProtocol',
    'contextWindow',
    'inputLimit',
    'maxOutputTokens',
    'knowledgeCutoff',
    'structuredOutput',
    'lastUpdated',
    'capabilities',
    'modalities',
  ]);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new Error(`Unknown model fact field: ${key}`);
  const result: Record<string, unknown> = {};
  for (const key of ['displayName', 'description', 'knowledgeCutoff', 'lastUpdated'] as const) {
    if (key in value) {
      if (typeof value[key] !== 'string' || value[key].length > 2048)
        throw new Error(`Invalid ${key}`);
      result[key] = value[key];
    }
  }
  if ('apiProtocol' in value) {
    if (
      value.apiProtocol !== 'openai-chat' &&
      value.apiProtocol !== 'openai-responses' &&
      value.apiProtocol !== 'anthropic-messages'
    )
      throw new Error('Invalid apiProtocol');
    result.apiProtocol = value.apiProtocol;
  }
  for (const key of ['contextWindow', 'inputLimit', 'maxOutputTokens'] as const) {
    if (key in value) {
      const number = value[key];
      if (!isPositiveBoundedInteger(number)) throw new Error(`Invalid ${key}`);
      result[key] = number;
    }
  }
  for (const key of ['structuredOutput'] as const) {
    if (key in value) {
      if (typeof value[key] !== 'boolean') throw new Error(`Invalid ${key}`);
      result[key] = value[key];
    }
  }
  if ('capabilities' in value) result.capabilities = normalizeCapabilities(value.capabilities);
  if ('modalities' in value) result.modalities = normalizeModalities(value.modalities);
  return result as ModelFactOverride;
}

function normalizeCapabilities(value: unknown): NonNullable<ModelInfo['capabilities']> {
  if (!isRecord(value)) throw new Error('Invalid capabilities');
  const result: Record<string, boolean> = {};
  const allowed = [
    'chat',
    'vision',
    'reasoning',
    'functionCalling',
    'imageGeneration',
    'webSearch',
  ] as const;
  for (const key of allowed) {
    if (key in value) {
      if (typeof value[key] !== 'boolean') throw new Error(`Invalid capability: ${key}`);
      result[key] = value[key];
    }
  }
  for (const key of Object.keys(value))
    if (!allowed.includes(key as (typeof allowed)[number])) {
      throw new Error(`Unknown capability: ${key}`);
    }
  return result;
}

function normalizeModalities(value: unknown): NonNullable<ModelInfo['modalities']> {
  if (!isRecord(value) || !Array.isArray(value.input) || !Array.isArray(value.output))
    throw new Error('Invalid modalities');
  const inputs = value.input.filter(isModality);
  const outputs = value.output.filter(isOutputModality);
  if (inputs.length !== value.input.length || outputs.length !== value.output.length)
    throw new Error('Invalid modality value');
  return { input: [...new Set(inputs)], output: [...new Set(outputs)] };
}

function isModality(value: unknown): value is 'text' | 'image' | 'audio' | 'pdf' {
  return value === 'text' || value === 'image' || value === 'audio' || value === 'pdf';
}
function isOutputModality(value: unknown): value is 'text' | 'image' | 'audio' {
  return value === 'text' || value === 'image' || value === 'audio';
}
function isPositiveBoundedInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= MAX_FACT_NUMBER
  );
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function applyModelFactOverride(
  model: ModelInfo,
  override: ModelFactOverride | undefined,
): ModelInfo {
  if (!override) return { ...model };
  return {
    ...model,
    ...override,
    id: model.id,
    ...(override.capabilities === undefined
      ? {}
      : { capabilities: { ...model.capabilities, ...override.capabilities } }),
    ...(override.modalities === undefined ? {} : { modalities: override.modalities }),
  };
}

type ModelFactConnectionLike = {
  readonly providerType: ProviderType;
  readonly defaultModel?: string;
  readonly models?: readonly ModelInfo[];
  readonly enabledModelIds?: readonly string[];
};

export function applyModelFactOverridesToConnection<T extends ModelFactConnectionLike>(
  connection: T,
  overrides: ModelFactOverrides,
): T {
  const models = (connection.models ?? []).map((model) =>
    applyModelFactOverride(
      model,
      lookupModelFactOverride(overrides, connection.providerType, model.id),
    ),
  );
  const existing = new Set(models.map((model) => model.id));
  const enabled = new Set(
    connection.enabledModelIds ??
      (connection.defaultModel === undefined ? [] : [connection.defaultModel]),
  );
  for (const modelId of enabled) {
    if (existing.has(modelId)) continue;
    const override = lookupModelFactOverride(overrides, connection.providerType, modelId);
    if (override) {
      models.push(applyModelFactOverride({ id: modelId }, override));
      existing.add(modelId);
    }
  }
  return { ...connection, models } as T;
}

export function applyModelFactOverridesToCatalogSnapshot(
  snapshot: ConnectionCatalogSnapshot,
  overrides: ModelFactOverrides,
): ConnectionCatalogSnapshot {
  return {
    ...snapshot,
    connections: snapshot.connections.map(
      (connection) =>
        applyModelFactOverridesToConnection(
          connection,
          overrides,
        ) as unknown as ConnectionCatalogEntry,
    ),
  };
}
