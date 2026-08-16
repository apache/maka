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
