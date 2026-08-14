export const OPENAI_CODEX_COMPACTION_V2_HEADER = 'x-maka-openai-codex-compaction-v2';

/**
 * Adds Codex's explicit V2 compaction trigger only to requests made by Maka's
 * dedicated history compactor. The private header is stripped before dispatch.
 */
export function createOpenAiCodexCompactionTransport(
  upstream: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.headers.get(OPENAI_CODEX_COMPACTION_V2_HEADER) !== '1') {
      return upstream(input, init);
    }
    if (
      request.method !== 'POST' ||
      !new URL(request.url).pathname.endsWith('/responses') ||
      !requestHasJsonBody(request)
    ) {
      throw new Error('Codex remote compaction requires a JSON POST to the Responses endpoint');
    }

    const body = await parseRequestBody(request);
    if (!Array.isArray(body.input)) {
      throw new Error('Codex remote compaction requires a Responses input array');
    }
    if (
      body.input.some(
        (item) =>
          item !== null &&
          typeof item === 'object' &&
          (item as Record<string, unknown>).type === 'compaction_trigger',
      )
    ) {
      throw new Error('Codex remote compaction request already contains a compaction trigger');
    }
    const headers = new Headers(request.headers);
    headers.delete(OPENAI_CODEX_COMPACTION_V2_HEADER);
    headers.delete('content-length');
    return upstream(request.url, {
      ...requestInit(request),
      headers: [...headers.entries()],
      body: JSON.stringify({
        ...body,
        input: [...body.input, { type: 'compaction_trigger' }],
      }),
    });
  };
}

function requestHasJsonBody(request: Request): boolean {
  if (request.body === null) return false;
  const contentType = request.headers.get('content-type');
  return (
    contentType === null || /(^|\s|;)application\/(?:[\w.+-]+\+)?json(?:\s*;|$)/i.test(contentType)
  );
}

async function parseRequestBody(request: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await request.clone().text());
  } catch {
    throw new Error('Codex remote compaction requires a JSON object request');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Codex remote compaction requires a JSON object request');
  }
  return parsed as Record<string, unknown>;
}

function requestInit(request: Request): RequestInit {
  return {
    method: request.method,
    signal: request.signal,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
    duplex: 'half',
  } as RequestInit;
}
