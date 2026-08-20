import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { NO_REAL_CONNECTION_CODE } from '@maka/core/connection-error-copy';
import type { ConnectionCatalogEntry, ConnectionCatalogSnapshot } from '@maka/core/runtime-policy';
import {
  connectOrSpawnRuntimeHost,
  connectRemoteRuntimeHostProfile,
  createClientRuntimeHostProfileCatalog,
  createRuntimeHostReconnectingConnection,
  loadOrCreateRuntimeHostClientInstanceId,
  LOCAL_RUNTIME_HOST_PROFILE,
  readRuntimeHostConnectionCatalog,
  RuntimeHostPermanentReconnectError,
  runtimeHostStartupError,
  type RuntimeHostConnection,
  type RuntimeHostProfile,
  type ResolvedRuntimeHostProfile,
  type RuntimeHostProfileCatalog,
} from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostRegistration,
  type ClientSurface,
  type HostIncompatible,
} from '@maka/runtime-host/protocol';
import { resolveMakaClientDataRoot } from '@maka/storage';
import {
  loadRuntimeHostCliInstallationContext,
  type RuntimeHostCliInstallationContext,
} from './runtime-host-installation-context.js';

export class RuntimeHostCliConflictError extends RuntimeHostPermanentReconnectError {
  readonly code = 'RUNTIME_HOST_RESTART_REQUIRED';

  constructor(
    readonly conflict:
      | { readonly kind: 'incompatible'; readonly handshake: HostIncompatible }
      | {
          readonly kind: 'upgrade_required';
          readonly restartable: boolean;
          readonly handshake?: HostIncompatible;
        },
    readonly registration: HostRegistration,
    readonly canReplaceLocalHost: boolean,
  ) {
    super(formatRuntimeHostCliConflict(conflict, registration, canReplaceLocalHost));
    this.name = 'RuntimeHostCliConflictError';
  }
}

export type RuntimeHostCliLocalGenerationRequest =
  | { readonly kind: 'require_installed' }
  | { readonly kind: 'takeover'; readonly expectedHostEpoch: string };

export interface RuntimeHostCliConnectionContext {
  readonly connection: RuntimeHostConnection;
  readonly catalog: ConnectionCatalogSnapshot;
  readonly profile: RuntimeHostProfile;
  close(): Promise<void>;
}

export interface RuntimeHostCliTarget {
  readonly connection: ConnectionCatalogEntry;
  readonly model: string;
}

interface RuntimeHostCliContextDeps {
  readonly connectOrSpawn: typeof connectOrSpawnRuntimeHost;
  readonly connectRemoteProfile: typeof connectRemoteRuntimeHostProfile;
  readonly readConnectionCatalog: typeof readRuntimeHostConnectionCatalog;
  readonly loadClientInstanceId: typeof loadOrCreateRuntimeHostClientInstanceId;
  readonly executionCandidateEntrypoint: URL;
  readonly loadInstallationContext: () => Promise<RuntimeHostCliInstallationContext>;
  readonly profileCatalog?: RuntimeHostProfileCatalog;
}

export async function connectRuntimeHostCli(
  input: {
    readonly rootPath: string;
    readonly surface: ClientSurface;
    readonly profileId?: string;
    readonly clientDataRoot?: string;
    readonly localGenerationRequest?: RuntimeHostCliLocalGenerationRequest;
  },
  overrides: Partial<RuntimeHostCliContextDeps> = {},
): Promise<RuntimeHostCliConnectionContext> {
  const deps: RuntimeHostCliContextDeps = {
    connectOrSpawn: connectOrSpawnRuntimeHost,
    connectRemoteProfile: connectRemoteRuntimeHostProfile,
    readConnectionCatalog: readRuntimeHostConnectionCatalog,
    loadClientInstanceId: loadOrCreateRuntimeHostClientInstanceId,
    executionCandidateEntrypoint: new URL(
      import.meta.resolve('@maka/runtime-host/execution-candidate-main'),
    ),
    loadInstallationContext: loadRuntimeHostCliInstallationContext,
    ...overrides,
  };
  const resolvedProfile = await resolveHostProfile(input, deps);
  const profile = resolvedProfile.profile;
  if (profile.kind === 'remote' && input.localGenerationRequest) {
    throw new TypeError('A remote Runtime Host does not accept local generation requests');
  }
  const installation = profile.kind === 'local' ? await deps.loadInstallationContext() : undefined;
  const clientInstanceId =
    profile.kind === 'local'
      ? randomUUID()
      : await deps.loadClientInstanceId(
          join(input.clientDataRoot ?? resolveMakaClientDataRoot(), 'runtime-host-client.json'),
        );
  const connectInput = {
    rootPath: input.rootPath,
    surface: input.surface,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    candidateEntrypoint: deps.executionCandidateEntrypoint,
    ...(installation ? { candidateGeneration: installation.artifactGeneration } : {}),
    ...(installation && input.localGenerationRequest
      ? { generation: installation.artifactGeneration }
      : {}),
    ...(input.localGenerationRequest?.kind === 'takeover'
      ? { takeoverHostEpoch: input.localGenerationRequest.expectedHostEpoch }
      : {}),
  } as const;
  const connect = async (
    signal?: AbortSignal,
    sshInteraction: 'batch' | 'inherit' = 'batch',
  ): Promise<RuntimeHostConnection> => {
    if (profile.kind === 'remote') {
      return deps.connectRemoteProfile({
        profile,
        credential: resolvedProfile.credential!,
        surface: input.surface,
        clientInstanceId,
        sshInteraction,
        ...(signal ? { signal } : {}),
      });
    }
    const connected = await deps.connectOrSpawn({
      ...connectInput,
      ...(signal ? { signal } : {}),
    });
    if (connected.kind === 'incompatible') {
      throw new RuntimeHostCliConflictError(
        { kind: 'incompatible', handshake: connected.handshake },
        connected.registration,
        installation?.installationScope === 'persistent',
      );
    }
    if (connected.kind === 'upgrade_required') {
      throw new RuntimeHostCliConflictError(
        {
          kind: 'upgrade_required',
          restartable: connected.restartable,
          ...(connected.handshake ? { handshake: connected.handshake } : {}),
        },
        connected.registration,
        installation?.installationScope === 'persistent',
      );
    }
    if (connected.kind === 'failed') {
      throw runtimeHostStartupError(connected.reason);
    }
    return connected.connection;
  };
  const initialConnection = await connect(
    undefined,
    input.surface === 'tui' && process.stdin.isTTY && process.stdout.isTTY ? 'inherit' : 'batch',
  );
  const connection = await createRuntimeHostReconnectingConnection({
    initialConnection,
    connect: (signal) => connect(signal, 'batch'),
  });
  try {
    return {
      connection,
      catalog: await deps.readConnectionCatalog(connection),
      profile,
      close: () => connection.close(),
    };
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}

async function resolveHostProfile(
  input: { readonly profileId?: string; readonly clientDataRoot?: string },
  deps: RuntimeHostCliContextDeps,
): Promise<ResolvedRuntimeHostProfile> {
  if (input.profileId === undefined || input.profileId === LOCAL_RUNTIME_HOST_PROFILE.id) {
    return { profile: LOCAL_RUNTIME_HOST_PROFILE };
  }
  const root = input.clientDataRoot ?? resolveMakaClientDataRoot();
  const catalog = deps.profileCatalog ?? createClientRuntimeHostProfileCatalog(root);
  return catalog.resolve(input.profileId);
}

function formatRuntimeHostCliConflict(
  conflict: RuntimeHostCliConflictError['conflict'],
  registration: HostRegistration,
  canReplaceLocalHost: boolean,
): string {
  const lines = [
    'RUNTIME_HOST_RESTART_REQUIRED: A different Runtime Host is still running and cannot accept this client.',
    `Local Runtime Host: PID ${registration.pid}; lifecycle ${registration.lifecycleMode ?? 'unknown'}; compatibility epoch ${registration.compatibilityEpoch}.`,
  ];
  if (registration.lifecycleMode === 'ephemeral') {
    lines.push('The ephemeral Host still owns this State Root.');
  } else if (registration.lifecycleMode === 'service') {
    lines.push(
      'This service Host is managed by its operator and cannot be replaced by this Client.',
    );
  } else {
    lines.push('This Host cannot be replaced by this Client.');
  }
  if (!canReplaceLocalHost && registration.lifecycleMode === 'ephemeral') {
    lines.push(
      'This transient CLI invocation is not a persistent installation owner and cannot replace the local Host.',
    );
  }
  const activity = conflict.handshake?.activity;
  if (activity) {
    lines.push(
      `Host activity: ${activity.connections} connection(s), ${activity.activeOperations} active operation(s), uptime ${activity.processUptimeSeconds}s.`,
    );
    if (activity.residencies.length > 0) {
      lines.push(
        `Durable residency: ${activity.residencies
          .map(({ label, count }) => `${label} (${count})`)
          .join(', ')}.`,
      );
    }
    lines.push(
      'Restarting preserves durable state, but it can interrupt in-flight external work.',
    );
  }
  if (conflict.kind === 'incompatible') {
    if (conflict.handshake.compatibilityEpoch < RUNTIME_HOST_COMPATIBILITY_EPOCH) {
      lines.push(
        registration.lifecycleMode === 'service'
          ? 'Use the service operator to inspect or upgrade the Host.'
          : canReplaceLocalHost
            ? 'Restart only if interruption is acceptable. To inspect retained work first, use a previous compatible Maka build.'
            : 'Use a persistent Maka installation or a previous compatible build to inspect and replace this Host.',
      );
    } else {
      lines.push(
        `Host protocol ${conflict.handshake.protocolMin}-${conflict.handshake.protocolMax}; CLI protocol ${RUNTIME_HOST_PROTOCOL_VERSION}.`,
      );
      lines.push(
        registration.lifecycleMode === 'service'
          ? 'Use the service operator to select compatible Client and Host builds.'
          : 'Use a newer compatible Maka build to inspect this Host.',
      );
    }
  }
  return lines.join('\n');
}

export type RuntimeHostCliConflictDecision = 'restart' | 'wait' | 'cancel';

export function resolveRuntimeHostCliConflictDecision(
  answer: string,
  canRestart: boolean,
): RuntimeHostCliConflictDecision {
  const normalized = answer.trim().toLowerCase();
  if (canRestart && (normalized === 'r' || normalized === 'restart')) return 'restart';
  return normalized === 'w' || normalized === 'wait' ? 'wait' : 'cancel';
}

export function canRestartRuntimeHostCliConflict(error: RuntimeHostCliConflictError): boolean {
  if (!error.canReplaceLocalHost || error.registration.lifecycleMode !== 'ephemeral') return false;
  const activity = error.conflict.handshake?.activity;
  return error.conflict.kind === 'upgrade_required'
    ? error.conflict.restartable
    : activity !== undefined && activity.connections === 0;
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
