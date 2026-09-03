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
 * One-time `stream_options` retreat for strict OpenAI-compatible servers.
 *
 * Maka asks every Chat Completions server for stream usage because usage is
 * the only signal its context handling reads (#4559). A relay or gateway that
 * rejects unknown request fields (older vLLM builds, some proxies) answers 400
 * to every streaming request instead, and a user cannot switch the field off
 * without a code change. So the first such rejection is answered once, in the
 * open: resend the same request without the field and remember that this
 * endpoint cannot report usage, rather than failing every request or silently
 * never asking. The connection then runs without a baseline — the composer
 * indicator shows no usage — which is the honest state for a server that
 * cannot report it.
 *
 * The retreat is deliberately narrow. Only a 400 whose body names the field
 * counts; any other rejection is the provider's answer and is returned
 * untouched.
 */

type FetchLike = typeof globalThis.fetch;

/** Endpoints observed to reject the field. Process-lifetime, per base URL. */
const endpointsWithoutStreamUsage = new Set<string>();

const FIELD_PATTERN = /stream_options|include_usage/i;

function withoutStreamOptions(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  if (!('stream_options' in record)) return undefined;
  const { stream_options: _dropped, ...rest } = record;
  return JSON.stringify(rest);
}

function requestBodyText(init: RequestInit | undefined): string | undefined {
  const body = init?.body;
  return typeof body === 'string' ? body : undefined;
}

/** Test seam: forget every remembered endpoint. */
export function resetStreamUsageFallbackMemory(): void {
  endpointsWithoutStreamUsage.clear();
}

export function createStreamUsageFallbackFetch(baseFetch: FetchLike, baseUrl: string): FetchLike {
  return async (input, init) => {
    const remembered = endpointsWithoutStreamUsage.has(baseUrl);
    const body = requestBodyText(init as RequestInit | undefined);
    if (remembered && body !== undefined) {
      const stripped = withoutStreamOptions(body);
      if (stripped !== undefined) {
        return baseFetch(input, { ...(init as RequestInit), body: stripped });
      }
    }
    const response = await baseFetch(input, init);
    if (remembered || response.status !== 400 || body === undefined) return response;
    const stripped = withoutStreamOptions(body);
    if (stripped === undefined) return response;
    let text = '';
    try {
      text = await response.clone().text();
    } catch {
      return response;
    }
    if (!FIELD_PATTERN.test(text)) return response;
    endpointsWithoutStreamUsage.add(baseUrl);
    return baseFetch(input, { ...(init as RequestInit), body: stripped });
  };
}
