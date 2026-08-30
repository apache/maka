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
  sameRemoteRuntimeHostProfileTarget,
  subscribeClientRuntimeHostProfileCatalogChanges,
  RuntimeHostRemoteCompatibilityError,
  runtimeHostProfileTargetFingerprint,
  type RemoteRuntimeHostProfile,
  type RuntimeHostCapabilityProviderCredentialStore,
  type RuntimeHostConnection,
  type RuntimeHostPeerClient,
  type RuntimeHostProfileCatalog,
  type RuntimeHostReconnectingConnection,
} from '@maka/runtime-host/client';
import type { ClientCapabilityProvider } from '@maka/runtime-host/client';
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
  readonly profiles: RuntimeHostProfileCatalog;
  readonly subscribeProfileChanges: (listener: (error?: Error) => void) => () => void;
}

export function createRemoteTuiMcpPublicationTarget(
  input: {
    readonly clientDataRoot: string;
    readonly profile: RemoteRuntimeHostProfile;
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
    readonly ownerClientInstanceId: string;
  };
  readonly #deps: RemoteTuiMcpPublicationDeps;
  readonly #listeners = new Set<(availability: TuiMcpPublicationAvailability) => void>();
  #availability: TuiMcpPublicationAvailability = {
    kind: 'unavailable',
    reason: 'host_unavailable',
  };
  #connection: RuntimeHostReconnectingConnection | undefined;
  #disposeAvailability: (() => void) | undefined;
  #peerClient: RuntimeHostPeerClient | undefined;
  #operation = Promise.resolve();
  #connectAbort: AbortController | undefined;
  #generation = 0;
  #closed = false;
  #closeTask: Promise<void> | undefined;
  #disposeProfileChanges: (() => void) | undefined;
  #profileValidationQueued = false;
  #profileValidationError: Error | undefined;

  constructor(
    input: {
      readonly clientDataRoot: string;
      readonly profile: RemoteRuntimeHostProfile;
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
      const profileCurrent = await this.#profileStillCurrent().catch(() => undefined);
      if (profileCurrent !== true) {
        await this.#retire(profileCurrent === false ? 'target_mismatch' : 'host_unavailable');
        return;
      }
      const credential = await deps.credentials.get(input.profile, input.ownerClientInstanceId);
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
    return this.#requireConnection().replaceClientCapabilities(provider, timeoutMs);
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
      await this.#deps.credentials.set(
        this.#input.profile,
        this.#input.ownerClientInstanceId,
        credential,
      );
      await this.#disconnect();
      await this.#connect(credential);
    });
  }

  removeCredential(): Promise<void> {
    this.#cancelConnect();
    return this.#serialize(async () => {
      if (this.#closed) throw new Error('Remote MCP publication is closed');
      await this.#disconnect();
      await this.#deps.credentials.delete(this.#input.profile, this.#input.ownerClientInstanceId);
      this.#setUnavailable('credential_required');
    });
  }

  closePublication(): Promise<void> {
    this.#cancelConnect();
    this.#closeTask ??= this.#close();
    return this.#closeTask;
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
      const connect = (signal?: AbortSignal): Promise<RuntimeHostConnection> =>
        this.#deps.connectProfile({
          profile: this.#input.profile,
          credential,
          clientInstanceId,
          sshInteraction: 'batch',
          ...(peerClient ? { peerClient } : {}),
          signal: signal ? AbortSignal.any([abort.signal, signal]) : abort.signal,
        });
      const initial = await connect();
      if (this.#closed || generation !== this.#generation) {
        await initial.close().catch(() => undefined);
        await peerClient?.close().catch(() => undefined);
        return;
      }
      const connection = await this.#deps.createReconnectingConnection({
        initialConnection: initial,
        connect,
        onFatalError: (error) => {
          if (!this.#closed && generation === this.#generation) {
            this.#setUnavailable(classifyUnavailable(error));
            if (this.#peerClient === peerClient) {
              this.#peerClient = undefined;
              void peerClient?.close().catch(() => undefined);
            }
          }
        },
      });
      if (this.#closed || generation !== this.#generation) {
        await connection.close().catch(() => undefined);
        await peerClient?.close().catch(() => undefined);
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
      await this.#peerClient?.close().catch(() => undefined);
      this.#peerClient = undefined;
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
    await this.#peerClient?.close().catch(() => undefined);
    this.#peerClient = undefined;
    if (!this.#closed) this.#setUnavailable('host_unavailable');
  }

  async #close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#disposeProfileChanges?.();
    this.#disposeProfileChanges = undefined;
    await this.#operation.catch(() => undefined);
    await this.#disconnect();
    this.#listeners.clear();
  }

  #scheduleProfileValidation(error?: Error): void {
    if (this.#closed) return;
    this.#profileValidationError ??= error;
    if (this.#profileValidationQueued) return;
    this.#profileValidationQueued = true;
    void this.#serialize(async () => {
      const profileCurrent = await this.#profileStillCurrent().catch(() => undefined);
      const validationError = this.#profileValidationError;
      this.#profileValidationError = undefined;
      this.#profileValidationQueued = false;
      if (this.#closed) return;
      if (validationError || profileCurrent !== true) {
        await this.#retire(
          validationError || profileCurrent === undefined ? 'host_unavailable' : 'target_mismatch',
        );
      }
    });
  }

  async #profileStillCurrent(): Promise<boolean> {
    const document = await this.#deps.profiles.read();
    const current = document.profiles.find((profile) => profile.id === this.#input.profile.id);
    return (
      current?.kind === 'remote' && sameRemoteRuntimeHostProfileTarget(current, this.#input.profile)
    );
  }

  async #retire(reason: TuiMcpPublicationUnavailableReason): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#disposeProfileChanges?.();
    this.#disposeProfileChanges = undefined;
    this.#setUnavailable(reason);
    await this.#disconnect();
    this.#listeners.clear();
  }

  #requireConnection(): RuntimeHostReconnectingConnection {
    if (this.#connection && this.#availability.kind === 'connected') return this.#connection;
    throw new RuntimeHostPermanentReconnectError('Remote MCP publication is unavailable');
  }

  #cancelConnect(): void {
    this.#connectAbort?.abort(new Error('Remote MCP publication target changed'));
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
  readonly ownerClientInstanceId: string;
}): string {
  const identity = createHash('sha256')
    .update('tui-mcp-capability-provider')
    .update('\0')
    .update(runtimeHostProfileTargetFingerprint(input.profile))
    .update('\0')
    .update(input.ownerClientInstanceId)
    .digest('hex')
    .slice(0, 24);
  return join(
    input.clientDataRoot,
    'runtime-host-client',
    'capability-provider-identities',
    `${identity}.json`,
  );
}

function classifyUnavailable(error: unknown): TuiMcpPublicationUnavailableReason {
  if (error instanceof RuntimeHostProfileConnectionError) return error.reason;
  if (error instanceof RuntimeHostRemoteCompatibilityError) return 'target_mismatch';
  return 'host_unavailable';
}
