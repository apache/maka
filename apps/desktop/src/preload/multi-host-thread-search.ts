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

import type { SearchError, SearchRequest, SearchResult } from '@maka/core/search';

/** Owns a request across Host discovery, fan-out, and cancellation. */
export function createThreadSearchClient<Scope>(input: {
  scopes(): Promise<readonly Scope[]>;
  search(scope: Scope, request: SearchRequest, requestId: string): Promise<SearchResult[] | SearchError>;
  cancel(scope: Scope, requestId: string): Promise<unknown>;
}) {
  const pending = new Map<string, { cancel(): Promise<void> }>();
  return {
    async thread(request: SearchRequest, requestId: string = crypto.randomUUID()): Promise<SearchResult[] | SearchError> {
      if (pending.has(requestId)) throw new Error('Search request is already active');
      let scopes: readonly Scope[] = [];
      let cancelled = false;
      let finishCancel!: (error: SearchError) => void;
      const cancellation = new Promise<SearchError>((resolve) => { finishCancel = resolve; });
      pending.set(requestId, {
        async cancel() {
          cancelled = true;
          finishCancel({ ok: false, reason: 'aborted', message: 'History search was aborted.' });
          await Promise.all(scopes.map((scope) => input.cancel(scope, requestId)));
        },
      });
      try {
        return await Promise.race([
          (async () => {
            scopes = await input.scopes();
            if (cancelled) return cancellation;
            return collectThreadSearchResponses(
              scopes.map((scope) => input.search(scope, request, requestId)),
              request.limit,
            );
          })(),
          cancellation,
        ]);
      } finally {
        pending.delete(requestId);
      }
    },
    async cancelThread(requestId: string): Promise<void> {
      await pending.get(requestId)?.cancel();
    },
  };
}

export async function collectThreadSearchResponses(
  requests: readonly Promise<SearchResult[] | SearchError>[],
  limit: number,
): Promise<SearchResult[] | SearchError> {
  if (requests.length === 0) {
    return {
      ok: false,
      reason: 'provider_error',
      message: 'No Runtime Host is available for search',
    };
  }

  const settled = await Promise.allSettled(requests);
  const responses = settled.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  if (responses.length === 0) {
    throw (settled[0] as PromiseRejectedResult).reason;
  }

  const matches = responses.filter((response): response is SearchResult[] =>
    Array.isArray(response),
  );
  const results: SearchResult[] = [];
  for (let index = 0; results.length < limit; index += 1) {
    let appended = false;
    for (const hostMatches of matches) {
      const match = hostMatches[index];
      if (!match) continue;
      results.push(match);
      appended = true;
      if (results.length === limit) break;
    }
    if (!appended) break;
  }
  return results.length > 0
    ? results
    : responses.find((response) => !Array.isArray(response)) ?? [];
}
