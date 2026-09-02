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

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  connectRuntimeHostProfile,
  createClientRuntimeHostCredentialStore,
  createClientRuntimeHostProfileCatalog,
  createRuntimeHostCapabilityProviderCredentialStore,
  createRuntimeHostPeerClientFromEnvironment,
  createRuntimeHostReconnectingConnection,
  loadOrCreateRuntimeHostClientInstanceId,
  RuntimeHostPermanentReconnectError,
  RuntimeHostProfileConnectionError,
  subscribeClientRuntimeHostProfileCatalogChanges,
  RuntimeHostRemoteCompatibilityError,
  runtimeHostProfileTargetFingerprint,
  type RemoteRuntimeHostProfile,
  type RuntimeHostCapabilityProviderCredentialStore,
  type RuntimeHostConnection,
  type RuntimeHostPeerClient,
  type RuntimeHostProfileCatalog,
  type RuntimeHostRemoteProfileIncarnation,
  type RuntimeHostReconnectingConnection,
} from '@maka/runtime-host/client';
import type { ClientCapabilityProvider } from '@maka/runtime-host/client';
import {
  tryAcquireFileLifetimeOwner,
  type FileLifetimeOwner,
} from '@maka/storage/file-lifetime-owner';
import type {
  TuiMcpPublicationAvailability,
  TuiMcpPublicationTarget,
  TuiMcpPublicationUnavailableReason,
} from './tui-mcp-control.js';

interface RemoteTuiMcpPublicationDeps {
  readonly credentials: RuntimeHostCapabilityProviderCredentialStore;
  readonly loadClientInstanceId: typeof loadOrCreateRuntimeHostClientInstanceId;
  readonly connectProfile: typeof connectRuntimeHostProfile;
  readonly createPeerClient: typeof createRuntimeHostPeerClientFromEnvironment;
  readonly createReconnectingConnection: typeof createRuntimeHostReconnectingConnection;
  readonly acquirePublicationLease: typeof tryAcquireFileLifetimeOwner;
  readonly profiles: Pick<
    RuntimeHostProfileCatalog,
    'readRemoteProfileIfCurrent' | 'mutateRemoteProfileIfCurrent'
  >;
  readonly subscribeProfileChanges: (listener: (error?: Error) => void) => () => void;
}

export function createRemoteTuiMcpPublicationTarget(
  input: {
    readonly clientDataRoot: string;
    readonly profile: RemoteRuntimeHostProfile;
    readonly profileIncarnationId: string;
    readonly ownerClientInstanceId: string;
  },
  overrides: Partial<RemoteTuiMcpPublicationDeps> = {},
): TuiMcpPublicationTarget {
  const deps: RemoteTuiMcpPublicationDeps = {
    credentials: createRuntimeHostCapabilityProviderCredentialStore(
      createClientRuntimeHostCredentialStore(input.clientDataRoot),
    ),
    loadClientInstanceId: loadOrCreateRuntimeHostClientInstanceId,
    connectProfile: connectRuntimeHostProfile,
    createPeerClient: createRuntimeHostPeerClientFromEnvironment,
    createReconnectingConnection: createRuntimeHostReconnectingConnection,
    acquirePublicationLease: tryAcquireFileLifetimeOwner,
    profiles: createClientRuntimeHostProfileCatalog(input.clientDataRoot),
    subscribeProfileChanges: (listener) =>
      subscribeClientRuntimeHostProfileCatalogChanges(input.clientDataRoot, listener),
    ...overrides,
  };
  return new RemoteTuiMcpPublicationTarget(input, deps);
}

class RemoteTuiMcpPublicationTarget implements TuiMcpPublicationTarget {
  readonly #input: {
    readonly clientDataRoot: string;
    readonly profile: RemoteRuntimeHostProfile;
    readonly profileIncarnationId: string;
    readonly ownerClientInstanceId: string;
  };
  readonly #deps: RemoteTuiMcpPublicationDeps;
  readonly #listeners = new Set<(availability: TuiMcpPublicationAvailability) => void>();
  #availability: TuiMcpPublicationAvailability = {
    kind: 'unavailable',
    reason: 'host_unavailable',
  };
  #connection: RuntimeHostReconnectingConnection | undefined;
  #publicationLease: FileLifetimeOwner | undefined;
  #disposeAvailability: (() => void) | undefined;
  #peerClient: RuntimeHostPeerClient | undefined;
  #peerCloseTask = Promise.resolve();
  #operation = Promise.resolve();
  #connectAbort: AbortController | undefined;
  #generation = 0;
  #closed = false;
  #closeTask: Promise<void> | undefined;
  #disposeProfileChanges: (() => void) | undefined;
  #profileValidationQueued = false;
  #profileInvalidationGeneration = 0;
  #profileValidationError: Error | undefined;

  constructor(
    input: {
      readonly clientDataRoot: string;
      readonly profile: RemoteRuntimeHostProfile;
      readonly profileIncarnationId: string;
      readonly ownerClientInstanceId: string;
    },
    deps: RemoteTuiMcpPublicationDeps,
  ) {
    this.#input = input;
    this.#deps = deps;
    try {
      this.#disposeProfileChanges = deps.subscribeProfileChanges((error) => {
        this.#scheduleProfileValidation(error);
      });
    } catch (error) {
      this.#scheduleProfileValidation(error instanceof Error ? error : new Error(String(error)));
    }
    void this.#serialize(async () => {
      let lease: FileLifetimeOwner | undefined;
      try {
        lease = await deps.acquirePublicationLease(providerLeasePath(input));
      } catch {
        await this.#retire('host_unavailable');
        return;
      }
      if (!lease) {
        await this.#retire('provider_conflict');
        return;
      }
      if (this.#closed) {
        await lease.close();
        return;
      }
      this.#publicationLease = lease;
      const profileCurrent = await this.#profileStillCurrent().catch(() => undefined);
      if (profileCurrent !== true) {
        await this.#retire(profileCurrent === false ? 'target_mismatch' : 'host_unavailable');
        return;
      }
      const credential = await deps.credentials.get(
        this.#profileTarget(),
        input.ownerClientInstanceId,
      );
      if (this.#closed) return;
      if (!credential) {
        this.#setUnavailable('credential_required');
        return;
      }
      await this.#connect(credential);
    }).catch(() => {
      if (!this.#closed) this.#setUnavailable('host_unavailable');
    });
  }

  replaceClientCapabilities(provider: ClientCapabilityProvider, timeoutMs?: number) {
    return this.#serialize(async () => {
      if (this.#closed) throw new Error('Remote MCP publication is closed');
      let result:
        | Awaited<ReturnType<RuntimeHostConnection['replaceClientCapabilities']>>
        | undefined;
      const committed = await this.#deps.profiles.mutateRemoteProfileIfCurrent(
        this.#profileTarget(),
        async () => {
          result = await this.#requireConnection().replaceClientCapabilities(provider, timeoutMs);
        },
      );
      if (!committed) {
        await this.#retire('target_mismatch');
        throw new RuntimeHostProfileConnectionError(
          'target_mismatch',
          'Remote MCP publication profile is no longer current',
        );
      }
      if (!result) throw new Error('Runtime Host did not confirm MCP capability registration');
      return result;
    });
  }

  unregisterClientCapabilities(timeoutMs?: number) {
    return this.#requireConnection().unregisterClientCapabilities(timeoutMs);
  }

  subscribeConnectionAvailability(
    listener: (availability: TuiMcpPublicationAvailability) => void,
  ): () => void {
    this.#listeners.add(listener);
    try {
      listener(this.#availability);
    } catch {
      // Presentation cannot invalidate the companion lifecycle.
    }
    return () => this.#listeners.delete(listener);
  }

  setCredential(credential: string): Promise<void> {
    this.#cancelConnect();
    return this.#serialize(async () => {
      if (this.#closed) throw new Error('Remote MCP publication is closed');
      const committed = await this.#deps.profiles.mutateRemoteProfileIfCurrent(
        this.#profileTarget(),
        (profile) =>
          this.#deps.credentials.set(
            { profile, profileIncarnationId: this.#input.profileIncarnationId },
            this.#input.ownerClientInstanceId,
            credential,
          ),
      );
      if (!committed) {
        await this.#retire('target_mismatch');
        throw new RuntimeHostProfileConnectionError(
          'target_mismatch',
          'Remote MCP publication profile is no longer current',
        );
      }
      await this.#disconnect();
      await this.#connect(credential);
    });
  }

  removeCredential(): Promise<void> {
    this.#cancelConnect();
    return this.#serialize(async () => {
      if (this.#closed) throw new Error('Remote MCP publication is closed');
      await this.#disconnect();
      const committed = await this.#deps.profiles.mutateRemoteProfileIfCurrent(
        this.#profileTarget(),
        (profile) =>
          this.#deps.credentials.delete(
            { profile, profileIncarnationId: this.#input.profileIncarnationId },
            this.#input.ownerClientInstanceId,
          ),
      );
      if (!committed) {
        await this.#retire('target_mismatch');
        throw new RuntimeHostProfileConnectionError(
          'target_mismatch',
          'Remote MCP publication profile is no longer current',
        );
      }
      this.#setUnavailable('credential_required');
    });
  }

  closePublication(): Promise<void> {
    this.#cancelConnect();
    return this.#beginClose({ waitForOperations: true });
  }

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const pending = this.#operation.then(work, work);
    this.#operation = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  async #connect(credential: string): Promise<void> {
    const generation = ++this.#generation;
    const abort = new AbortController();
    this.#connectAbort = abort;
    this.#setUnavailable('host_unavailable');
    try {
      const clientInstanceId = await this.#deps.loadClientInstanceId(
        providerIdentityPath(this.#input),
      );
      const peerClient =
        this.#input.profile.transport.kind === 'libp2p-direct'
          ? this.#deps.createPeerClient()
          : undefined;
      this.#peerClient = peerClient;
      const connect = async (signal?: AbortSignal): Promise<RuntimeHostConnection> => {
        const profile = await this.#requireCurrentProfile();
        const connection = await this.#deps.connectProfile({
          profile,
          credential,
          clientInstanceId,
          sshInteraction: 'batch',
          ...(peerClient ? { peerClient } : {}),
          signal: signal ? AbortSignal.any([abort.signal, signal]) : abort.signal,
        });
        return this.#keepIfProfileCurrent(connection);
      };
      const initial = await connect();
      if (this.#closed || generation !== this.#generation) {
        await initial.close().catch(() => undefined);
        await this.#closePeer(peerClient);
        return;
      }
      const connection = await this.#keepIfProfileCurrent(
        await this.#deps.createReconnectingConnection({
          initialConnection: initial,
          connect,
          onFatalError: (error) => {
            if (!this.#closed && generation === this.#generation) {
              this.#setUnavailable(classifyUnavailable(error));
              if (this.#peerClient === peerClient) {
                void this.#closePeer(peerClient);
              }
            }
          },
        }),
      );
      if (this.#closed || generation !== this.#generation) {
        await connection.close().catch(() => undefined);
        await this.#closePeer(peerClient);
        return;
      }
      this.#connection = connection;
      this.#disposeAvailability = connection.subscribeConnectionAvailability((availability) => {
        if (this.#closed || generation !== this.#generation) return;
        this.#setAvailability(
          availability.kind === 'connected'
            ? availability
            : { kind: 'unavailable', reason: 'host_unavailable' },
        );
      });
    } catch (error) {
      if (!this.#closed && generation === this.#generation) {
        this.#setUnavailable(classifyUnavailable(error));
      }
      await this.#closePeer(this.#peerClient);
    } finally {
      if (this.#connectAbort === abort) this.#connectAbort = undefined;
    }
  }

  async #disconnect(): Promise<void> {
    this.#cancelConnect();
    this.#generation += 1;
    this.#disposeAvailability?.();
    this.#disposeAvailability = undefined;
    const connection = this.#connection;
    this.#connection = undefined;
    await connection?.close().catch(() => undefined);
    await this.#closePeer(this.#peerClient);
    await this.#peerCloseTask;
    if (!this.#closed) this.#setUnavailable('host_unavailable');
  }

  #scheduleProfileValidation(error?: Error): void {
    if (this.#closed) return;
    this.#profileInvalidationGeneration += 1;
    this.#profileValidationError ??= error;
    if (this.#profileValidationQueued) return;
    this.#profileValidationQueued = true;
    void this.#serialize(async () => {
      try {
        while (!this.#closed) {
          const generation = this.#profileInvalidationGeneration;
          const profileCurrent = await this.#profileStillCurrent().catch(() => undefined);
          const validationError = this.#profileValidationError;
          this.#profileValidationError = undefined;
          if (this.#closed) return;
          if (validationError || profileCurrent !== true) {
            await this.#retire(
              validationError || profileCurrent === undefined
                ? 'host_unavailable'
                : 'target_mismatch',
            );
            return;
          }
          if (generation === this.#profileInvalidationGeneration) return;
        }
      } finally {
        this.#profileValidationQueued = false;
      }
    });
  }

  async #currentProfile(): Promise<RemoteRuntimeHostProfile | undefined> {
    return this.#deps.profiles.readRemoteProfileIfCurrent(this.#profileTarget());
  }

  async #profileStillCurrent(): Promise<boolean> {
    return (await this.#currentProfile()) !== undefined;
  }

  async #requireCurrentProfile(): Promise<RemoteRuntimeHostProfile> {
    const profile = await this.#currentProfile();
    if (profile) return profile;
    throw new RuntimeHostProfileConnectionError(
      'target_mismatch',
      'Remote MCP publication profile is no longer current',
    );
  }

  async #keepIfProfileCurrent<T extends RuntimeHostConnection>(connection: T): Promise<T> {
    try {
      await this.#requireCurrentProfile();
      return connection;
    } catch (error) {
      await connection.close().catch(() => undefined);
      throw error;
    }
  }

  #profileTarget(): RuntimeHostRemoteProfileIncarnation {
    return {
      profile: this.#input.profile,
      profileIncarnationId: this.#input.profileIncarnationId,
    };
  }

  async #retire(reason: TuiMcpPublicationUnavailableReason): Promise<void> {
    await this.#beginClose({ reason, waitForOperations: false });
  }

  #beginClose(input: {
    readonly reason?: TuiMcpPublicationUnavailableReason;
    readonly waitForOperations: boolean;
  }): Promise<void> {
    if (this.#closeTask) return this.#closeTask;
    this.#closed = true;
    this.#disposeProfileChanges?.();
    this.#disposeProfileChanges = undefined;
    if (input.reason) this.#setUnavailable(input.reason);
    const operations = input.waitForOperations
      ? this.#operation.catch(() => undefined)
      : Promise.resolve();
    this.#closeTask = operations.then(async () => {
      await this.#disconnect();
      const lease = this.#publicationLease;
      this.#publicationLease = undefined;
      try {
        await lease?.close();
      } finally {
        this.#listeners.clear();
      }
    });
    return this.#closeTask;
  }

  #requireConnection(): RuntimeHostReconnectingConnection {
    if (this.#connection && this.#availability.kind === 'connected') return this.#connection;
    throw new RuntimeHostPermanentReconnectError('Remote MCP publication is unavailable');
  }

  #cancelConnect(): void {
    this.#connectAbort?.abort(new Error('Remote MCP publication target changed'));
  }

  #closePeer(peerClient: RuntimeHostPeerClient | undefined): Promise<void> {
    if (!peerClient) return this.#peerCloseTask;
    if (this.#peerClient === peerClient) this.#peerClient = undefined;
    const closing = this.#peerCloseTask.then(() => peerClient.close()).catch(() => undefined);
    this.#peerCloseTask = closing;
    return closing;
  }

  #setUnavailable(reason: TuiMcpPublicationUnavailableReason): void {
    this.#setAvailability({ kind: 'unavailable', reason });
  }

  #setAvailability(availability: TuiMcpPublicationAvailability): void {
    this.#availability = availability;
    for (const listener of this.#listeners) {
      try {
        listener(availability);
      } catch {
        // Presentation cannot invalidate the companion lifecycle.
      }
    }
  }
}

function providerIdentityPath(input: {
  readonly clientDataRoot: string;
  readonly profile: RemoteRuntimeHostProfile;
  readonly profileIncarnationId: string;
  readonly ownerClientInstanceId: string;
}): string {
  return join(
    input.clientDataRoot,
    'runtime-host-client',
    'capability-provider-identities',
    `${providerIdentity(input)}.json`,
  );
}

function providerLeasePath(input: {
  readonly clientDataRoot: string;
  readonly profile: RemoteRuntimeHostProfile;
  readonly profileIncarnationId: string;
  readonly ownerClientInstanceId: string;
}): string {
  return join(
    input.clientDataRoot,
    'runtime-host-client',
    'capability-provider-leases',
    `${providerIdentity(input)}.lease`,
  );
}

function providerIdentity(input: {
  readonly profile: RemoteRuntimeHostProfile;
  readonly profileIncarnationId: string;
  readonly ownerClientInstanceId: string;
}): string {
  return createHash('sha256')
    .update('tui-mcp-capability-provider')
    .update('\0')
    .update(runtimeHostProfileTargetFingerprint(input.profile))
    .update('\0')
    .update(input.profileIncarnationId)
    .update('\0')
    .update(input.ownerClientInstanceId)
    .digest('hex')
    .slice(0, 24);
}

function classifyUnavailable(error: unknown): TuiMcpPublicationUnavailableReason {
  if (error instanceof RuntimeHostProfileConnectionError) return error.reason;
  if (error instanceof RuntimeHostRemoteCompatibilityError) return 'target_mismatch';
  return 'host_unavailable';
}
