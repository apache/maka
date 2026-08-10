import { readRuntimeHostConnectionCatalog } from './catalog-reader.js';
import type { RuntimeHostConnection } from './connection.js';

type TargetConnection = Pick<RuntimeHostConnection, 'request'>;

export interface HostedExecutionTargetInput {
  readonly connectionSlug: string;
  readonly model: string;
  readonly baseUrl: string;
}

export async function configureHostedExecutionTarget(
  connection: TargetConnection,
  input: HostedExecutionTargetInput,
): Promise<void> {
  const before = await readRuntimeHostConnectionCatalog(connection);
  const target = before.connections.find((candidate) => candidate.slug === input.connectionSlug);
  if (!target) throw new Error('Runtime Host connection is unavailable');

  const baseUrl = new URL(input.baseUrl).toString();
  const enabledModelIds = [...new Set([...target.enabledModelIds, input.model])];
  const endpointChanged = target.baseUrl !== baseUrl;
  if (endpointChanged || !target.enabled || !target.enabledModelIds.includes(input.model)) {
    const updated = await connection.request('connection.catalog.update', {
      expected: { connectionId: target.connectionId, revision: target.revision },
      changes: {
        name: target.name,
        baseUrl,
        enabled: true,
        enabledModelIds,
      },
    });
    if (updated.kind !== 'committed') {
      throw new Error(`Runtime Host connection update was not committed: ${updated.kind}`);
    }
  }

  if (endpointChanged || !target.models.some((model) => model.id === input.model)) {
    const fetched = await connection.request('connection.models.fetch', {
      connectionId: target.connectionId,
    });
    if (fetched.kind !== 'committed') {
      throw new Error(`Runtime Host model discovery did not commit: ${fetched.kind}`);
    }
  }

  const after = await readRuntimeHostConnectionCatalog(connection);
  const configured = after.connections.find(
    (candidate) => candidate.connectionId === target.connectionId,
  );
  if (
    !configured?.enabled ||
    configured.baseUrl !== baseUrl ||
    !configured.enabledModelIds.includes(input.model) ||
    !configured.models.some((model) => model.id === input.model)
  ) {
    throw new Error('Runtime Host did not admit the requested model target');
  }
}
