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
  classifyConnectionModelInventory,
  connectionEnabledModelIds,
  type ConnectionTestErrorClass,
  type ConnectionTestResult,
  type LlmConnection,
} from '@maka/core/llm-connections';
import { anthropicV1Url, googleApiUrl, openResponsesUrl } from './provider-urls.js';
import { resolveModelRuntime } from './model-runtime.js';
import { fetchGitHubCopilotModels } from './model-fetcher.js';
import {
  CONNECTION_EFFECT_ERROR_BODY_MAX_BYTES,
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
  type ConnectionTestEffectOutcome,
} from './connection-effect-outcome.js';

const CONNECTION_TEST_TIMEOUT_MS = 15_000;

export interface ConnectionTestOptions extends ConnectionEffectFetchOptions {
  readonly timeoutMs?: number;
}

/**
 * Prefer an explicit model, then a still-live configured model. Legacy
 * connections without a discovered inventory keep the historical
 * default/fallback order.
 *
 * A `'live'` catalog ORDERS the user's own candidates, it does not filter
 * them: a model the provider just listed is likelier to answer, so probe that
 * one first. But no catalog removes a candidate. A snapshot would otherwise
 * redirect the probe onto a model the user never chose (#1584), and even a
 * live list can lag the account — when it does, the provider's own error is a
 * better answer than a model Maka substituted silently.
 */
function resolveConnectionTestModel(
  connection: ConnectionEffectConnection,
  model: string | undefined,
  fallbackModels: readonly string[],
): string | undefined {
  const explicitModel = model?.trim();
  if (explicitModel) return explicitModel;

  const discoveredIds =
    connection.models?.map(({ id }) => id.trim()).filter((id) => id.length > 0) ?? [];
  const enabled = connectionEnabledModelIds(connection);
  const listed =
    classifyConnectionModelInventory(connection) === 'live' ? new Set(discoveredIds) : undefined;
  const preferred = listed
    ? [...enabled.filter((id) => listed.has(id)), ...enabled.filter((id) => !listed.has(id))]
    : enabled;
  const candidates = [...preferred, ...fallbackModels, ...discoveredIds];
  for (const candidate of candidates) {
    const id = candidate.trim();
    if (id) return id;
  }
  return undefined;
}

export async function testConnection(
  connection: LlmConnection,
  apiKey: string,
  model?: string,
  options: ConnectionTestOptions = {},
): Promise<ConnectionTestResult> {
  const t0 = Date.now();
  const configuredTimeoutMs = options.timeoutMs;
  const timeoutMs =
    typeof configuredTimeoutMs === 'number' &&
    Number.isFinite(configuredTimeoutMs) &&
    configuredTimeoutMs > 0
      ? Math.floor(configuredTimeoutMs)
      : CONNECTION_TEST_TIMEOUT_MS;
  try {
    return await testConnectionStrict(connection, apiKey, model, options.fetch, t0, timeoutMs);
  } catch (error) {
    return connectionTestFailure(error, t0, true);
  }
}

export async function runConnectionTestEffect(
  connection: ConnectionEffectConnection,
  apiKey: string,
  options: ConnectionEffectFetchDependency,
  model?: string,
): Promise<ConnectionTestEffectOutcome> {
  const t0 = Date.now();
  try {
    const result = await testConnectionStrict(connection, apiKey, model, options.fetch, t0);
    if (result.ok) {
      if (!result.modelTested || result.latencyMs === undefined) {
        return { ok: false, error: { kind: 'invalid_response' } };
      }
      return {
        ok: true,
        modelId: result.modelTested,
        latencyMs: result.latencyMs,
      };
    }
    return {
      ok: false,
      error: classifyConnectionTestResult(result),
      ...connectionTestMeasurements(result),
    };
  } catch (error) {
    return {
      ok: false,
      error: classifyConnectionTestError(error),
      latencyMs: Date.now() - t0,
    };
  }
}

async function testConnectionStrict(
  connection: ConnectionEffectConnection,
  apiKey: string,
  model: string | undefined,
  fetchFn: ConnectionEffectFetch | undefined,
  t0: number,
  timeoutMs = CONNECTION_TEST_TIMEOUT_MS,
): Promise<ConnectionTestResult> {
  const defaults = PROVIDER_DEFAULTS[connection.providerType];
  // Unknown providerType → can't pick an auth path or fallback model. Return a
  // clear failure rather than crashing. Mirrors `isRealConnection`.
  if (!defaults) {
    return { ok: false, errorMessage: `Unknown provider type "${connection.providerType}"` };
  }
  const auth = defaults.authKind;
  const secret = auth === 'none' ? '' : apiKey;
  const testModel = resolveConnectionTestModel(connection, model, defaults.fallbackModels);

  if (!testModel) {
    return { ok: false, errorMessage: 'No model to test' };
  }
  if (connection.providerType === 'opencode-free' && !model?.trim()) {
    const candidates = [
      ...new Set([...connectionEnabledModelIds(connection), ...defaults.fallbackModels]),
    ];
    let lastFailure: ConnectionTestResult | undefined;
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]!;
      const remainingMs = timeoutMs - (Date.now() - t0);
      if (remainingMs <= 0) {
        return connectionTestFailure(new ConnectionEffectFetchError('timeout'), t0);
      }
      const remainingCandidates = candidates.length - index;
      const attemptTimeoutMs = Math.max(1, Math.floor(remainingMs / remainingCandidates));
      try {
        const result = await testConnectionModel(
          connection,
          secret,
          candidate,
          fetchFn,
          t0,
          attemptTimeoutMs,
        );
        if (result.ok) return result;
        lastFailure = result;
      } catch (error) {
        lastFailure = connectionTestFailure(error, t0, true);
      }
    }
    return lastFailure ?? connectionTestFailure(new ConnectionEffectFetchError('timeout'), t0);
  }

  return await testConnectionModel(connection, secret, testModel, fetchFn, t0, timeoutMs);
}

async function testConnectionModel(
  connection: ConnectionEffectConnection,
  secret: string,
  testModel: string,
  fetchFn: ConnectionEffectFetch | undefined,
  t0: number,
  timeoutMs = CONNECTION_TEST_TIMEOUT_MS,
): Promise<ConnectionTestResult> {
  // Ahead of `resolveModelRuntime`, which throws for an adapter it cannot name.
  // A stored connection can still be opened long after its provider stopped
  // being offered, and the caller renders this result — so a retired provider
  // has to fail the test, not crash it.
  if (PROVIDER_DEFAULTS[connection.providerType]?.runtimeAdapter.kind === 'unavailable') {
    return retiredProviderTestResult(connection.providerType);
  }
  const { adapter, baseUrl, wire } = resolveModelRuntime(connection, testModel);

  switch (adapter.kind) {
    case 'anthropic':
      return await probeAnthropic(connection, baseUrl, secret, testModel, t0, fetchFn);
    case 'unavailable':
      // Unreachable: the guard above returns first. The arm keeps the switch
      // exhaustive so a newly retired provider cannot slip past it.
      return retiredProviderTestResult(connection.providerType);
    case 'openai':
      return wire === 'openai-responses'
        ? await probeOpenAIResponses(baseUrl, secret, testModel, t0, fetchFn)
        : await probeOpenAI(connection, baseUrl, secret, testModel, t0, fetchFn, timeoutMs);
    case 'openai-codex':
      return await probeOpenAI(connection, baseUrl, secret, testModel, t0, fetchFn, timeoutMs);
    case 'openai-compatible':
      return wire === 'openai-responses'
        ? await probeOpenAIResponses(baseUrl, secret, testModel, t0, fetchFn)
        : await probeOpenAI(connection, baseUrl, secret, testModel, t0, fetchFn, timeoutMs);
    case 'github-copilot':
      return await probeGitHubCopilot(baseUrl, secret, testModel, t0, fetchFn);
    case 'google':
      return await probeGoogle(
        baseUrl,
        secret,
        testModel,
        t0,
        adapter.normalizeBaseUrl !== false,
        fetchFn,
      );
    case 'cohere':
      return await probeCohere(baseUrl, secret, testModel, t0, fetchFn);
  }
}

async function probeGitHubCopilot(
  baseUrl: string,
  apiKey: string,
  model: string,
  t0: number,
  fetchFn: ConnectionEffectFetch | undefined,
): Promise<ConnectionTestResult> {
  const models = await fetchGitHubCopilotModels(baseUrl, apiKey, fetchFn);
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
  fetchFn: ConnectionEffectFetch | undefined,
): Promise<ConnectionTestResult> {
  const r = await fetchForConnectionEffect(fetchFn, openResponsesUrl(baseUrl), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      store: false,
      max_output_tokens: 16,
      input: [{ role: 'user', content: 'Hi' }],
    }),
    timeoutMs: CONNECTION_TEST_TIMEOUT_MS,
  });
  if (!r.ok) return httpFailure(r, t0);
  await r.cancel();
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

async function probeCohere(
  baseUrl: string,
  apiKey: string,
  model: string,
  t0: number,
  fetchFn: ConnectionEffectFetch | undefined,
): Promise<ConnectionTestResult> {
  const r = await fetchForConnectionEffect(fetchFn, `${stripTrailing(baseUrl)}/chat`, {
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
  await r.cancel();
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

function retiredProviderTestResult(providerType: string): ConnectionTestResult {
  return { ok: false, errorMessage: `"${providerType}" is retired and can no longer be used.` };
}

async function probeAnthropic(
  connection: Pick<ConnectionEffectConnection, 'providerType'>,
  baseUrl: string,
  secret: string,
  model: string,
  t0: number,
  fetchFn: ConnectionEffectFetch | undefined,
): Promise<ConnectionTestResult> {
  const headers: Record<string, string> = {
    'x-api-key': secret,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };

  const r = await fetchForConnectionEffect(fetchFn, anthropicV1Url(baseUrl, '/messages'), {
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
  await r.cancel();
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

async function probeOpenAI(
  connection: Pick<ConnectionEffectConnection, 'providerType'>,
  baseUrl: string,
  apiKey: string,
  model: string,
  t0: number,
  fetchFn: ConnectionEffectFetch | undefined,
  timeoutMs = CONNECTION_TEST_TIMEOUT_MS,
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
  const r = await fetchForConnectionEffect(fetchFn, `${stripTrailing(baseUrl)}/chat/completions`, {
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
    timeoutMs,
  });
  if (!r.ok) return httpFailure(r, t0);
  if (connection.providerType === 'opencode-free') {
    const body = await r.readJson<unknown>();
    if (!isOpenAIChatCompletion(body)) {
      return {
        ok: false,
        errorMessage: 'OpenCode Free returned no valid chat completion',
        errorClass: 'provider_unavailable',
        latencyMs: Date.now() - t0,
        modelTested: model,
      };
    }
    return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
  }
  await r.cancel();
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

function isOpenAIChatCompletion(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const choices = (value as { choices?: unknown }).choices;
  return (
    Array.isArray(choices) &&
    choices.some((choice) => {
      if (!choice || typeof choice !== 'object') return false;
      const message = (choice as { message?: unknown }).message;
      if (!message || typeof message !== 'object') return false;
      const completion = message as {
        content?: unknown;
        reasoning?: unknown;
        reasoning_content?: unknown;
        tool_calls?: unknown;
      };
      return (
        typeof completion.content === 'string' ||
        typeof completion.reasoning === 'string' ||
        typeof completion.reasoning_content === 'string' ||
        (Array.isArray(completion.tool_calls) && completion.tool_calls.length > 0)
      );
    })
  );
}

async function probeGoogle(
  baseUrl: string,
  apiKey: string,
  model: string,
  t0: number,
  normalizeBaseUrl: boolean,
  fetchFn: ConnectionEffectFetch | undefined,
): Promise<ConnectionTestResult> {
  const url = normalizeBaseUrl
    ? googleApiUrl(baseUrl, `/models/${encodeURIComponent(model)}:generateContent`, apiKey)
    : `${stripTrailing(baseUrl)}/models/${encodeURIComponent(model)}:generateContent`;
  const r = await fetchForConnectionEffect(fetchFn, url, {
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
  await r.cancel();
  return { ok: true, latencyMs: Date.now() - t0, modelTested: model };
}

async function httpFailure(r: ConnectionEffectResponse, t0: number): Promise<ConnectionTestResult> {
  const statusCode = r.status;
  if (statusCode === 429) {
    await r.cancel();
    return {
      ok: false,
      errorMessage:
        'OAuth 已登录，但当前账号或 provider 正在 rate limit。请稍后重试，或先切换到其它可用模型。',
      statusCode,
      errorClass: 'provider_unavailable',
      latencyMs: Date.now() - t0,
    };
  }
  const errorBody = await r.readText(CONNECTION_EFFECT_ERROR_BODY_MAX_BYTES);
  return {
    ok: false,
    errorMessage: `${statusCode} ${errorBody.slice(0, 200)}`,
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

function connectionTestFailure(
  error: unknown,
  t0: number,
  preserveLegacyTimeoutClassification = false,
): ConnectionTestResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    errorMessage: message,
    errorClass:
      (error instanceof ConnectionEffectFetchError && error.kind === 'timeout') ||
      (preserveLegacyTimeoutClassification && message.toLowerCase().includes('timeout'))
        ? 'timeout'
        : 'network',
    latencyMs: Date.now() - t0,
  };
}

function classifyConnectionTestError(error: unknown): ConnectionEffectError {
  if (error instanceof ConnectionEffectFetchError) return { kind: error.kind };
  if (error instanceof ConnectionEffectHttpError) {
    return classifyConnectionEffectStatus(error.status);
  }
  if (error instanceof ConnectionEffectInvalidResponseError || error instanceof SyntaxError) {
    return { kind: 'invalid_response' };
  }
  return { kind: 'unknown' };
}

function classifyConnectionTestResult(result: ConnectionTestResult): ConnectionEffectError {
  if (result.statusCode !== undefined) {
    const statusError = classifyConnectionEffectStatus(result.statusCode);
    if (statusError.kind !== 'unknown') return statusError;
  }
  return {
    kind: connectionTestErrorKind(result.errorClass),
    ...(result.statusCode === undefined ? {} : { statusCode: result.statusCode }),
  };
}

function connectionTestMeasurements(
  result: ConnectionTestResult,
): Pick<Extract<ConnectionTestEffectOutcome, { readonly ok: false }>, 'modelId' | 'latencyMs'> {
  return {
    ...(result.modelTested === undefined ? {} : { modelId: result.modelTested }),
    ...(result.latencyMs === undefined ? {} : { latencyMs: result.latencyMs }),
  };
}

function connectionTestErrorKind(
  errorClass: ConnectionTestErrorClass | undefined,
): ConnectionEffectError['kind'] {
  switch (errorClass) {
    case 'auth':
    case 'timeout':
    case 'provider_unavailable':
    case 'network':
      return errorClass;
    case 'unknown':
    case undefined:
      return 'unknown';
  }
}
