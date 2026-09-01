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

/**
 * Turning a models.dev response into `ModelMetadata`, for the build-time
 * generator and the Runtime Host's startup refresh alike. One projection means
 * a model cannot mean one thing in the committed snapshot and another when the
 * Host reads it live.
 *
 * `scripts/sync-model-metadata.mjs` loads this file through Node's type
 * stripping, which erases type-only imports but cannot resolve a relative
 * value import. Every relative import here must stay `import type`.
 *
 * Validation fails loud and whole. A caller that cannot accept a rejected
 * catalog keeps whatever it had.
 */

import type { ProviderType } from './llm-connections.js';
import type { ModelMetadata } from './model-metadata.js';

export const MODELS_DEV_SOURCE_URL = 'https://models.dev/api.json';

/** Every provider access path Maka serves, and the models.dev provider it reads. */
export const MODELS_DEV_PROVIDERS = {
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
} as const satisfies Partial<Record<ProviderType, string>>;

export interface ModelsDevProvider {
  readonly id: string;
  readonly name: string;
  readonly api?: string;
  readonly doc: string;
  readonly models: Readonly<Record<string, ModelsDevModel>>;
}

export interface ModelsDevModel {
  readonly name: string;
  readonly description?: string;
  readonly knowledge?: string;
  readonly last_updated?: string;
  readonly status?: string;
  readonly reasoning: boolean;
  readonly tool_call: boolean;
  readonly structured_output?: boolean;
  readonly limit: { readonly context: number; readonly output: number; readonly input?: number };
  readonly modalities?: { readonly input: string[]; readonly output: string[] };
  readonly reasoning_options?: ReadonlyArray<{ readonly type?: string; readonly values?: unknown }>;
  readonly cost?: Readonly<Record<string, unknown>>;
  readonly provider?: { readonly npm?: string; readonly api?: string };
}

export type ModelsDevCatalog = Readonly<Record<string, ModelsDevProvider>>;

type ModelModality = NonNullable<ModelMetadata['modalities']>['input'][number];

// Every member must be listed, so a modality added to `ModelInfo` cannot reach
// the wire without a decision here.
const KNOWN_MODALITIES: Record<ModelModality, true> = {
  text: true,
  image: true,
  audio: true,
  pdf: true,
  video: true,
};

function requireModalities(
  providerId: string,
  modelId: string,
  values: readonly string[],
): ModelModality[] {
  for (const value of values) {
    if (!Object.hasOwn(KNOWN_MODALITIES, value)) {
      throw new Error(`models.dev model ${providerId}/${modelId} has unsupported modalities`);
    }
  }
  return values as ModelModality[];
}

/**
 * The providers Maka reads, taken from a models.dev response and checked to
 * the depth every downstream projection depends on. A missing or shapeless
 * provider rejects the whole response: a partial catalog would read as an
 * upstream removal.
 */
export function selectModelsDevCatalog(catalog: unknown): ModelsDevCatalog {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error('models.dev response is not an object');
  }
  const source = catalog as Record<string, unknown>;
  const selected: Record<string, ModelsDevProvider> = {};
  for (const sourceId of [...new Set(Object.values(MODELS_DEV_PROVIDERS))].sort()) {
    const provider = source[sourceId];
    assertModelsDevProvider(sourceId, provider);
    selected[sourceId] = provider;
  }
  return selected;
}

/**
 * The provider shape every downstream projection depends on. A caller that
 * reports rather than rejects — the drift report names what upstream broke —
 * checks one provider at a time instead of taking the whole catalog.
 */
export function assertModelsDevProvider(
  sourceId: string,
  provider: unknown,
): asserts provider is ModelsDevProvider {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new Error(`models.dev provider ${sourceId} is missing`);
  }
  const candidate = provider as Record<string, unknown>;
  if (
    !candidate.models ||
    typeof candidate.models !== 'object' ||
    Array.isArray(candidate.models) ||
    Object.keys(candidate.models).length === 0
  ) {
    throw new Error(`models.dev provider ${sourceId} has no non-empty models object`);
  }
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.name !== 'string' ||
    typeof candidate.doc !== 'string' ||
    (candidate.api !== undefined && typeof candidate.api !== 'string')
  ) {
    throw new Error(`models.dev provider ${sourceId} has an unsupported shape`);
  }
}

/** Every access path's models, keyed as Maka names the provider. */
export function projectModelsDevMetadata(
  catalog: ModelsDevCatalog,
): Partial<Record<ProviderType, Record<string, ModelMetadata>>> {
  const metadata: Partial<Record<ProviderType, Record<string, ModelMetadata>>> = {};
  for (const [providerType, sourceId] of Object.entries(MODELS_DEV_PROVIDERS)) {
    const provider = catalog[sourceId];
    if (!provider) throw new Error(`models.dev provider ${sourceId} is missing`);
    metadata[providerType as ProviderType] = Object.fromEntries(
      Object.entries(provider.models)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([id, model]) => [id, projectModelsDevModel(sourceId, id, provider, model)]),
    );
  }
  return metadata;
}

export function projectModelsDevModel(
  providerId: string,
  modelId: string,
  provider: ModelsDevProvider,
  model: ModelsDevModel,
): ModelMetadata {
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
  const modalities =
    model.modalities === undefined
      ? undefined
      : {
          input: requireModalities(providerId, modelId, model.modalities.input),
          output: requireModalities(providerId, modelId, model.modalities.output),
        };
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
  let efforts: string[] | undefined;
  let toggle = false;
  for (const entry of reasoningOptions) {
    if (entry?.type === 'effort') {
      const values = entry.values;
      if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
        throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported shape`);
      }
      efforts = values;
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
    contextWindow: model.limit?.context,
    ...(model.limit?.input !== undefined ? { inputLimit: model.limit.input } : {}),
    maxOutputTokens: model.limit?.output,
    ...(model.knowledge !== undefined ? { knowledgeCutoff: model.knowledge } : {}),
    ...(model.structured_output !== undefined ? { structuredOutput: model.structured_output } : {}),
    ...(model.last_updated !== undefined ? { lastUpdated: model.last_updated } : {}),
    ...(model.cost?.input === 0 ? { isFree: true } : {}),
    capabilities: {
      ...(modalities ? { vision: modalities.input.includes('image') } : {}),
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
    ...(modalities
      ? {
          modalities: {
            input: [...modalities.input],
            output: [...modalities.output],
          },
        }
      : {}),
  };
}

function lifecycleForStatus(
  providerId: string,
  modelId: string,
  status: string | undefined,
): NonNullable<ModelMetadata['lifecycle']> {
  if (status === undefined) return 'active';
  if (status === 'active' || status === 'beta' || status === 'alpha' || status === 'deprecated') {
    return status;
  }
  throw new Error(`models.dev model ${providerId}/${modelId} has an unsupported status`);
}

/**
 * Paths present in `previous` that `next` no longer carries, in JSON Pointer
 * form. Both arguments are whole projections, so a caller comparing only one
 * section passes it under the same key each side and reads the same paths the
 * generator reports.
 *
 * Upstream removing a fact is not upstream correcting one. A model that
 * stopped declaring its effort set does not stop having a knob, and a build
 * that silently adopts the shorter list drops a level the user had already
 * chosen. What the caller does about it is policy: the generator refuses the
 * refresh until a human acknowledges it, the Host records it and carries on.
 */
export function collectProjectionRemovals(previous: unknown, next: unknown): string[] {
  const removals: string[] = [];
  collectRemovals(previous, next, [], removals);
  return removals.sort();
}

function collectRemovals(
  previous: unknown,
  next: unknown,
  path: (string | number)[],
  removals: string[],
): void {
  if (Array.isArray(previous)) {
    if (!Array.isArray(next)) {
      removals.push(projectionPath(path));
      return;
    }
    if (path.length === 1 && path[0] === 'pricing') {
      const nextByModelKey = new Map(
        next.map((entry) => [(entry as { modelKey?: unknown })?.modelKey, entry]),
      );
      for (const entry of previous) {
        const modelKey = (entry as { modelKey?: unknown })?.modelKey;
        const modelPath = [...path, String(modelKey)];
        const nextEntry = nextByModelKey.get(modelKey);
        if (!nextEntry) removals.push(projectionPath(modelPath));
        else collectRemovals(entry, nextEntry, modelPath, removals);
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
    // A capability withdrawn is a removal even though the key survives.
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
    if (!Object.hasOwn(next, key)) removals.push(projectionPath(childPath));
    else collectRemovals(value, (next as Record<string, unknown>)[key], childPath, removals);
  }
}

function projectionPath(path: readonly (string | number)[]): string {
  return `/${path.map((segment) => String(segment).replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
}
