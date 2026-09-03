/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { NO_REAL_CONNECTION_CODE } from '@maka/core/connection-error-copy';
import type {
  RuntimeHostConnectionCatalogEntry as ConnectionCatalogEntry,
  RuntimeHostConnectionCatalogSnapshot as ConnectionCatalogSnapshot,
} from '@maka/runtime-host/client';
import type { ChatDefaultPermissionMode } from '@maka/core/settings';
import {
  connectOrSpawnRuntimeHost,
  connectRuntimeHostProfile,
  createClientRuntimeHostProfileCatalog,
  createRuntimeHostPeerClientFromEnvironment,
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
  type RuntimeHostPeerClient,
} from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  type HostRegistration,
  type HostIncompatible,
} from '@maka/runtime-host/protocol';
import { readLocalHostDeploymentRecord } from '@maka/runtime-host/operator';
import { resolveMakaClientDataRoot } from '@maka/storage/workspace-root';

/**
 * The mode a new Session starts in belongs to the Host: `session.create`
 * falls back to `chatDefaults.permissionMode` in the Runtime Policy whenever a
 * client omits the field, so that policy value is the single authority.
 *
 * The CLI reads it rather than assuming Auto, because its pickers and its
 * status indicator name the mode a new Session will *actually* get. Assuming
 * Auto against a Host configured for full access would understate the
 * boundary, which is the one direction that must never happen.
 *
 * A failed query throws rather than resolving to `ask`. Understating the
 * boundary is not the safe direction it looks like: creation omits the field
 * either way, so a Host configured for Bypass would run the first prompt with
 * full access while the CLI displayed Auto. If the Host's own policy cannot be
 * read, the CLI has nothing true to show and should not start.
 */
export async function readHostChatDefaultPermissionMode(
  connection: Pick<RuntimeHostConnection, 'request'>,
): Promise<ChatDefaultPermissionMode> {
  return (await connection.request('runtime.policy.query', {})).policy.chatDefaults.permissionMode;
}

export class RuntimeHostCliConflictError extends RuntimeHostPermanentReconnectError {
  readonly code = 'RUNTIME_HOST_RESTART_REQUIRED';

  constructor(
    readonly handshake: HostIncompatible,
    readonly registration: HostRegistration,
  ) {
    super(formatRuntimeHostCliConflict(handshake, registration));
    this.name = 'RuntimeHostCliConflictError';
  }
}

export interface RuntimeHostCliConnectionOnlyContext {
  readonly connection: RuntimeHostConnection;
  readonly profile: RuntimeHostProfile;
  close(): Promise<void>;
}

export interface RuntimeHostCliConnectionOnlyContextWithIdentity
  extends RuntimeHostCliConnectionOnlyContext {
  readonly clientInstanceId: string;
  readonly profileIncarnationId?: string;
}

export interface RuntimeHostCliConnectionContext extends RuntimeHostCliConnectionOnlyContext {
  readonly catalog: ConnectionCatalogSnapshot;
}

export interface RuntimeHostCliConnectionContextWithIdentity
  extends RuntimeHostCliConnectionContext,
    RuntimeHostCliConnectionOnlyContextWithIdentity {}

export interface RuntimeHostCliConnectionInput {
  readonly rootPath: string;
  readonly profileId?: string;
  readonly clientDataRoot?: string;
  readonly interactiveSsh?: boolean;
  readonly signal?: AbortSignal;
}

export interface RuntimeHostCliTarget {
  readonly connection: ConnectionCatalogEntry;
  readonly model: string;
}

interface RuntimeHostCliContextDeps {
  readonly connectOrSpawn: typeof connectOrSpawnRuntimeHost;
  readonly connectProfile: typeof connectRuntimeHostProfile;
  readonly readConnectionCatalog: typeof readRuntimeHostConnectionCatalog;
  readonly loadClientInstanceId: typeof loadOrCreateRuntimeHostClientInstanceId;
  readonly executionCandidateEntrypoint: URL;
  readonly readDeploymentRecord: typeof readLocalHostDeploymentRecord;
  readonly createPeerClient: typeof createRuntimeHostPeerClientFromEnvironment;
  readonly profileCatalog?: RuntimeHostProfileCatalog;
}

export async function connectRuntimeHostCli(
  input: RuntimeHostCliConnectionInput,
  overrides: Partial<RuntimeHostCliContextDeps> = {},
): Promise<RuntimeHostCliConnectionContextWithIdentity> {
  const context = await connectRuntimeHostCliConnection(input, overrides);
  try {
    const catalog = await runAbortably(
      () =>
        (overrides.readConnectionCatalog ?? readRuntimeHostConnectionCatalog)(context.connection),
      input.signal,
    );
    return { ...context, catalog };
  } catch (error) {
    await context.close().catch(() => undefined);
    throw error;
  }
}

export async function connectRuntimeHostCliConnection(
  input: RuntimeHostCliConnectionInput,
  overrides: Partial<RuntimeHostCliContextDeps> = {},
): Promise<RuntimeHostCliConnectionOnlyContextWithIdentity> {
  const deps: RuntimeHostCliContextDeps = {
    connectOrSpawn: connectOrSpawnRuntimeHost,
    connectProfile: connectRuntimeHostProfile,
    readConnectionCatalog: readRuntimeHostConnectionCatalog,
    loadClientInstanceId: loadOrCreateRuntimeHostClientInstanceId,
    executionCandidateEntrypoint: new URL(
      import.meta.resolve('@maka/runtime-host/execution-candidate-main'),
    ),
    readDeploymentRecord: readLocalHostDeploymentRecord,
    createPeerClient: createRuntimeHostPeerClientFromEnvironment,
    ...overrides,
  };
  const resolvedProfile = await resolveHostProfile(input, deps);
  const profile = resolvedProfile.profile;
  const clientInstanceId =
    profile.kind === 'local'
      ? randomUUID()
      : await deps.loadClientInstanceId(
          join(input.clientDataRoot ?? resolveMakaClientDataRoot(), 'runtime-host-client.json'),
        );
  const peerClient: RuntimeHostPeerClient | undefined =
    profile.kind === 'remote' && profile.transport.kind === 'libp2p-direct'
      ? deps.createPeerClient()
      : undefined;
  const connectInput = {
    rootPath: input.rootPath,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    candidateEntrypoint: deps.executionCandidateEntrypoint,
  } as const;
  const connect = async (
    signal?: AbortSignal,
    sshInteraction: 'batch' | 'inherit' = 'batch',
  ): Promise<RuntimeHostConnection> => {
    if (profile.kind !== 'local') {
      return deps.connectProfile({
        profile,
        ...(resolvedProfile.credential ? { credential: resolvedProfile.credential } : {}),
        clientInstanceId,
        sshInteraction,
        ...(peerClient ? { peerClient } : {}),
        ...(signal ? { signal } : {}),
      });
    }
    const connected = await deps.connectOrSpawn({
      ...connectInput,
      ...(signal ? { signal } : {}),
    });
    if (connected.kind === 'incompatible') {
      throw new RuntimeHostCliConflictError(connected.handshake, connected.registration);
    }
    if (connected.kind === 'upgrade_required') {
      throw new RuntimeHostPermanentReconnectError(
        'RUNTIME_HOST_RESTART_REQUIRED: An older Runtime Host build is still running. Restart it, or wait for its background work to finish.',
      );
    }
    if (connected.kind === 'failed') {
      throw runtimeHostStartupError(connected.reason, connected.diagnostic);
    }
    if (connected.registration.generation?.startsWith('npm-global-handoff:')) {
      const record = await deps.readDeploymentRecord(connected.registration.rootId);
      if (record?.state.kind !== 'owned' || record.state.owner.kind !== 'cli') {
        await connected.connection.close().catch(() => undefined);
        throw new RuntimeHostPermanentReconnectError(
          'RUNTIME_HOST_RECOVERY_REQUIRED: The staged local Runtime Host is Ready, but its installation ownership was not durably committed.',
        );
      }
    }
    return connected.connection;
  };
  let initialConnection: RuntimeHostConnection | undefined;
  let connection: Awaited<ReturnType<typeof createRuntimeHostReconnectingConnection>> | undefined;
  try {
    initialConnection = await acquireAbortably(
      () =>
        connect(
          input.signal,
          input.interactiveSsh && process.stdin.isTTY && process.stdout.isTTY ? 'inherit' : 'batch',
        ),
      input.signal,
    );
    connection = await createRuntimeHostReconnectingConnection({
      initialConnection,
      connect: (signal) => connect(signal, 'batch'),
    });
    initialConnection = undefined;
    const liveConnection = connection;
    return {
      connection: liveConnection,
      profile,
      clientInstanceId,
      ...(resolvedProfile.profileIncarnationId
        ? { profileIncarnationId: resolvedProfile.profileIncarnationId }
        : {}),
      close: async () => {
        try {
          await liveConnection.close();
        } finally {
          await peerClient?.close();
        }
      },
    };
  } catch (error) {
    await (connection ?? initialConnection)?.close().catch(() => undefined);
    await peerClient?.close().catch(() => undefined);
    throw error;
  }
}

function acquireAbortably<T extends { close(): Promise<void> }>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return false;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
      return true;
    };
    const onAbort = () => settle(() => reject(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    let running: Promise<T>;
    try {
      running = operation();
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    void running.then(
      (value) => {
        if (!settle(() => resolve(value))) void value.close().catch(() => undefined);
      },
      (error: unknown) => settle(() => reject(error)),
    );
  });
}

function runAbortably<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => settle(() => reject(signal.reason));
    signal.addEventListener('abort', onAbort, { once: true });
    let running: Promise<T>;
    try {
      running = operation();
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    void running.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => settle(() => reject(error)),
    );
  });
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
  handshake: HostIncompatible,
  registration: HostRegistration,
): string {
  const lines = [
    'RUNTIME_HOST_RESTART_REQUIRED: An older Runtime Host is still running and cannot accept this client.',
    `Local Runtime Host: PID ${registration.pid}; lifecycle ${registration.lifecycleMode ?? 'unknown'}; compatibility epoch ${registration.compatibilityEpoch}.`,
  ];
  if (registration.lifecycleMode === 'ephemeral') {
    lines.push('The ephemeral Host is not currently idle and cannot be replaced by this Client.');
  } else if (registration.lifecycleMode === 'service') {
    lines.push(
      'This service Host is managed by its operator and cannot be replaced by this Client.',
    );
  } else {
    lines.push('This Host cannot be replaced by this Client.');
  }
  if (handshake.compatibilityEpoch < RUNTIME_HOST_COMPATIBILITY_EPOCH) {
    lines.push(
      registration.lifecycleMode === 'service'
        ? 'Use the service operator to inspect or upgrade the Host.'
        : 'Use a previous compatible Maka build to inspect the Host and finish or clear any retained work. Stop the Host only after deciding that interruption is safe.',
    );
  } else {
    lines.push(
      `Host protocol ${handshake.protocolMin}-${handshake.protocolMax}; CLI protocol ${RUNTIME_HOST_PROTOCOL_VERSION}.`,
    );
  }
  return lines.join('\n');
}

export function shouldRetryRuntimeHostConflict(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();
  return normalized === 'w' || normalized === 'wait';
}

export type RuntimeHostCliConflictDecision = 'restart' | 'wait' | 'cancel';

export function resolveRuntimeHostCliConflictDecision(
  answer: string,
  canRestart: boolean,
): RuntimeHostCliConflictDecision {
  const normalized = answer.trim().toLowerCase();
  if (canRestart && (normalized === 'r' || normalized === 'restart')) return 'restart';
  if (normalized === 'w' || normalized === 'wait') return 'wait';
  return 'cancel';
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
