import {
  PROVIDER_DEFAULTS,
  effectiveBaseUrl,
  providerAuthSupportsApiKey,
  type LlmConnection,
  type ModelInfo,
} from '@maka/core/llm-connections';
import { generalizedErrorMessage } from '@maka/core/redaction';
import { proxiedFetch } from './bots/proxied-fetch.js';
import { anthropicV1Url, googleApiUrl } from './provider-urls.js';
import { claudeSubscriptionHeaders, openAiCodexHeaders } from './subscription-auth.js';
import {
  GITHUB_COPILOT_API_VERSION,
  GITHUB_COPILOT_COMPAT_HEADERS,
} from './subscription-credentials.js';

const MODEL_FETCH_TIMEOUT_MS = 10_000;

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
): Promise<ModelInfo[]> {
  try {
    return await fetchProviderModelsStrict(connection, apiKey);
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

async function fetchProviderModelsStrict(
  connection: LlmConnection,
  apiKey: string,
): Promise<ModelInfo[]> {
  const baseUrl = effectiveBaseUrl(connection);
  const definition = PROVIDER_DEFAULTS[connection.providerType];
  // Unknown providerType → no discovery path. Throw a clear error (caught and
  // generalized by the caller) rather than crashing on `.modelDiscovery`.
  // Mirrors `isFakeBackend` in @maka/core/connection-readiness.ts.
  if (!definition) {
    throw new Error(`Unknown provider type "${connection.providerType}"`);
  }
  const discovery = definition.modelDiscovery;

  if (discovery.kind === 'fallback') {
    return definition.fallbackModels.map((id) => ({ id }));
  }
  if (discovery.kind === 'ollama') {
    const r = await proxiedFetch(`${ollamaRoot(baseUrl)}/api/tags`, {
      timeoutMs: MODEL_FETCH_TIMEOUT_MS,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = (await r.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? []).flatMap((model) => (model.name ? [{ id: model.name }] : []));
  }
  if (discovery.kind === 'fireworks') {
    return fetchFireworksModels(baseUrl, apiKey, discovery);
  }
  if (discovery.kind === 'cohere') {
    return fetchCohereModels(baseUrl, apiKey);
  }
  if (discovery.auth === 'github-copilot') {
    return fetchGitHubCopilotModels(baseUrl, apiKey);
  }
  if (discovery.auth === 'openai-codex') {
    return fetchOpenAiCodexModels(baseUrl, apiKey);
  }

  switch (definition.protocol) {
    case 'anthropic': {
      const r = await proxiedFetch(anthropicV1Url(baseUrl, '/models'), {
        headers: anthropicModelHeaders(
          discovery.auth === 'claude-subscription' ? discovery.auth : undefined,
          apiKey,
        ),
        timeoutMs: MODEL_FETCH_TIMEOUT_MS,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { data?: RawProviderModel[] };
      const models = (data.data ?? [])
        .map(toModelInfo)
        .filter((model): model is ModelInfo => model !== null);
      return filterDiscoveredModels(models, discovery.filter, definition.fallbackModels);
    }
    case 'openai': {
      const r = await proxiedFetch(modelListUrl(baseUrl, discovery.path, discovery.query), {
        headers: {
          'content-type': 'application/json',
          ...(apiKey &&
          (discovery.auth === 'oauth-bearer' ||
            (discovery.auth !== 'none' && providerAuthSupportsApiKey(connection.providerType)))
            ? { authorization: `Bearer ${apiKey}` }
            : {}),
        },
        timeoutMs: MODEL_FETCH_TIMEOUT_MS,
      });
      if (!r.ok) {
        if (connection.providerType === 'xai-oauth') {
          throw new ProviderModelDiscoveryHttpError(r.status);
        }
        throw new Error(`HTTP ${r.status}`);
      }
      const data = (await r.json()) as { data?: RawProviderModel[] } | RawProviderModel[];
      const rawModels =
        discovery.responseShape === 'array-or-data'
          ? Array.isArray(data)
            ? data
            : (data.data ?? [])
          : Array.isArray(data)
            ? []
            : (data.data ?? []);
      const models = rawModels
        .filter((model) => discovery.filter !== 'language-models' || model.type === 'language')
        .map(toModelInfo)
        .filter((model): model is ModelInfo => model !== null);
      return filterDiscoveredModels(models, discovery.filter, definition.fallbackModels);
    }
    case 'google': {
      const r = await proxiedFetch(googleApiUrl(baseUrl, '/models', apiKey), {
        timeoutMs: MODEL_FETCH_TIMEOUT_MS,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { models?: Array<{ name?: string }> };
      return (data.models ?? []).flatMap((model) => {
        const id = model.name?.split('/').pop();
        return id ? [{ id }] : [];
      });
    }
    case 'cohere':
      throw new Error('Cohere requires native model discovery');
  }
}

export async function fetchGitHubCopilotModels(
  baseUrl: string,
  accessToken: string,
  fetchFn?: typeof fetch,
): Promise<ModelInfo[]> {
  const response = await (fetchFn ?? proxiedFetch)(`${stripTrailing(baseUrl)}/models`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...GITHUB_COPILOT_COMPAT_HEADERS,
      'Openai-Intent': 'conversation-edits',
      'X-GitHub-Api-Version': GITHUB_COPILOT_API_VERSION,
    },
    ...(fetchFn
      ? { signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS) }
      : { timeoutMs: MODEL_FETCH_TIMEOUT_MS }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = (await response.json()) as { data?: RawGitHubCopilotModel[] };
  if (!Array.isArray(payload.data)) throw new Error('Invalid GitHub Copilot models response');
  return payload.data.flatMap(toGitHubCopilotModelInfo);
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
export class OpenAiCodexDiscoveryError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
    this.name = 'OpenAiCodexDiscoveryError';
  }
}

/** Structured status for standard provider `/models` endpoints. */
export class ProviderModelDiscoveryHttpError extends Error {
  constructor(public readonly status: number) {
    super(`HTTP ${status}`);
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
  fetchFn?: typeof fetch,
): Promise<ModelInfo[]> {
  const response = await (fetchFn ?? proxiedFetch)(
    `${stripTrailing(baseUrl)}/models?client_version=1.0.0`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...openAiCodexHeaders(accessToken),
        'content-type': 'application/json',
      },
      ...(fetchFn
        ? { signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS) }
        : { timeoutMs: MODEL_FETCH_TIMEOUT_MS }),
    },
  );
  if (!response.ok) throw new OpenAiCodexDiscoveryError(response.status);
  const payload = (await response.json()) as { models?: RawOpenAiCodexModel[] };
  if (!Array.isArray(payload?.models)) throw new Error('Invalid OpenAI Codex models response');
  const visible = payload.models.filter((model) => {
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
    !model.id ||
    model.model_picker_enabled !== true ||
    model.policy?.state === 'disabled' ||
    model.capabilities?.supports?.tool_calls !== true
  )
    return [];
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
    limits?.vision?.supported_media_types?.some((type) => type.startsWith('image/')) === true;
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

async function fetchCohereModels(baseUrl: string, apiKey: string): Promise<ModelInfo[]> {
  const root = stripTrailing(baseUrl).replace(/\/v2$/, '');
  const models: ModelInfo[] = [];
  let pageToken: string | undefined;
  do {
    const query = new URLSearchParams({ endpoint: 'chat', page_size: '1000' });
    if (pageToken) query.set('page_token', pageToken);
    const response = await proxiedFetch(`${root}/v1/models?${query.toString()}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      timeoutMs: MODEL_FETCH_TIMEOUT_MS,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as {
      models?: RawCohereModel[];
      next_page_token?: string;
    };
    models.push(
      ...(data.models ?? []).flatMap((model) => {
        if (!model.name || model.is_deprecated === true || !model.endpoints?.includes('chat'))
          return [];
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
    pageToken = data.next_page_token || undefined;
  } while (pageToken);
  return models;
}

function filterDiscoveredModels(
  models: ModelInfo[],
  filter: 'fallback-models' | 'language-models' | 'tool-capable' | undefined,
  fallbackModels: readonly string[],
): ModelInfo[] {
  if (filter === 'tool-capable') {
    return models.filter((model) => model.capabilities?.functionCalling === true);
  }
  if (filter !== 'fallback-models') return models;
  const supported = new Set(fallbackModels);
  return models.filter((model) => supported.has(model.id));
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
): Promise<ModelInfo[]> {
  const root = stripTrailing(baseUrl).replace(/\/inference\/v1$/, '');
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${apiKey}`,
  };
  const fetchPages = async <T>(
    path: string,
    query: Readonly<Record<string, string>>,
    itemKey: 'accounts' | 'models',
  ): Promise<T[]> => {
    const items: T[] = [];
    let pageToken: string | undefined;
    do {
      const search = new URLSearchParams(query);
      if (pageToken) search.set('pageToken', pageToken);
      const response = await proxiedFetch(`${root}${path}?${search.toString()}`, {
        headers,
        timeoutMs: MODEL_FETCH_TIMEOUT_MS,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as {
        accounts?: T[];
        models?: T[];
        nextPageToken?: string;
      };
      items.push(...(data[itemKey] ?? []));
      pageToken = data.nextPageToken || undefined;
    } while (pageToken);
    return items;
  };

  const accounts = await fetchPages<{ name?: string }>(
    discovery.accountsPath,
    { pageSize: '200' },
    'accounts',
  );
  const accountNames = [
    ...accounts.flatMap((account) =>
      account.name && /^accounts\/[^/]+$/.test(account.name) ? [account.name] : [],
    ),
    discovery.publicAccount,
  ].filter((name, index, names) => names.indexOf(name) === index);
  const modelLists = await Promise.all(
    accountNames.map((accountName) =>
      fetchPages<RawFireworksModel>(`/v1/${accountName}/models`, discovery.query, 'models'),
    ),
  );

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
  if (!model.id) return null;
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
    capabilities.functionCalling = model.providers.some(
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

function anthropicModelHeaders(
  auth: 'claude-subscription' | undefined,
  apiKey: string,
): Record<string, string> {
  if (auth === 'claude-subscription') {
    return {
      ...claudeSubscriptionHeaders(),
      Authorization: `Bearer ${apiKey}`,
      'anthropic-version': '2023-06-01',
    };
  }
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
