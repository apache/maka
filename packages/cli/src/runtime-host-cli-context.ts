import { randomUUID } from 'node:crypto';
import { NO_REAL_CONNECTION_CODE } from '@maka/core';
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
} from '@maka/runtime-host/protocol';

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
    readonly legacyConfigurationRoot?: string;
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
    ...(input.legacyConfigurationRoot
      ? { legacyConfigurationRoot: input.legacyConfigurationRoot }
      : {}),
  } as const;
  const connect = async (signal?: AbortSignal): Promise<RuntimeHostConnection> => {
    const connected = await deps.connectOrSpawn({ ...connectInput, ...(signal ? { signal } : {}) });
    if (connected.kind === 'incompatible') {
      if (connected.handshake.compatibilityEpoch < RUNTIME_HOST_COMPATIBILITY_EPOCH) {
        throw new RuntimeHostPermanentReconnectError(
          'An older Maka Runtime Host is still running and is incompatible with this build. Stop the previous Maka Desktop or CLI process, then try again.',
        );
      }
      throw new RuntimeHostPermanentReconnectError(
        `Runtime Host protocol is incompatible (Host ${connected.handshake.protocolMin}-${connected.handshake.protocolMax}, CLI ${RUNTIME_HOST_PROTOCOL_VERSION})`,
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
