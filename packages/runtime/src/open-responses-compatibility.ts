import type { ProviderResponsesCompatibilityModule } from '@maka/core/llm-connections';

export function createOpenResponsesCompatibilityFetch(
  fetchImpl: typeof globalThis.fetch,
  modules: readonly ProviderResponsesCompatibilityModule[] | undefined,
): typeof globalThis.fetch {
  if (!modules || modules.length === 0) return fetchImpl;
  assertUniqueModules(modules);
  return async (input, init) => {
    const body = parseJsonBody(init?.body);
    if (!body) return await fetchImpl(input, init);
    const transformed = applyModules(body, modules);
    return await fetchImpl(input, { ...init, body: JSON.stringify(transformed) });
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

function parseJsonBody(value: BodyInit | null | undefined): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
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
