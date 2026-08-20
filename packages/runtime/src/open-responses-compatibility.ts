import type { ProviderResponsesCompatibilityModule } from './provider-runtime-policy.js';

export function createOpenResponsesCompatibilityFetch(
  fetchImpl: typeof globalThis.fetch,
  modules: readonly ProviderResponsesCompatibilityModule[] | undefined,
): typeof globalThis.fetch {
  if (!modules || modules.length === 0) return fetchImpl;
  assertUniqueModules(modules);
  return async (input, init) => {
    const request = new Request(input, init);
    const body = await parseJsonBody(request);
    const transformed = applyModules(body, modules);
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    return await fetchImpl(request.url, requestInit(request, headers, JSON.stringify(transformed)));
  };
}

function applyModules(
  source: Record<string, unknown>,
  modules: readonly ProviderResponsesCompatibilityModule[],
): Record<string, unknown> {
  let body = source;
  for (const module of modules) {
    switch (module) {
      case 'force-store-false':
        body = { ...body, store: false };
        break;
      case 'reject-forced-tool-choice': {
        const choice = body.tool_choice;
        if (choice === 'required' || (choice !== null && typeof choice === 'object')) {
          throw new Error(
            'Open Responses compatibility profile does not support forced tool_choice',
          );
        }
        break;
      }
    }
  }
  return body;
}

async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.method === 'GET' || request.method === 'HEAD' || request.body === null) {
    throw new Error('Open Responses compatibility requires a JSON object request body');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await request.clone().text());
  } catch {
    throw new Error('Open Responses compatibility requires a JSON object request body');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Open Responses compatibility requires a JSON object request body');
  }
  return parsed as Record<string, unknown>;
}

function requestInit(request: Request, headers: Headers, body: string): RequestInit {
  return {
    method: request.method,
    headers: [...headers.entries()],
    body,
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

function assertUniqueModules(modules: readonly ProviderResponsesCompatibilityModule[]): void {
  const seen = new Set<ProviderResponsesCompatibilityModule>();
  for (const module of modules) {
    if (seen.has(module)) {
      throw new Error(`Duplicate Open Responses compatibility module: ${module}`);
    }
    seen.add(module);
  }
}
