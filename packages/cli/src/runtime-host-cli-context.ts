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

import { activateLocalManagedRuntimeHost } from './runtime-host-local-managed-activation.js';
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
  connectRuntimeHost,
  connectRuntimeHostProfile,
  createClientRuntimeHostProfileCatalog,
  createRuntimeHostPeerClientFromEnvironment,
  createRuntimeHostReconnectingConnection,
  loadOrCreateRuntimeHostClientInstanceId,
  LOCAL_RUNTIME_HOST_PROFILE,
  readRuntimeHostConnectionCatalog,
  RuntimeHostPermanentReconnectError,
  RuntimeHostRemoteCompatibilityError,
  runHostHandoff,
  type OpenHostHandoffSurface,
  type HostHandoffReplacement,
  type HostHandoffObservation,
  runtimeHostStartupError,
  type RuntimeHostConnection,
  type RuntimeHostProfile,
  type ResolvedRuntimeHostProfile,
  type RuntimeHostProfileCatalog,
  type RuntimeHostPeerClient,
} from '@maka/runtime-host/client';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
} from '@maka/runtime-host/protocol';
import {
  readLocalHostDeploymentRecord,
  resolveRuntimeHostManagedDeploymentAuthority,
} from '@maka/runtime-host/operator';
import { resolveMakaClientDataRoot } from '@maka/storage/workspace-root';
import {
  isTemporaryNpxInstallation,
  resolveRuntimeHostNpmGlobalInstallation,
} from './runtime-host-cli-installation.js';
import {
  restartRuntimeHostNpmGlobalDeployment,
  runtimeHostNpmGlobalSourceRetirementAvailable,
} from './runtime-host-local-handoff.js';

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
  readonly handoffSurface?: OpenHostHandoffSurface;
}

export interface RuntimeHostCliTarget {
  readonly connection: ConnectionCatalogEntry;
  readonly model: string;
}

interface RuntimeHostCliContextDeps {
  readonly connectOrSpawn: typeof connectOrSpawnRuntimeHost;
  readonly connectActivatedHost: typeof connectRuntimeHost;
  readonly activateLocalManagedHost: typeof activateLocalManagedRuntimeHost;
  readonly connectProfile: typeof connectRuntimeHostProfile;
  readonly readConnectionCatalog: typeof readRuntimeHostConnectionCatalog;
  readonly loadClientInstanceId: typeof loadOrCreateRuntimeHostClientInstanceId;
  readonly executionCandidateEntrypoint: URL;
  readonly readDeploymentRecord: typeof readLocalHostDeploymentRecord;
  readonly resolveManagedAuthority: typeof resolveRuntimeHostManagedDeploymentAuthority;
  readonly createPeerClient: typeof createRuntimeHostPeerClientFromEnvironment;
  readonly profileCatalog?: RuntimeHostProfileCatalog;
  readonly resolveInstallation: typeof resolveRuntimeHostNpmGlobalInstallation;
  readonly isTemporaryNpxInstallation: typeof isTemporaryNpxInstallation;
  readonly restartDeployment: typeof restartRuntimeHostNpmGlobalDeployment;
  readonly sourceRetirementAvailable: typeof runtimeHostNpmGlobalSourceRetirementAvailable;
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
    activateLocalManagedHost: activateLocalManagedRuntimeHost,
    connectActivatedHost: connectRuntimeHost,
    connectProfile: connectRuntimeHostProfile,
    readConnectionCatalog: readRuntimeHostConnectionCatalog,
    loadClientInstanceId: loadOrCreateRuntimeHostClientInstanceId,
    executionCandidateEntrypoint: new URL(
      import.meta.resolve('@maka/runtime-host/execution-candidate-main'),
    ),
    readDeploymentRecord: readLocalHostDeploymentRecord,
    resolveManagedAuthority: resolveRuntimeHostManagedDeploymentAuthority,
    createPeerClient: createRuntimeHostPeerClientFromEnvironment,
    resolveInstallation: resolveRuntimeHostNpmGlobalInstallation,
    isTemporaryNpxInstallation,
    restartDeployment: restartRuntimeHostNpmGlobalDeployment,
    sourceRetirementAvailable: runtimeHostNpmGlobalSourceRetirementAvailable,
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
  // A temporary package is evidence for invocation lifetime, never deployment
  // authority. This only guards candidates we create; using an existing Host
  // leaves that Host's ownership and lifetime unchanged.
  const invocationOwned = profile.kind === 'local' && (await deps.isTemporaryNpxInstallation());
  const connectInput = {
    rootPath: input.rootPath,
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId,
    compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
    candidateEntrypoint: deps.executionCandidateEntrypoint,
    ...(invocationOwned ? { closeOnLauncherExit: true } : {}),
  } as const;
  const connect = async (
    signal?: AbortSignal,
    sshInteraction: 'batch' | 'inherit' = 'batch',
  ): Promise<RuntimeHostConnection> => {
    const observe = async (): Promise<HostHandoffObservation<RuntimeHostConnection>> => {
      if (profile.kind !== 'local') {
        try {
          const connection = await deps.connectProfile({
            profile,
            ...(resolvedProfile.credential ? { credential: resolvedProfile.credential } : {}),
            clientInstanceId,
            sshInteraction,
            ...(peerClient ? { peerClient } : {}),
            ...(signal ? { signal } : {}),
          });
          return { kind: 'ready', value: connection };
        } catch (error) {
          if (!(error instanceof RuntimeHostRemoteCompatibilityError)) throw error;
          return {
            kind: 'blocked',
            blocker: {
              identity: JSON.stringify([profile, error.hostEpoch, error.details]),
              target: {
                name: profile.name,
                location: 'remote',
                rootId: profile.rootId,
                hostEpoch: error.hostEpoch,
              },
              reason: 'upgrade',
              mayExitNaturally: false,
              diagnostic: error.message,
            },
          };
        }
      }
      let connected = await deps.connectOrSpawn({
        ...connectInput,
        ...(signal ? { signal } : {}),
      });
      if (connected.kind === 'failed' && connected.reason === 'managed_root_requires_operator') {
        await deps.activateLocalManagedHost({
          rootPath: input.rootPath,
          ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        // The installed operator owns launch. Compatibility is still projected
        // by the same handoff journey as an already-running managed Host.
        const activated = await deps.connectActivatedHost(connectInput);
        if (activated.kind === 'unavailable' || activated.kind === 'draining') {
          throw new Error(
            `The installed Runtime Host was activated but the local CLI could not join it (${activated.kind === 'unavailable' ? activated.reason : activated.kind}). Use a compatible CLI or update the managed Host through its configured operator.`,
          );
        }
        if (activated.kind === 'connected' && signal?.aborted) {
          await activated.connection.close();
          signal.throwIfAborted();
        }
        connected = activated;
      }
      if (connected.kind === 'incompatible' || connected.kind === 'upgrade_required') {
        const managed = await deps.resolveManagedAuthority(connected.registration.rootId);
        const record = managed
          ? undefined
          : await deps.readDeploymentRecord(connected.registration.rootId);
        let replacement: HostHandoffReplacement | undefined;
        let installation;
        // On-demand managed Hosts are also ephemeral processes. Their durable
        // operator authority, not the process lifetime label, decides who may
        // replace them (including when the Host was already running).
        if (!managed && connected.registration.lifecycleMode === 'ephemeral') {
          try {
            installation = await deps.resolveInstallation();
          } catch {
            /* No persistent installation authority. */
          }
          const owner = record?.state.kind === 'handoff' ? record.state.from : record?.state.owner;
          if (
            installation &&
            (!owner ||
              (owner.kind === installation.owner.kind &&
                owner.installationId === installation.owner.installationId))
          ) {
            const expectedInstallation = installation;
            const canInterrupt = record
              ? await deps
                  .sourceRetirementAvailable({
                    rootId: connected.registration.rootId,
                    owner: installation.owner,
                    source: record.state.selected,
                  })
                  .catch(() => false)
              : false;
            replacement = {
              kind: record?.state.kind === 'handoff' ? 'repair' : 'replace',
              canReplaceIdle: true,
              canInterrupt,
              execute: async (activeWorkPolicy, _progress, _consent, attemptSignal) => {
                const result = await deps.restartDeployment({
                  rootPath: input.rootPath,
                  registration: connected.registration,
                  activeWorkPolicy,
                  expectedInstallation,
                  ...(attemptSignal ? { signal: attemptSignal } : {}),
                });
                if (result.kind === 'completed') return { kind: 'completed' };
                if (result.kind === 'active_work') return { kind: 'active_work' };
                if (
                  result.kind === 'changed' ||
                  result.kind === 'rejected' ||
                  result.kind === 'operator_required'
                )
                  return { kind: 'changed' };
                return {
                  kind: 'recovery_required',
                  diagnostic: `Local service recovery is required at ${result.phase}`,
                };
              },
            };
          }
        }
        return {
          kind: 'blocked',
          blocker: {
            identity: JSON.stringify([
              connected.registration,
              managed?.record,
              record,
              installation,
            ]),
            target: {
              name: profile.name,
              location: 'local',
              rootId: connected.registration.rootId,
              hostEpoch: connected.registration.hostEpoch,
            },
            reason: record?.state.kind === 'handoff' ? 'repair' : 'upgrade',
            ...(connected.handshake?.activity ? { activity: connected.handshake.activity } : {}),
            mayExitNaturally:
              !managed &&
              connected.registration.lifecycleMode === 'ephemeral' &&
              connected.handshake?.replacement === 'wait_for_idle_exit',
            ...(replacement ? { replacement } : {}),
          },
        };
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
      return { kind: 'ready', value: connected.connection };
    };
    return runHostHandoff({ observe, signal, openSurface: input.handoffSurface });
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
