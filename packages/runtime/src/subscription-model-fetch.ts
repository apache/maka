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

import { redactSecrets } from '@maka/core/redaction';
import type { RuntimeExecutionConnection } from '@maka/core/llm-connections';
import {
  GITHUB_COPILOT_API_VERSION,
  GITHUB_COPILOT_COMPAT_HEADERS,
} from './subscription-credentials.js';
import { openAiCodexHeaders } from './subscription-auth.js';

export interface SubscriptionModelFetchInput {
  connection: RuntimeExecutionConnection;
  sessionId: string;
  modelId: string;
  fetchFn?: typeof fetch;
  /** Force-refreshes a remotely invalidated OAuth token for one safe 401 replay. */
  refreshOAuthAccessToken?: () => Promise<string | null>;
}

export function buildSubscriptionModelFetch(
  input: SubscriptionModelFetchInput,
): typeof fetch | undefined {
  if (input.connection.providerType === 'openai-codex') {
    return buildOpenAiCodexFetch(
      input.sessionId,
      input.fetchFn ?? fetch,
      input.refreshOAuthAccessToken,
    );
  }
  if (input.connection.providerType === 'github-copilot') {
    return buildGitHubCopilotFetch(input.fetchFn ?? fetch);
  }
  if (input.connection.providerType === 'xai-oauth' && input.refreshOAuthAccessToken) {
    return buildOAuth401ReplayFetch(input.fetchFn ?? fetch, input.refreshOAuthAccessToken);
  }
  return undefined;
}

function buildGitHubCopilotFetch(fetchFn: typeof fetch): typeof fetch {
  return async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(GITHUB_COPILOT_COMPAT_HEADERS)) {
      headers.set(name, value);
    }
    headers.set('Openai-Intent', 'conversation-edits');
    headers.set('X-GitHub-Api-Version', GITHUB_COPILOT_API_VERSION);
    headers.set('x-initiator', githubCopilotInitiator(init?.body));
    if (githubCopilotBodyHasVision(init?.body)) headers.set('Copilot-Vision-Request', 'true');
    return fetchFn(url, { ...init, headers });
  };
}

function githubCopilotInitiator(body: BodyInit | null | undefined): 'user' | 'agent' {
  if (typeof body !== 'string') return 'user';
  try {
    const parsed = JSON.parse(body) as { messages?: unknown; input?: unknown };
    const items = Array.isArray(parsed.messages)
      ? parsed.messages
      : Array.isArray(parsed.input)
        ? parsed.input
        : [];
    const last = items.at(-1);
    return isUserInitiatedGitHubCopilotItem(last) ? 'user' : 'agent';
  } catch {
    return 'user';
  }
}

function isUserInitiatedGitHubCopilotItem(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as { role?: unknown; content?: unknown };
  if (item.role !== 'user') return false;
  if (!Array.isArray(item.content)) return true;
  return item.content.some(
    (part) =>
      part !== null &&
      typeof part === 'object' &&
      (part as { type?: unknown }).type !== 'tool_result',
  );
}

function githubCopilotBodyHasVision(body: BodyInit | null | undefined): boolean {
  if (typeof body !== 'string') return false;
  try {
    return containsGitHubCopilotImage(JSON.parse(body) as unknown);
  } catch {
    return false;
  }
}

function containsGitHubCopilotImage(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsGitHubCopilotImage);
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.type === 'image' || record.type === 'image_url' || record.type === 'input_image')
    return true;
  return Object.values(record).some(containsGitHubCopilotImage);
}

function buildOpenAiCodexFetch(
  sessionId: string,
  fetchFn: typeof fetch,
  refreshOAuthAccessToken?: () => Promise<string | null>,
): typeof fetch {
  return async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const headers = new Headers(init?.headers);
    headers.set('OpenAI-Beta', 'responses=experimental');
    headers.set('originator', 'codex_cli_rs');
    headers.set('session_id', sessionId);
    headers.set('x-client-request-id', sessionId);
    headers.set('content-type', 'application/json');

    const rawBody = init?.body;
    if (typeof rawBody !== 'string') {
      return checkedOpenAiCodexFetch(fetchFn, url, { ...init, headers }, refreshOAuthAccessToken);
    }

    let parsedBody: Record<string, unknown>;
    try {
      const parsed = JSON.parse(rawBody) as unknown;
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return checkedOpenAiCodexFetch(fetchFn, url, { ...init, headers }, refreshOAuthAccessToken);
      }
      parsedBody = parsed as Record<string, unknown>;
    } catch {
      return checkedOpenAiCodexFetch(fetchFn, url, { ...init, headers }, refreshOAuthAccessToken);
    }

    return checkedOpenAiCodexFetch(
      fetchFn,
      url,
      {
        ...init,
        headers,
        body: JSON.stringify({
          ...parsedBody,
          instructions: codexInstructionsFromBody(parsedBody),
          store: false,
          parallel_tool_calls: parsedBody.parallel_tool_calls ?? true,
          text: {
            ...(parsedBody.text !== null && typeof parsedBody.text === 'object'
              ? (parsedBody.text as Record<string, unknown>)
              : {}),
            verbosity:
              parsedBody.text !== null &&
              typeof parsedBody.text === 'object' &&
              typeof (parsedBody.text as { verbosity?: unknown }).verbosity === 'string'
                ? (parsedBody.text as { verbosity: string }).verbosity
                : 'medium',
          },
        }),
      },
      refreshOAuthAccessToken,
    );
  };
}

async function checkedOpenAiCodexFetch(
  fetchFn: typeof fetch,
  url: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
  refreshOAuthAccessToken?: () => Promise<string | null>,
): Promise<Response> {
  const edgeRetryDelaysMs = [2_000, 10_000, 30_000] as const;
  let authorizationReplayUsed = false;
  let edgeRetry = 0;
  let requestInit = init;
  for (;;) {
    const response = await fetchFn(url, requestInit);
    if (response.ok) return response;
    const detail = await response
      .clone()
      .text()
      .catch(() => '');
    if (
      response.status === 401 &&
      !authorizationReplayUsed &&
      refreshOAuthAccessToken &&
      isReplayableOpenAiCodexRequest(url, requestInit)
    ) {
      authorizationReplayUsed = true;
      const accessToken = await refreshOAuthAccessToken().catch(() => null);
      if (accessToken) {
        await response.body?.cancel().catch(() => undefined);
        requestInit = withRefreshedOAuthAuthorization(requestInit, accessToken, true);
        continue;
      }
    }
    if (
      edgeRetryDelaysMs[edgeRetry] !== undefined &&
      isReplayableOpenAiCodexRequest(url, requestInit) &&
      isTransientOpenAiCodexEdgeRejection(response, detail)
    ) {
      await abortableDelay(
        openAiCodexRetryAfterMs(response, edgeRetryDelaysMs[edgeRetry] ?? 30_000),
        effectiveOpenAiCodexRequestSignal(url, requestInit),
      );
      edgeRetry += 1;
      continue;
    }
    throw openAiCodexHttpError(response, detail);
  }
}

function buildOAuth401ReplayFetch(
  fetchFn: typeof fetch,
  refreshOAuthAccessToken: () => Promise<string | null>,
): typeof fetch {
  return async (url, init) => {
    const response = await fetchFn(url, init);
    if (response.status !== 401 || !isReplayableOpenAiCodexRequest(url, init)) return response;
    const accessToken = await refreshOAuthAccessToken().catch(() => null);
    if (!accessToken) return response;
    await response.body?.cancel().catch(() => undefined);
    return fetchFn(url, withRefreshedOAuthAuthorization(init, accessToken, false));
  };
}

function withRefreshedOAuthAuthorization(
  init: RequestInit | undefined,
  accessToken: string,
  codex: boolean,
): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${accessToken}`);
  if (codex) {
    headers.delete('ChatGPT-Account-Id');
    for (const [name, value] of Object.entries(openAiCodexHeaders(accessToken))) {
      headers.set(name, value);
    }
  }
  return { ...init, headers };
}

function isReplayableOpenAiCodexRequest(
  url: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): boolean {
  if (typeof init?.body === 'string') return true;
  if (init?.body != null) return false;
  return !(url instanceof Request) || url.body === null;
}

function effectiveOpenAiCodexRequestSignal(
  url: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): AbortSignal | null | undefined {
  if (init?.signal !== undefined) return init.signal;
  return url instanceof Request ? url.signal : undefined;
}

function isTransientOpenAiCodexEdgeRejection(response: Response, detail: string): boolean {
  if (response.status !== 403) return false;
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  return contentType.includes('text/html') || /^\s*(?:<!doctype html|<html\b)/i.test(detail);
}

function openAiCodexRetryAfterMs(response: Response, fallbackMs: number): number {
  const rawRetryAfter = response.headers.get('retry-after');
  if (rawRetryAfter === null || rawRetryAfter.trim() === '') return fallbackMs;
  const retryAfterSeconds = Number(rawRetryAfter);
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 0) return fallbackMs;
  return Math.min(retryAfterSeconds * 1_000, 30_000);
}

function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function codexInstructionsFromBody(body: Record<string, unknown>): string {
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    return body.instructions;
  }
  if (typeof body.system === 'string' && body.system.trim()) {
    return body.system;
  }
  const input = body.input;
  if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (record.role !== 'system') continue;
      const content = record.content;
      if (typeof content === 'string' && content.trim()) return content;
      if (!Array.isArray(content)) continue;
      const text = content
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          const value = (part as Record<string, unknown>).text;
          return typeof value === 'string' ? value : '';
        })
        .filter(Boolean)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return 'You are Maka, a helpful AI assistant.';
}

function formatOpenAiCodexHttpError(statusCode: number, detail: string): string {
  const compact = redactSecrets(detail).replace(/\s+/g, ' ').trim().slice(0, 240);
  return compact
    ? `Codex OAuth request failed: HTTP ${statusCode} ${compact}`
    : `Codex OAuth request failed: HTTP ${statusCode}`;
}

function openAiCodexHttpError(response: Response, detail: string): Error {
  const providerCode = openAiCodexProviderCode(detail);
  const rawRequestId = response.headers.get('x-request-id')?.trim();
  const requestId = rawRequestId ? redactSecrets(rawRequestId).slice(0, 256) : undefined;
  return Object.assign(new Error(formatOpenAiCodexHttpError(response.status, detail)), {
    name: 'OpenAiCodexHttpError',
    statusCode: response.status,
    ...(providerCode ? { data: { error: { code: providerCode } } } : {}),
    ...(requestId ? { responseHeaders: { 'x-request-id': requestId.slice(0, 256) } } : {}),
  });
}

function openAiCodexProviderCode(detail: string): string | undefined {
  try {
    const payload = JSON.parse(detail) as unknown;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
    const root = payload as Record<string, unknown>;
    const error =
      root.error && typeof root.error === 'object' && !Array.isArray(root.error)
        ? (root.error as Record<string, unknown>)
        : root;
    const value = error.code ?? error.type;
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    const normalized = redactSecrets(String(value).trim()).slice(0, 256);
    return normalized || undefined;
  } catch {
    return undefined;
  }
}
