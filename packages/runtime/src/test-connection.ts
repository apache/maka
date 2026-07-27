import {
  PROVIDER_DEFAULTS,
  connectionEnabledModelIds,
  type ConnectionTestResult,
  type LlmConnection,
} from '@maka/core/llm-connections';
import { openAiAdapterApiProtocol } from '@maka/core/model-metadata';
import { proxiedFetch } from './bots/proxied-fetch.js';
import { anthropicV1Url, googleApiUrl } from './provider-urls.js';
import { resolveModelRuntime } from './model-runtime.js';
import { claudeSubscriptionHeaders } from './subscription-auth.js';
import { fetchGitHubCopilotModels } from './model-fetcher.js';

const CONNECTION_TEST_TIMEOUT_MS = 15_000;

/**
 * Prefer an explicit model, then a still-live configured model. Legacy
 * connections without a discovered inventory keep the historical
 * default/fallback order.
 */
function resolveConnectionTestModel(
  connection: LlmConnection,
  model: string | undefined,
  fallbackModels: readonly string[],
): string | undefined {
  const explicitModel = model?.trim();
  if (explicitModel) return explicitModel;

  const hasAuthoritativeInventory =
    connection.modelSource === 'fetched' && Array.isArray(connection.models);
  const discoveredIds =
    connection.models?.map(({ id }) => id.trim()).filter((id) => id.length > 0) ?? [];
  const discovered =
    hasAuthoritativeInventory || discoveredIds.length > 0 ? new Set(discoveredIds) : undefined;
  const candidates = [
    ...connectionEnabledModelIds(connection),
    ...fallbackModels,
    ...discoveredIds,
  ];
  for (const candidate of candidates) {
    const id = candidate.trim();
    if (!id || (discovered && !discovered.has(id))) continue;
    return id;
  }
  return undefined;
}

export async function testConnection(
  connection: LlmConnection,
  apiKey: string,
  model?: string,
): Promise<ConnectionTestResult> {
  const t0 = Date.now();
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  // Unknown providerType → can't pick an auth path or fallback model. Return a
  // clear failure rather than crashing. Mirrors `isFakeBackend`.
  if (!defaults) {
    return { ok: false, errorMessage: `Unknown provider type "${connection.providerType}"` };
  }
  const auth = defaults.authKind;
  const secret = auth === 'none' ? '' : apiKey;
  const testModel = resolveConnectionTestModel(connection, model, defaults.fallbackModels);

  if (!testModel) {
    return { ok: false, errorMessage: 'No model to test' };
  }
  const { adapter, baseUrl, apiProtocol } = resolveModelRuntime(connection, testModel);

  try {
    switch (adapter.kind) {
      case 'anthropic':
      case 'claude-subscription':
        return await probeAnthropic(connection, baseUrl, secret, testModel, t0);
      case 'openai': {
        const resolvedApiProtocol =
          adapter.apiProtocol ??
          apiProtocol ??
          openAiAdapterApiProtocol(testModel, connection.providerType);
        return resolvedApiProtocol === 'openai-responses'
          ? await probeOpenAIResponses(baseUrl, secret, testModel, t0)
          : await probeOpenAI(connection, baseUrl, secret, testModel, t0);
      }
      case 'openai-codex':
      case 'openai-compatible':
        return await probeOpenAI(connection, baseUrl, secret, testModel, t0);
      case 'github-copilot':
        return await probeGitHubCopilot(baseUrl, secret, testModel, t0);
      case 'google':
        return await probeGoogle(
          baseUrl,
          secret,
          testModel,
          t0,
          adapter.normalizeBaseUrl !== false,
        );
      case 'cohere':
        return await probeCohere(baseUrl, secret, testModel, t0);
      case 'unavailable':
        throw new Error(`${connection.providerType} is experimental and not wired yet`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      errorMessage: message,
      errorClass: message.toLowerCase().includes('timeout') ? 'timeout' : 'network',
      latencyMs: Date.now() - t0,
    };
  }
}

async function probeGitHubCopilot(
  baseUrl: string,
  apiKey: string,
  model: string,
  t0: number,
): Promise<ConnectionTestResult> {
  const models = await fetchGitHubCopilotModels(baseUrl, apiKey);
  if (!models.some(({ id }) => id === model)) {
    return {
      ok: false,
      errorMessage: 'Selected model is not available for this GitHub Copilot account',
    };
  }
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

async function probeOpenAIResponses(
  baseUrl: string,
  apiKey: string,
  model: string,
  t0: number,
): Promise<ConnectionTestResult> {
  const r = await proxiedFetch(`${stripTrailing(baseUrl)}/responses`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_output_tokens: 16,
      input: [{ role: 'user', content: 'Hi' }],
    }),
    timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
  });
  if (!r.ok) return httpFailure(r, t0);
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

async function probeCohere(
  baseUrl: string,
  apiKey: string,
  model: string,
  t0: number,
): Promise<ConnectionTestResult> {
  const r = await proxiedFetch(`${stripTrailing(baseUrl)}/chat`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
  });
  if (!r.ok) return httpFailure(r, t0);
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

async function probeAnthropic(
  connection: LlmConnection,
  baseUrl: string,
  secret: string,
  model: string,
  t0: number,
): Promise<ConnectionTestResult> {
  const headers: Record<string, string> =
    connection.providerType === 'claude-subscription'
      ? {
          ...claudeSubscriptionHeaders(),
          Authorization: `Bearer ${secret}`,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        }
      : {
          'x-api-key': secret,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        };

  if (connection.providerType === 'claude-subscription') {
    // Claude Subscription credentials are account-scoped OAuth tokens.
    // The real send path has to use the Claude Code cloak shape; a
    // separate `/api/oauth/profile` probe can fail with "Invalid
    // request format" even when the stored login is usable. Treat the
    // presence of a resolved main-process OAuth token as the connection
    // test and let send-path failures surface during an actual turn.
    return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
  }

  const r = await proxiedFetch(anthropicV1Url(baseUrl, '/messages'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
  });
  if (!r.ok) return httpFailure(r, t0);
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

async function probeOpenAI(
  connection: LlmConnection,
  baseUrl: string,
  apiKey: string,
  model: string,
  t0: number,
): Promise<ConnectionTestResult> {
  if (connection.providerType === 'openai-codex') {
    // Codex Subscription credentials are ChatGPT account-scoped OAuth
    // tokens. A live `/responses` probe is not a stable readiness test:
    // the backend can hold or reject small synthetic requests even when
    // the stored login is valid and the real send path has enough context.
    // Mirror Claude OAuth and treat a resolved main-process OAuth token as
    // the explicit connection test; actual turn failures still surface in
    // chat with the provider error class.
    return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
  }
  const r = await proxiedFetch(`${stripTrailing(baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Hi' }],
    }),
    timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
  });
  if (!r.ok) return httpFailure(r, t0);
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

async function probeGoogle(
  baseUrl: string,
  apiKey: string,
  model: string,
  t0: number,
  normalizeBaseUrl: boolean,
): Promise<ConnectionTestResult> {
  const url = normalizeBaseUrl
    ? googleApiUrl(baseUrl, `/models/${encodeURIComponent(model)}:generateContent`, apiKey)
    : `${stripTrailing(baseUrl)}/models/${encodeURIComponent(model)}:generateContent`;
  const r = await proxiedFetch(url, {
    method: 'POST',
    headers: {
      ...(normalizeBaseUrl ? {} : { 'x-goog-api-key': apiKey }),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Hi' }] }],
      generationConfig: { maxOutputTokens: 16 },
    }),
    timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
  });
  if (!r.ok) return httpFailure(r, t0);
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

async function httpFailure(r: Response, t0: number): Promise<ConnectionTestResult> {
  const statusCode = r.status;
  if (statusCode === 429) {
    return {
      ok: false,
      errorMessage:
        'OAuth 已登录，但当前账号或 provider 正在 rate limit。请稍后重试，或先切换到其它可用模型。',
      statusCode,
      errorClass: 'provider_unavailable',
      latencyMs: Date.now() - t0,
    };
  }
  return {
    ok: false,
    errorMessage: `${statusCode} ${(await r.text()).slice(0, 200)}`,
    statusCode,
    errorClass: classifyHttpStatus(statusCode),
    latencyMs: Date.now() - t0,
  };
}

function stripTrailing(u: string): string {
  return u.replace(/\/+$/, '');
}

function classifyHttpStatus(statusCode: number): ConnectionTestResult['errorClass'] {
  if (statusCode === 401 || statusCode === 403) return 'auth';
  if (statusCode >= 500) return 'provider_unavailable';
  return 'unknown';
}
