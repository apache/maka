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

  const results = responses.flatMap((response) =>
    Array.isArray(response) ? response : [],
  );
  return results.length > 0
    ? results.slice(0, limit)
    : responses.find((response) => !Array.isArray(response)) ?? [];
}
