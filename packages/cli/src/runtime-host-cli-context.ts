import { randomUUID } from 'node:crypto';
import { NO_REAL_CONNECTION_CODE } from '@maka/core/connection-error-copy';
import type { ConnectionCatalogEntry, ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import {
  connectOrSpawnRuntimeHost,
  createRuntimeHostReconnectingConnection,
  readRuntimeHostConnectionCatalog,
  RuntimeHostPermanentReconnectError,
  waitForRuntimeHostReady,
  type RuntimeHostConnection,
} from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type ClientSurface,
  type HostIncompatible,
} from '@maka/runtime-host/protocol';

export class RuntimeHostCliConflictError extends RuntimeHostPermanentReconnectError {
  readonly code = 'RUNTIME_HOST_RESTART_REQUIRED';

  constructor(readonly handshake: HostIncompatible) {
    super(formatRuntimeHostCliConflict(handshake));
    this.name = 'RuntimeHostCliConflictError';
  }
}

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
  const clientInstanceId = randomUUID();
  const connectInput = {
    rootPath: input.rootPath,
    surface: input.surface,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    candidateEntrypoint: deps.executionCandidateEntrypoint,
  } as const;
  const connect = async (signal?: AbortSignal): Promise<RuntimeHostConnection> => {
    const connected = await deps.connectOrSpawn({ ...connectInput, ...(signal ? { signal } : {}) });
    if (connected.kind === 'incompatible') {
      throw new RuntimeHostCliConflictError(connected.handshake);
    }
    if (connected.kind === 'upgrade_required') {
      throw new RuntimeHostPermanentReconnectError(
        'RUNTIME_HOST_RESTART_REQUIRED: An older Runtime Host build is still running. Restart it, or wait for its background work to finish.',
      );
    }
    if (connected.kind === 'failed') {
      throw new Error(`Runtime Host startup failed: ${connected.reason}`);
    }
    try {
      await waitForRuntimeHostReady(connected.connection, 45_000, signal);
      return connected.connection;
    } catch (error) {
      await connected.connection.close().catch(() => undefined);
      throw error;
    }
  };
  const initialConnection = await connect();
  const connection = await createRuntimeHostReconnectingConnection({
    initialConnection,
    connect,
  });
  try {
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

function formatRuntimeHostCliConflict(handshake: HostIncompatible): string {
  const lines = [
    'RUNTIME_HOST_RESTART_REQUIRED: An older Runtime Host is still running and cannot accept this client.',
  ];
  if (handshake.compatibilityEpoch < RUNTIME_HOST_COMPATIBILITY_EPOCH) {
    lines.push(
      'Stop the previous Maka Desktop or CLI process, or wait for it to exit, then try again.',
    );
  } else {
    lines.push(
      `Host protocol ${handshake.protocolMin}-${handshake.protocolMax}; CLI protocol ${RUNTIME_HOST_PROTOCOL_VERSION}.`,
    );
  }
  return lines.join('\n');
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
        : `${NO_REAL_CONNECTION_CODE}:missing_default_connection: Runtime Host has no default model connection`,
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
