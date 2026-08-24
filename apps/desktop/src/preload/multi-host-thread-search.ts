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

import type { SearchError, SearchResult } from '@maka/core/search';

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
