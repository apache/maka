import { effectiveBaseUrl } from '@maka/core/llm-connections';
import { readRuntimeHostConnectionCatalog } from './catalog-reader.js';
import type { RuntimeHostConnection } from './connection.js';
import { abortable } from './wait-for-ready.js';

type TargetConnection = Pick<RuntimeHostConnection, 'request'>;

export interface HostedExecutionTargetInput {
  readonly connectionSlug: string;
  readonly model: string;
  readonly baseUrl: string;
}

export async function configureHostedExecutionTarget(
  connection: TargetConnection,
  input: HostedExecutionTargetInput,
  signal?: AbortSignal,
): Promise<boolean> {
  const before = await abortable(() => readRuntimeHostConnectionCatalog(connection), signal);
  const target = before.connections.find((candidate) => candidate.slug === input.connectionSlug);
  if (!target) throw new Error('Runtime Host connection is unavailable');

  const baseUrl = new URL(input.baseUrl).toString();
  const enabledModelIds = [...new Set([...target.enabledModelIds, input.model])];
  const endpointChanged = canonicalBaseUrl(effectiveBaseUrl(target)) !== baseUrl;
  let changed = false;
  if (endpointChanged || !target.enabled || !target.enabledModelIds.includes(input.model)) {
    const updated = await abortable(
      () =>
        connection.request('connection.catalog.update', {
          expected: { connectionId: target.connectionId, revision: target.revision },
          changes: {
            name: target.name,
            baseUrl,
            enabled: true,
            enabledModelIds,
          },
        }),
      signal,
    );
    if (updated.kind !== 'committed') {
      throw new Error(`Runtime Host connection update was not committed: ${updated.kind}`);
    }
    changed = true;
  }

  if (endpointChanged || !target.models.some((model) => model.id === input.model)) {
    const fetched = await abortable(
      () =>
        connection.request('connection.models.fetch', {
          connectionId: target.connectionId,
        }),
      signal,
    );
    if (fetched.kind !== 'committed') {
      throw new Error(`Runtime Host model discovery did not commit: ${fetched.kind}`);
    }
    changed = true;
  }

  const after = await abortable(() => readRuntimeHostConnectionCatalog(connection), signal);
  const configured = after.connections.find(
    (candidate) => candidate.connectionId === target.connectionId,
  );
  if (
    !configured?.enabled ||
    canonicalBaseUrl(effectiveBaseUrl(configured)) !== baseUrl ||
    !configured.enabledModelIds.includes(input.model) ||
    !configured.models.some((model) => model.id === input.model)
  ) {
    throw new Error('Runtime Host did not admit the requested model target');
  }
  return changed;
}

function canonicalBaseUrl(value: string): string | undefined {
  try {
    return new URL(value).toString();
  } catch {
    return undefined;
  }
}
