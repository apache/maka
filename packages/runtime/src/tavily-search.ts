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
  WEB_SEARCH_MAX_LIMIT,
  normalizeWebSearchLimit,
  normalizeWebSearchQuery,
  type WebSearchResponse,
  type WebSearchResultRow,
} from '@maka/core/web-search';

const TAVILY_ENDPOINT = 'https://api.tavily.com/search';
const TAVILY_TIMEOUT_MS = 10_000;
const TAVILY_RESPONSE_MAX_BYTES = 1_048_576;
const TAVILY_RESULT_URL_MAX_CHARS = 2_048;
const TAVILY_RESULT_TITLE_MAX_CHARS = 240;
const TAVILY_RESULT_SNIPPET_MAX_CHARS = 400;

interface TavilyRawResult {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly content?: unknown;
}

interface TavilyRawResponse {
  readonly results?: unknown;
}

interface QueryTavilyInput {
  readonly apiKey: string;
  readonly query: string;
  readonly limit: number;
  readonly fetch?: typeof globalThis.fetch;
  readonly abortSignal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly responseMaxBytes?: number;
}

/** Executes one bounded Tavily request without logging query or credential material. */
export async function queryTavily(input: QueryTavilyInput): Promise<WebSearchResponse> {
  const apiKey = input.apiKey.trim();
  if (apiKey.length === 0) {
    return {
      ok: false,
      reason: 'not_configured',
      message: 'Configure a Tavily API key before using web search.',
    };
  }
  const query = normalizeWebSearchQuery(input.query);
  if (!query) {
    return { ok: false, reason: 'invalid_query', message: 'Web search requires a valid query.' };
  }

  const externalSignal = input.abortSignal;
  if (externalSignal?.aborted) throw abortReason(externalSignal);
  const timeoutMs = input.timeoutMs ?? TAVILY_TIMEOUT_MS;
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort(abortReason(externalSignal!));
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Tavily request timed out', 'TimeoutError'));
  }, timeoutMs);

  try {
    const limit = Math.min(WEB_SEARCH_MAX_LIMIT, normalizeWebSearchLimit(input.limit));
    const response = await (input.fetch ?? globalThis.fetch)(TAVILY_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: limit,
        search_depth: 'basic',
      }),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        reason: 'invalid_credentials',
        message: 'Tavily rejected the configured API key.',
      };
    }
    if (response.status === 429) {
      return {
        ok: false,
        reason: 'rate_limited',
        message: 'Tavily rate-limited the search request.',
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        reason: 'network_error',
        message: `Tavily returned HTTP ${response.status}.`,
      };
    }
    const body = await readBoundedJson(
      response,
      input.responseMaxBytes ?? TAVILY_RESPONSE_MAX_BYTES,
    );
    const results = mapTavilyRows(body, limit);
    if (!results) throw new Error('Tavily response shape is invalid');
    return { ok: true, results };
  } catch (error) {
    if (externalSignal?.aborted) throw abortReason(externalSignal);
    if (timedOut) {
      return {
        ok: false,
        reason: 'timeout',
        message: `Tavily did not respond within ${Math.round(timeoutMs / 1_000)} seconds.`,
      };
    }
    return {
      ok: false,
      reason: 'network_error',
      message: 'The Tavily request failed.',
    };
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

function mapTavilyRows(raw: unknown, limit: number): WebSearchResultRow[] | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidates = (raw as TavilyRawResponse).results;
  if (!Array.isArray(candidates)) return null;

  const rows: WebSearchResultRow[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const rawRow = candidate as TavilyRawResult;
    const location = normalizeResultLocation(rawRow.url);
    if (!location) continue;
    rows.push({
      provider: 'tavily',
      title: safeString(rawRow.title, location.url).slice(0, TAVILY_RESULT_TITLE_MAX_CHARS),
      url: location.url,
      snippet: safeString(rawRow.content).slice(0, TAVILY_RESULT_SNIPPET_MAX_CHARS),
      source: location.source,
    });
    if (rows.length >= limit) break;
  }
  return rows;
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Tavily response byte limit is invalid');
  }
  if (!response.body) return undefined;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel('Tavily response exceeded its byte limit');
        throw new Error('Tavily response exceeded its byte limit');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  return JSON.parse(
    Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      total,
    ).toString('utf8'),
  );
}

function safeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeResultLocation(
  value: unknown,
): { readonly url: string; readonly source: string } | null {
  if (typeof value !== 'string' || value.length > TAVILY_RESULT_URL_MAX_CHARS) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || !url.hostname) return null;
    const normalized = url.toString();
    if (normalized.length > TAVILY_RESULT_URL_MAX_CHARS) return null;
    return { url: normalized, source: url.hostname };
  } catch {
    return null;
  }
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Tavily request was aborted', 'AbortError');
}
