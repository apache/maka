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
  PROVIDER_DEFAULTS,
  effectiveBaseUrl,
  providerAuthSupportsApiKey,
  type LlmConnection,
  type ModelInfo,
} from '@maka/core/llm-connections';
import { generalizedErrorMessage } from '@maka/core/redaction';
import {
  CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION,
  CONNECTION_MODEL_ID_MAX_LENGTH,
  normalizeConnectionModelDiscoveryResult,
} from '@maka/core/runtime-policy';
import { anthropicV1Url, googleApiUrl } from './provider-urls.js';
import { openAiCodexHeaders } from './subscription-auth.js';
import {
  GITHUB_COPILOT_API_VERSION,
  GITHUB_COPILOT_COMPAT_HEADERS,
} from './subscription-credentials.js';
import {
  ConnectionEffectFetchError,
  fetchForConnectionEffect,
  type ConnectionEffectFetch,
  type ConnectionEffectFetchDependency,
  type ConnectionEffectFetchOptions,
  type ConnectionEffectResponse,
} from './connection-effect-fetch.js';
import {
  ConnectionEffectHttpError,
  ConnectionEffectInvalidResponseError,
  classifyConnectionEffectStatus,
  type ConnectionEffectConnection,
  type ConnectionEffectError,
  type ConnectionModelDiscoveryEffectOutcome,
} from './connection-effect-outcome.js';

const MODEL_FETCH_TIMEOUT_MS = 10_000;
const CLOUDFLARE_MODEL_PAGE_SIZE = 50;
const CLOUDFLARE_MODEL_MAX_REQUEST_PAGES =
  Math.ceil(CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION / CLOUDFLARE_MODEL_PAGE_SIZE) + 1;
const COHERE_MODEL_PAGE_SIZE = 1_000;
const COHERE_MODEL_MAX_REQUEST_PAGES =
  Math.ceil(CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION / COHERE_MODEL_PAGE_SIZE) + 1;
const FIREWORKS_PAGE_SIZE = 200;
const FIREWORKS_MAX_REQUEST_PAGES =
  Math.ceil(CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION / FIREWORKS_PAGE_SIZE) + 1;
const FIREWORKS_MAX_ACCOUNTS = 32;
const FIREWORKS_ACCOUNT_CONCURRENCY = 4;
const PROVIDER_PAGE_TOKEN_MAX_LENGTH = 2_048;

type RawProviderModel = {
  id?: string;
  name?: string;
  display_name?: string;
  type?: string;
  tags?: string[];
  input_modalities?: string[];
  output_modalities?: string[];
  capabilities?: { reasoning?: boolean };
  supports_image_in?: boolean;
  supports_reasoning?: boolean;
  context_length?: number;
  context_window?: number;
  max_tokens?: number;
  providers?: Array<{
    status?: string;
    supports_tools?: boolean;
  }>;
};

type RawFireworksModel = {
  name?: string;
  displayName?: string;
  contextLength?: number;
  supportsImageInput?: boolean;
  supportsTools?: boolean;
};

type RawCohereModel = {
  name?: string;
  is_deprecated?: boolean;
  endpoints?: string[];
  context_length?: number;
};

type RawCloudflareModel = {
  name?: unknown;
};

type RawGitHubCopilotModel = {
  id?: string;
  name?: string;
  model_picker_enabled?: boolean;
  supported_endpoints?: string[];
  policy?: { state?: string };
  capabilities?: {
    limits?: {
      max_context_window_tokens?: number;
      max_prompt_tokens?: number;
      max_output_tokens?: number;
      vision?: { supported_media_types?: string[] };
    };
    supports?: {
      adaptive_thinking?: boolean;
      max_thinking_budget?: number;
      min_thinking_budget?: number;
      reasoning_effort?: string[];
      tool_calls?: boolean;
      vision?: boolean;
    };
  };
};

type FireworksModelDiscovery = Extract<
  (typeof PROVIDER_DEFAULTS)[keyof typeof PROVIDER_DEFAULTS]['modelDiscovery'],
  { kind: 'fireworks' }
>;

export async function fetchProviderModels(
  connection: LlmConnection,
  apiKey: string,
  options: ConnectionEffectFetchOptions = {},
): Promise<ModelInfo[]> {
  try {
    return normalizeDiscoveredModels(
      await fetchProviderModelsStrict(connection, apiKey, options.fetch),
    );
  } catch (error) {
    // Preserve status-bearing discovery errors so the sync layer can classify
    // auth/protocol/network failures; only wrap unknown errors for display.
    if (
      error instanceof OpenAiCodexDiscoveryError ||
      error instanceof ProviderModelDiscoveryHttpError
    ) {
      throw error;
    }
    throw new Error(generalizedErrorMessage(error, 'Failed to fetch provider models'));
  }
}

export async function runConnectionModelDiscoveryEffect(
  connection: ConnectionEffectConnection,
  apiKey: string,
  options: ConnectionEffectFetchDependency,
): Promise<ConnectionModelDiscoveryEffectOutcome> {
  try {
    return {
      ok: true,
      models: normalizeConnectionEffectModels(
        await fetchProviderModelsStrict(connection, apiKey, options.fetch),
      ),
    };
  } catch (error) {
    return { ok: false, error: classifyDiscoveryError(error) };
  }
}

async function fetchProviderModelsStrict(
  connection: ConnectionEffectConnection,
  apiKey: string,
  fetchFn: ConnectionEffectFetch | undefined,
): Promise<ModelInfo[]> {
  const baseUrl = effectiveBaseUrl(connection);
  const definition = PROVIDER_DEFAULTS[connection.providerType];
  // Unknown providerType → no discovery path. Throw a clear error (caught and
  // generalized by the caller) rather than crashing on `.modelDiscovery`.
  // Mirrors `isRealConnection` in @maka/core/connection-readiness.ts.
  if (!definition) {
    throw new Error(`Unknown provider type "${connection.providerType}"`);
  }
  const discovery = definition.modelDiscovery;

  if (discovery.kind === 'fallback') {
    return definition.fallbackModels.map((id) => ({ id }));
  }
  if (discovery.kind === 'ollama') {
    const r = await fetchForConnectionEffect(fetchFn, `${ollamaRoot(baseUrl)}/api/tags`, {
      timeoutMs: MODEL_FETCH_TIMEOUT_MS,
    });
    if (!r.ok) {
      await r.cancel();
      throw new ConnectionEffectHttpError(r.status);
    }
    const data = await readProviderJson<{ models?: unknown }>(r);
    return providerObjectArray<{ name?: string }>(data.models, 'Ollama models').flatMap((model) =>
      model.name ? [{ id: model.name }] : [],
    );
  }
  if (discovery.kind === 'fireworks') {
    return fetchFireworksModels(baseUrl, apiKey, discovery, fetchFn);
  }
  if (discovery.kind === 'cohere') {
    return fetchCohereModels(baseUrl, apiKey, fetchFn);
  }
  if (discovery.kind === 'cloudflare') {
    return fetchCloudflareModels(baseUrl, apiKey, fetchFn);
  }
  if (discovery.auth === 'github-copilot') {
    return fetchGitHubCopilotModels(baseUrl, apiKey, fetchFn);
  }
  if (discovery.auth === 'openai-codex') {
    return fetchOpenAiCodexModels(baseUrl, apiKey, fetchFn);
  }

  switch (definition.protocol) {
    case 'anthropic': {
      const r = await fetchForConnectionEffect(fetchFn, anthropicV1Url(baseUrl, '/models'), {
        headers: anthropicModelHeaders(apiKey),
        timeoutMs: MODEL_FETCH_TIMEOUT_MS,
      });
      if (!r.ok) {
        await r.cancel();
        throw new ConnectionEffectHttpError(r.status);
      }
      const data = await readProviderJson<{ data?: unknown }>(r);
      const models = providerObjectArray<RawProviderModel>(data.data, 'Anthropic models')
        .map(toModelInfo)
        .filter((model): model is ModelInfo => model !== null);
      return filterDiscoveredModels(models, discovery.filter);
    }
    case 'openai': {
      const r = await fetchForConnectionEffect(
        fetchFn,
        modelListUrl(baseUrl, discovery.path, discovery.query),
        {
          headers: {
            'content-type': 'application/json',
            ...(apiKey &&
            (discovery.auth === 'oauth-bearer' ||
              (discovery.auth !== 'none' && providerAuthSupportsApiKey(connection.providerType)))
              ? { authorization: `Bearer ${apiKey}` }
              : {}),
          },
          timeoutMs: MODEL_FETCH_TIMEOUT_MS,
        },
      );
      if (!r.ok) {
        await r.cancel();
        if (connection.providerType === 'xai-oauth') {
          throw new ProviderModelDiscoveryHttpError(r.status);
        }
        throw new ConnectionEffectHttpError(r.status);
      }
      const data = await readProviderJson<{ data?: unknown } | unknown[]>(r);
      const rawModels =
        discovery.responseShape === 'array-or-data'
          ? Array.isArray(data)
            ? providerObjectArray<RawProviderModel>(data, 'provider models')
            : providerObjectArray<RawProviderModel>(data.data, 'provider models')
          : Array.isArray(data)
            ? []
            : providerObjectArray<RawProviderModel>(data.data, 'provider models');
      const models = rawModels
        .filter((model) => discovery.filter !== 'language-models' || model.type === 'language')
        .map(toModelInfo)
        .filter((model): model is ModelInfo => model !== null);
      return filterDiscoveredModels(models, discovery.filter);
    }
    case 'google': {
      const r = await fetchForConnectionEffect(fetchFn, googleApiUrl(baseUrl, '/models', apiKey), {
        timeoutMs: MODEL_FETCH_TIMEOUT_MS,
      });
      if (!r.ok) {
        await r.cancel();
        throw new ConnectionEffectHttpError(r.status);
      }
      const data = await readProviderJson<{ models?: unknown }>(r);
      return providerObjectArray<{ name?: string }>(data.models, 'Google models').flatMap(
        (model) => {
          const id = model.name?.split('/').pop();
          return id ? [{ id }] : [];
        },
      );
    }
    case 'cohere':
      throw new Error('Cohere requires native model discovery');
  }
}

async function fetchCloudflareModels(
  baseUrl: string,
  apiKey: string,
  fetchFn: ConnectionEffectFetch | undefined,
): Promise<ModelInfo[]> {
  const models: ModelInfo[] = [];
  let page = 1;
  let rawModelCount = 0;
  const signal = AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS);
  while (page <= CLOUDFLARE_MODEL_MAX_REQUEST_PAGES) {
    const url = cloudflareModelsUrl(baseUrl, page);
    const response = await fetchForConnectionEffect(fetchFn, url, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal,
      timeoutMs: MODEL_FETCH_TIMEOUT_MS,
    });
    if (!response.ok) {
      await response.cancel();
      throw new ConnectionEffectHttpError(response.status);
    }
    const data = await readProviderJson<{
      success?: unknown;
      result?: unknown;
    }>(response);
    if (data.success !== true) {
      throw new ConnectionEffectInvalidResponseError('Invalid Cloudflare models response');
    }
    const rawModels = providerObjectArray<RawCloudflareModel>(
      data.result,
      'Cloudflare models',
      true,
    );
    rawModelCount += rawModels.length;
    if (rawModelCount > CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION) {
      throw new ConnectionEffectInvalidResponseError('Provider returned too many models');
    }
    models.push(
      ...rawModels.flatMap((model) => (typeof model.name === 'string' ? [{ id: model.name }] : [])),
    );
    if (rawModels.length === 0) return models;
    page += 1;
  }
  throw new ConnectionEffectInvalidResponseError('Provider returned too many models');
}

function cloudflareModelsUrl(baseUrl: string, page: number): string {
  const url = new URL(baseUrl);
  if (!/\/ai\/v1\/?$/.test(url.pathname)) {
    throw new Error('Cloudflare Workers AI base URL must end with /ai/v1');
  }
  url.pathname = url.pathname.replace(/\/ai\/v1\/?$/, '/ai/models/search');
  url.search = new URLSearchParams({
    page: String(page),
    per_page: String(CLOUDFLARE_MODEL_PAGE_SIZE),
    task: 'Text Generation',
  }).toString();
  return url.toString();
}

function normalizeDiscoveredModels(models: ModelInfo[]): ModelInfo[] {
  const unique = new Map<string, ModelInfo>();
  for (const model of models) {
    if (typeof model?.id !== 'string') continue;
    const id = model.id.trim();
    if (
      !id ||
      id.length > CONNECTION_MODEL_ID_MAX_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(id) ||
      unique.has(id)
    ) {
      continue;
    }
    unique.set(id, { ...model, id });
    if (unique.size > CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION) {
      throw new ConnectionEffectInvalidResponseError('Provider returned too many models');
    }
  }
  return [...unique.values()];
}

function normalizeConnectionEffectModels(models: ModelInfo[]): readonly ModelInfo[] {
  try {
    return normalizeConnectionModelDiscoveryResult({
      models: normalizeDiscoveredModels(models),
      source: 'fetched',
      fetchedAt: 0,
    }).models;
  } catch (error) {
    throw new ConnectionEffectInvalidResponseError('Provider returned invalid model metadata', {
      cause: error,
    });
  }
}

export async function fetchGitHubCopilotModels(
  baseUrl: string,
  accessToken: string,
  fetchFn?: ConnectionEffectFetch,
): Promise<ModelInfo[]> {
  const response = await fetchForConnectionEffect(fetchFn, `${stripTrailing(baseUrl)}/models`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...GITHUB_COPILOT_COMPAT_HEADERS,
      'Openai-Intent': 'conversation-edits',
      'X-GitHub-Api-Version': GITHUB_COPILOT_API_VERSION,
    },
    timeoutMs: MODEL_FETCH_TIMEOUT_MS,
  });
  if (!response.ok) {
    await response.cancel();
    throw new ConnectionEffectHttpError(response.status);
  }
  const payload = await readProviderJson<{ data?: unknown }>(response);
  return providerObjectArray<RawGitHubCopilotModel>(
    payload.data,
    'GitHub Copilot models',
    true,
  ).flatMap(toGitHubCopilotModelInfo);
}

type RawOpenAiCodexModel = {
  slug?: unknown;
  visibility?: unknown;
  priority?: unknown;
  context_window?: unknown;
};

/**
 * Discovery error carrying the HTTP status, so callers (syncOpenAiCodexConnection)
 * can classify auth failures (401/403) vs protocol errors (4xx) vs transient
 * network failures without string-matching the message.
 */
export class OpenAiCodexDiscoveryError extends ConnectionEffectHttpError {
  constructor(status: number) {
    super(status);
    this.name = 'OpenAiCodexDiscoveryError';
  }
}

/** Structured status for standard provider `/models` endpoints. */
export class ProviderModelDiscoveryHttpError extends ConnectionEffectHttpError {
  constructor(status: number) {
    super(status);
    this.name = 'ProviderModelDiscoveryHttpError';
  }
}

/**
 * Discover models from the ChatGPT/Codex OAuth backend
 * (`chatgpt.com/backend-api/codex/models`). Unlike the public OpenAI API
 * `/v1/models`, this endpoint reports the slugs the signed-in ChatGPT account
 * can actually use over the Codex backend, including OAuth-only slugs such
 * as `gpt-5.3-codex-spark`. Entries with `visibility: hide|hidden` are
 * dropped; the rest are sorted by `priority` (ascending) to match the
 * ChatGPT/Codex picker order.
 */
export async function fetchOpenAiCodexModels(
  baseUrl: string,
  accessToken: string,
  fetchFn?: ConnectionEffectFetch,
): Promise<ModelInfo[]> {
  const response = await fetchForConnectionEffect(
    fetchFn,
    `${stripTrailing(baseUrl)}/models?client_version=1.0.0`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...openAiCodexHeaders(accessToken),
        'content-type': 'application/json',
      },
      timeoutMs: MODEL_FETCH_TIMEOUT_MS,
    },
  );
  if (!response.ok) {
    await response.cancel();
    throw new OpenAiCodexDiscoveryError(response.status);
  }
  const payload = await readProviderJson<{ models?: unknown }>(response);
  const models = providerObjectArray<RawOpenAiCodexModel>(
    payload.models,
    'OpenAI Codex models',
    true,
  );
  const visible = models.filter((model) => {
    if (!model || typeof model.slug !== 'string' || !model.slug.trim()) return false;
    const visibility =
      typeof model.visibility === 'string' ? model.visibility.trim().toLowerCase() : '';
    return visibility !== 'hide' && visibility !== 'hidden';
  });
  visible.sort((a, b) => priorityOfOpenAiCodexModel(a) - priorityOfOpenAiCodexModel(b));
  return visible.map((model) => {
    const entry: ModelInfo = { id: (model.slug as string).trim() };
    const contextWindow = contextWindowOfOpenAiCodexModel(model);
    if (contextWindow !== undefined) entry.contextWindow = contextWindow;
    return entry;
  });
}

function priorityOfOpenAiCodexModel(model: RawOpenAiCodexModel): number {
  return typeof model.priority === 'number' && Number.isFinite(model.priority)
    ? model.priority
    : 10_000;
}

function contextWindowOfOpenAiCodexModel(model: RawOpenAiCodexModel): number | undefined {
  return typeof model.context_window === 'number' &&
    Number.isFinite(model.context_window) &&
    model.context_window > 0
    ? model.context_window
    : undefined;
}

function toGitHubCopilotModelInfo(model: RawGitHubCopilotModel): ModelInfo[] {
  if (
    typeof model.id !== 'string' ||
    !model.id ||
    model.model_picker_enabled !== true ||
    model.policy?.state === 'disabled' ||
    model.capabilities?.supports?.tool_calls !== true
  )
    return [];
  assertOptionalArray(model.supported_endpoints, 'model supported_endpoints');
  assertOptionalArray(
    model.capabilities.supports.reasoning_effort,
    'model capabilities.supports.reasoning_effort',
  );
  assertOptionalArray(
    model.capabilities.limits?.vision?.supported_media_types,
    'model capabilities.limits.vision.supported_media_types',
  );
  const endpoints = model.supported_endpoints ?? [];
  const apiProtocol = endpoints.includes('/v1/messages')
    ? ('anthropic-messages' as const)
    : endpoints.includes('/responses')
      ? ('openai-responses' as const)
      : endpoints.includes('/chat/completions')
        ? ('openai-chat' as const)
        : null;
  if (!apiProtocol) return [];
  const limits = model.capabilities.limits;
  const supports = model.capabilities.supports;
  const reasoning =
    supports.adaptive_thinking === true ||
    (supports.reasoning_effort?.length ?? 0) > 0 ||
    supports.max_thinking_budget !== undefined ||
    supports.min_thinking_budget !== undefined;
  const vision =
    supports.vision === true ||
    limits?.vision?.supported_media_types?.some(
      (type) => typeof type === 'string' && type.startsWith('image/'),
    ) === true;
  const contextWindow = limits?.max_context_window_tokens ?? limits?.max_prompt_tokens;
  return [
    {
      id: model.id,
      ...(model.name ? { displayName: model.name } : {}),
      ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
      ...(typeof limits?.max_output_tokens === 'number'
        ? { maxOutputTokens: limits.max_output_tokens }
        : {}),
      apiProtocol,
      capabilities: { vision, reasoning, functionCalling: true },
    },
  ];
}

async function fetchCohereModels(
  baseUrl: string,
  apiKey: string,
  fetchFn: ConnectionEffectFetch | undefined,
): Promise<ModelInfo[]> {
  const root = stripTrailing(baseUrl).replace(/\/v2$/, '');
  const models: ModelInfo[] = [];
  const seenPageTokens = new Set<string>();
  const signal = AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS);
  let pageToken: string | undefined;
  let pageCount = 0;
  let rawModelCount = 0;
  while (true) {
    pageCount += 1;
    if (pageCount > COHERE_MODEL_MAX_REQUEST_PAGES) {
      throw new ConnectionEffectInvalidResponseError('Provider returned too many model pages');
    }
    const query = new URLSearchParams({
      endpoint: 'chat',
      page_size: String(COHERE_MODEL_PAGE_SIZE),
    });
    if (pageToken) query.set('page_token', pageToken);
    const response = await fetchForConnectionEffect(
      fetchFn,
      `${root}/v1/models?${query.toString()}`,
      {
        headers: { authorization: `Bearer ${apiKey}` },
        signal,
        timeoutMs: MODEL_FETCH_TIMEOUT_MS,
      },
    );
    if (!response.ok) {
      await response.cancel();
      throw new ConnectionEffectHttpError(response.status);
    }
    const data = await readProviderJson<{ models?: unknown; next_page_token?: unknown }>(response);
    const rawModels = providerObjectArray<RawCohereModel>(data.models, 'Cohere models');
    rawModelCount += rawModels.length;
    if (rawModelCount > CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION) {
      throw new ConnectionEffectInvalidResponseError('Provider returned too many models');
    }
    models.push(
      ...rawModels.flatMap((model) => {
        if (typeof model.name !== 'string' || !model.name || model.is_deprecated === true) {
          return [];
        }
        assertOptionalArray(model.endpoints, 'model endpoints');
        if (!model.endpoints?.includes('chat')) return [];
        return [
          {
            id: model.name,
            ...(typeof model.context_length === 'number'
              ? { contextWindow: model.context_length }
              : {}),
          },
        ];
      }),
    );
    pageToken = nextProviderPageToken(data.next_page_token);
    if (!pageToken) return models;
    if (seenPageTokens.has(pageToken)) {
      throw new ConnectionEffectInvalidResponseError('Provider repeated a model page token');
    }
    seenPageTokens.add(pageToken);
  }
}

/**
 * Provider-reported filters only. `tool-capable` and `language-models` keep
 * what the provider itself said about each model; there is no filter that
 * intersects a live response with the array this build shipped. Doing that
 * made "the provider listed this" mean "this build has heard of it", so a
 * model the account gained after release was dropped on arrival and could
 * never be selected (#1584).
 */
function filterDiscoveredModels(
  models: ModelInfo[],
  filter: 'language-models' | 'tool-capable' | undefined,
): ModelInfo[] {
  if (filter === 'tool-capable') {
    return models.filter((model) => model.capabilities?.functionCalling === true);
  }
  return models;
}

function modelListUrl(
  baseUrl: string,
  path: string | undefined,
  query: Readonly<Record<string, string>> | undefined,
): string {
  const url = path
    ? new URL(path, `${stripTrailing(baseUrl)}/`).toString()
    : `${stripTrailing(baseUrl)}/models`;
  const search = query ? new URLSearchParams(query).toString() : '';
  return search ? `${url}?${search}` : url;
}

async function fetchFireworksModels(
  baseUrl: string,
  apiKey: string,
  discovery: FireworksModelDiscovery,
  fetchFn: ConnectionEffectFetch | undefined,
): Promise<ModelInfo[]> {
  const root = stripTrailing(baseUrl).replace(/\/inference\/v1$/, '');
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
  const signal = AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS);
  const fetchPages = async <T extends object>(
    path: string,
    query: Readonly<Record<string, string>>,
    itemKey: 'accounts' | 'models',
    maxItems: number,
    reserveItems?: (count: number) => void,
  ): Promise<T[]> => {
    const items: T[] = [];
    const seenPageTokens = new Set<string>();
    let pageToken: string | undefined;
    let pageCount = 0;
    while (true) {
      pageCount += 1;
      if (pageCount > FIREWORKS_MAX_REQUEST_PAGES) {
        throw new ConnectionEffectInvalidResponseError('Provider returned too many model pages');
      }
      const search = new URLSearchParams(query);
      if (pageToken) search.set('pageToken', pageToken);
      const response = await fetchForConnectionEffect(
        fetchFn,
        `${root}${path}?${search.toString()}`,
        {
          headers,
          signal,
          timeoutMs: MODEL_FETCH_TIMEOUT_MS,
        },
      );
      if (!response.ok) {
        await response.cancel();
        throw new ConnectionEffectHttpError(response.status);
      }
      const data = await readProviderJson<{
        accounts?: unknown;
        models?: unknown;
        nextPageToken?: unknown;
      }>(response);
      const rawItems = providerObjectArray<T>(data[itemKey], `Fireworks ${itemKey}`);
      reserveItems?.(rawItems.length);
      items.push(...rawItems);
      if (items.length > maxItems) {
        throw new ConnectionEffectInvalidResponseError(`Provider returned too many ${itemKey}`);
      }
      pageToken = nextProviderPageToken(data.nextPageToken);
      if (!pageToken) return items;
      if (seenPageTokens.has(pageToken)) {
        throw new ConnectionEffectInvalidResponseError('Provider repeated a model page token');
      }
      seenPageTokens.add(pageToken);
    }
  };

  const accounts = await fetchPages<{ name?: string }>(
    discovery.accountsPath,
    { pageSize: String(FIREWORKS_PAGE_SIZE) },
    'accounts',
    FIREWORKS_MAX_ACCOUNTS,
  );
  const accountNames = [
    ...accounts.flatMap((account) =>
      account.name && /^accounts\/[^/]+$/.test(account.name) ? [account.name] : [],
    ),
    discovery.publicAccount,
  ].filter((name, index, names) => names.indexOf(name) === index);
  if (accountNames.length > FIREWORKS_MAX_ACCOUNTS) {
    throw new ConnectionEffectInvalidResponseError('Provider returned too many accounts');
  }
  let rawModelCount = 0;
  const reserveModels = (count: number) => {
    rawModelCount += count;
    if (rawModelCount > CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION) {
      throw new ConnectionEffectInvalidResponseError('Provider returned too many models');
    }
  };
  const modelLists: RawFireworksModel[][] = [];
  for (let index = 0; index < accountNames.length; index += FIREWORKS_ACCOUNT_CONCURRENCY) {
    modelLists.push(
      ...(await Promise.all(
        accountNames
          .slice(index, index + FIREWORKS_ACCOUNT_CONCURRENCY)
          .map((accountName) =>
            fetchPages<RawFireworksModel>(
              `/v1/${accountName}/models`,
              discovery.query,
              'models',
              CONNECTION_CATALOG_MAX_MODELS_PER_CONNECTION,
              reserveModels,
            ),
          ),
      )),
    );
  }

  return modelLists.flat().flatMap((model) => {
    if (!model.name) return [];
    const capabilities: NonNullable<ModelInfo['capabilities']> = {};
    if (typeof model.supportsImageInput === 'boolean')
      capabilities.vision = model.supportsImageInput;
    if (typeof model.supportsTools === 'boolean')
      capabilities.functionCalling = model.supportsTools;
    return [
      {
        id: model.name,
        ...(model.displayName ? { displayName: model.displayName } : {}),
        ...(typeof model.contextLength === 'number' ? { contextWindow: model.contextLength } : {}),
        ...(Object.keys(capabilities).length ? { capabilities } : {}),
      },
    ];
  });
}

function toModelInfo(model: RawProviderModel): ModelInfo | null {
  if (typeof model.id !== 'string' || !model.id) return null;
  assertOptionalArray(model.input_modalities, 'model input_modalities');
  assertOptionalArray(model.output_modalities, 'model output_modalities');
  assertOptionalArray(model.tags, 'model tags');
  const providers = providerObjectArray<NonNullable<RawProviderModel['providers']>[number]>(
    model.providers,
    'model providers',
  );
  const contextWindow = model.context_length ?? model.context_window;
  const capabilities: NonNullable<ModelInfo['capabilities']> = {};
  if (model.input_modalities?.includes('image')) capabilities.vision = true;
  if (typeof model.capabilities?.reasoning === 'boolean')
    capabilities.reasoning = model.capabilities.reasoning;
  if (typeof model.supports_image_in === 'boolean') capabilities.vision = model.supports_image_in;
  if (typeof model.supports_reasoning === 'boolean')
    capabilities.reasoning = model.supports_reasoning;
  if (model.tags?.includes('vision')) capabilities.vision = true;
  if (model.tags?.includes('reasoning')) capabilities.reasoning = true;
  if (model.tags?.includes('tool-use')) capabilities.functionCalling = true;
  if (model.providers) {
    capabilities.functionCalling = providers.some(
      (provider) => provider.status === 'live' && provider.supports_tools === true,
    );
  }
  return {
    id: model.id,
    ...(model.display_name || model.name ? { displayName: model.display_name ?? model.name } : {}),
    ...(typeof contextWindow === 'number' ? { contextWindow } : {}),
    ...(typeof model.max_tokens === 'number' ? { maxOutputTokens: model.max_tokens } : {}),
    ...(Object.keys(capabilities).length ? { capabilities } : {}),
  };
}

function anthropicModelHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
}

function stripTrailing(u: string): string {
  return u.replace(/\/+$/, '');
}

function ollamaRoot(baseUrl: string): string {
  return stripTrailing(baseUrl).replace(/\/v1$/, '');
}

async function readProviderJson<T>(response: ConnectionEffectResponse): Promise<T> {
  const value = await response.readJson<unknown>();
  if (value === null || typeof value !== 'object') {
    throw new ConnectionEffectInvalidResponseError('Invalid provider JSON response structure');
  }
  return value as T;
}

function providerObjectArray<T extends object>(
  value: unknown,
  label: string,
  required = false,
): T[] {
  if (value === undefined && !required) return [];
  if (
    !Array.isArray(value) ||
    value.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))
  ) {
    throw new ConnectionEffectInvalidResponseError(`Invalid ${label} response`);
  }
  return value as T[];
}

function assertOptionalArray(
  value: unknown,
  label: string,
): asserts value is unknown[] | undefined {
  if (value !== undefined && !Array.isArray(value)) {
    throw new ConnectionEffectInvalidResponseError(`Invalid ${label}`);
  }
}

function nextProviderPageToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    typeof value !== 'string' ||
    value.length > PROVIDER_PAGE_TOKEN_MAX_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ConnectionEffectInvalidResponseError('Invalid provider model page token');
  }
  return value;
}

function classifyDiscoveryError(error: unknown): ConnectionEffectError {
  if (error instanceof ConnectionEffectFetchError) return { kind: error.kind };
  if (error instanceof ConnectionEffectHttpError) {
    return classifyConnectionEffectStatus(error.status);
  }
  if (error instanceof ConnectionEffectInvalidResponseError || error instanceof SyntaxError) {
    return { kind: 'invalid_response' };
  }
  return { kind: 'unknown' };
}
