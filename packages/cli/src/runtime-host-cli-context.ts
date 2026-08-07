import type { ConnectionCatalogEntry, ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import {
  connectOrSpawnRuntimeHost,
  readRuntimeHostConnectionCatalog,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import { RUNTIME_HOST_PROTOCOL_VERSION, type ClientSurface } from '@maka/runtime-host/protocol';

export interface RuntimeHostCliConnectionContext {
  readonly connection: RuntimeHostConnection;
  readonly catalog: ConnectionCatalogSnapshot;
  close(): Promise<void>;
}

export interface RuntimeHostCliTarget {
  readonly connection: ConnectionCatalogEntry;
  readonly model: string;
}

interface RuntimeHostCliContextDeps {
  readonly connectOrSpawn: typeof connectOrSpawnRuntimeHost;
  readonly readConnectionCatalog: typeof readRuntimeHostConnectionCatalog;
  readonly executionCandidateEntrypoint: URL;
}

export async function connectRuntimeHostCli(
  input: {
    readonly rootPath: string;
    readonly surface: ClientSurface;
  },
  overrides: Partial<RuntimeHostCliContextDeps> = {},
): Promise<RuntimeHostCliConnectionContext> {
  const deps: RuntimeHostCliContextDeps = {
    connectOrSpawn: connectOrSpawnRuntimeHost,
    readConnectionCatalog: readRuntimeHostConnectionCatalog,
    executionCandidateEntrypoint: new URL(
      import.meta.resolve('@maka/runtime-host/execution-candidate-main'),
    ),
    ...overrides,
  };
  const connected = await deps.connectOrSpawn({
    rootPath: input.rootPath,
    surface: input.surface,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    candidateEntrypoint: deps.executionCandidateEntrypoint,
  });
  if (connected.kind === 'incompatible') {
    throw new Error(
      `Runtime Host protocol is incompatible (Host ${connected.handshake.protocolMin}-${connected.handshake.protocolMax}, CLI ${RUNTIME_HOST_PROTOCOL_VERSION})`,
    );
  }
  if (connected.kind === 'failed') {
    throw new Error(`Runtime Host startup failed: ${connected.reason}`);
  }
  const connection = connected.connection;
  try {
    await waitForReady(connection);
    return {
      connection,
      catalog: await deps.readConnectionCatalog(connection),
      close: () => connection.close(),
    };
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}

export function resolveRuntimeHostCliTarget(
  catalog: ConnectionCatalogSnapshot,
  input: { readonly connectionSlug?: string; readonly model?: string } = {},
): RuntimeHostCliTarget {
  const defaultTarget = catalog.defaultTarget;
  const connection = input.connectionSlug
    ? catalog.connections.find((candidate) => candidate.slug === input.connectionSlug)
    : catalog.connections.find(
        (candidate) => candidate.connectionId === defaultTarget?.connectionId,
      );
  if (!connection || !connection.enabled) {
    throw new Error(
      input.connectionSlug
        ? `Runtime Host model connection is unavailable: ${input.connectionSlug}`
        : 'Runtime Host has no default model connection',
    );
  }
  const model =
    input.model ??
    (connection.connectionId === defaultTarget?.connectionId
      ? defaultTarget.modelId
      : connection.enabledModelIds[0]);
  if (!model || !connection.enabledModelIds.includes(model)) {
    throw new Error(`Runtime Host model is unavailable for ${connection.slug}: ${model ?? ''}`);
  }
  return { connection, model };
}

async function waitForReady(connection: RuntimeHostConnection): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (true) {
    const status = await connection.status(Math.max(1, deadline - Date.now()));
    if (status.state === 'ready') return;
    if (status.state === 'draining') throw new Error('Runtime Host drained before becoming ready');
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Runtime Host did not become ready before the deadline');
    await new Promise((resolve) => setTimeout(resolve, Math.min(25, remaining)));
  }
}
