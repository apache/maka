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

import { providerDefaultsOf, type ProviderType } from './provider-registry.js';
import type { ModelFactField, ModelInfo } from './llm-connections.js';
import {
  CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION,
  type ConnectionCatalogEntry,
  type ConnectionCatalogSnapshot,
} from './runtime-policy.js';

export const MODEL_FACTS_SCHEMA_VERSION = 1 as const;
export const MODEL_FACT_KEY_MAX_LENGTH = 512;
export const MODEL_FACTS_MAX_OVERRIDES = 512;

export type ModelFactOverride = Readonly<
  Omit<Partial<Omit<ModelInfo, 'id' | 'modalities' | 'factOverriddenFields'>>, 'modalities'> & {
    readonly modalities?: Readonly<Partial<ModelInfo['modalities']>>;
  }
>;
export type ModelFactOverrides = Readonly<Record<string, ModelFactOverride>>;

export interface ModelFactsDocument {
  readonly schemaVersion: typeof MODEL_FACTS_SCHEMA_VERSION;
  readonly overrides: ModelFactOverrides;
}

export class UnsupportedModelFactsSchemaError extends Error {
  constructor(readonly schemaVersion: number) {
    super(`model-facts.json schema version ${schemaVersion} is not supported`);
    this.name = 'UnsupportedModelFactsSchemaError';
  }
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
  if (providerDefaultsOf(provider) === undefined) {
    throw new Error(`Unknown model-facts provider: ${provider}`);
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

export function decodeModelFactsDocument(value: unknown): ModelFactsDocument {
  if (!isRecord(value)) throw new Error('model-facts.json must be an object');
  if (!Number.isSafeInteger(value.schemaVersion)) {
    throw new Error('model-facts.json schemaVersion must be an integer');
  }
  if (value.schemaVersion !== MODEL_FACTS_SCHEMA_VERSION)
    throw new UnsupportedModelFactsSchemaError(value.schemaVersion);
  if (!isRecord(value.overrides)) throw new Error('model-facts.json.overrides must be an object');
  const keys = Object.keys(value.overrides);
  if (keys.length > MODEL_FACTS_MAX_OVERRIDES)
    throw new Error('model-facts.json has too many overrides');
  const overrides: Record<string, ModelFactOverride> = {};
  for (const key of keys) {
    const match = PROVIDER_MODEL_KEY_PATTERN.exec(key);
    if (!match || key.length > MODEL_FACT_KEY_MAX_LENGTH) throw new Error('Invalid model fact key');
    modelFactKey(match[1]!, match[2]!);
    overrides[key] = normalizeModelFactOverride(value.overrides[key]);
  }
  return { schemaVersion: MODEL_FACTS_SCHEMA_VERSION, overrides };
}

/**
 * `structuredOutput` and `lastUpdated` are declared, generated, decoded and
 * overridable here, and nothing reads either one. They stay anyway: this
 * validator fails closed on an unknown key, and it fails the whole document, so
 * retiring a field would make one stale line in a user's `model-facts.json`
 * discard every override in the file. Dropping them is a release decision with
 * a migration, not a cleanup.
 */
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
  if (Object.keys(result).length === 0) throw new Error('Model fact override must not be empty');
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
    'parallelToolCalls',
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

function normalizeModalities(value: unknown): NonNullable<ModelFactOverride['modalities']> {
  if (!isRecord(value)) throw new Error('Invalid modalities');
  if (value.input === undefined && value.output === undefined)
    throw new Error('Invalid modalities');
  const input = normalizeModalityDirection(value.input, isModality);
  const output = normalizeModalityDirection(value.output, isOutputModality);
  return {
    ...(input === undefined ? {} : { input }),
    ...(output === undefined ? {} : { output }),
  };
}

function normalizeModalityDirection<T extends string>(
  value: unknown,
  allowed: (value: unknown) => value is T,
): T[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('Invalid modality value');
  const entries = Array.from(value);
  if (!entries.every(allowed)) throw new Error('Invalid modality value');
  return [...new Set(entries)];
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
  const overriddenFields = new Set<ModelFactField>(model.factOverriddenFields);
  for (const field of Object.keys(override) as ModelFactField[]) overriddenFields.add(field);
  // An authoritative context-window correction must not leave a stale,
  // narrower provider input limit to silently win in the runtime resolver.
  if (override.contextWindow !== undefined && override.inputLimit === undefined) {
    overriddenFields.add('inputLimit');
  }
  // Modalities are merged per direction: a partial override changes only the
  // direction it names and preserves the provider's other direction.
  const modalities = override.modalities
    ? {
        input: override.modalities.input ?? model.modalities?.input ?? ['text'],
        output: override.modalities.output ?? model.modalities?.output ?? ['text'],
      }
    : model.modalities;
  const { modalities: _ignoredModalities, ...scalarOverride } = override;
  return {
    ...model,
    ...scalarOverride,
    id: model.id,
    factOverriddenFields: [...overriddenFields],
    ...(override.contextWindow === undefined || override.inputLimit !== undefined
      ? {}
      : { inputLimit: override.contextWindow }),
    ...(override.capabilities === undefined
      ? {}
      : { capabilities: { ...model.capabilities, ...override.capabilities } }),
    ...(modalities === undefined ? {} : { modalities }),
  } satisfies ModelInfo;
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
  const providerModels = (connection.models ?? []).map((model) =>
    applyModelFactOverride(
      model,
      lookupModelFactOverride(overrides, connection.providerType, model.id),
    ),
  );
  const existing = new Set(providerModels.map((model) => model.id));
  const enabled = new Set(
    connection.enabledModelIds ??
      (connection.defaultModel === undefined ? [] : [connection.defaultModel]),
  );
  const overrideOnly = [...enabled]
    .filter((modelId) => !existing.has(modelId))
    .map(
      (modelId) =>
        [modelId, lookupModelFactOverride(overrides, connection.providerType, modelId)] as const,
    )
    .filter((entry): entry is readonly [string, ModelFactOverride] => entry[1] !== undefined);

  // Keep enabled models addressable even when the provider inventory fills the
  // wire bound. Unenabled provider rows are the only entries eligible for
  // eviction; the persisted inventory remains untouched.
  const protectedProviderCount = providerModels.filter((model) => enabled.has(model.id)).length;
  const reserve = Math.min(
    overrideOnly.length,
    Math.max(0, CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION - protectedProviderCount),
  );
  const targetProviderCount = CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION - reserve;
  const models = providerModels.slice();
  while (models.length > targetProviderCount) {
    let evict = -1;
    for (let index = models.length - 1; index >= 0; index -= 1) {
      if (!enabled.has(models[index]!.id)) {
        evict = index;
        break;
      }
    }
    if (evict < 0) break;
    models.splice(evict, 1);
  }
  for (const [modelId, override] of overrideOnly.slice(0, reserve)) {
    models.push(applyModelFactOverride({ id: modelId }, override));
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
