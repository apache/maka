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

import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { createFileCredentialStore, type CredentialStore } from '@maka/storage/credential-store';
import { withFileUpdateLock } from '@maka/storage/file-update-lock';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  isCanonicalRuntimeHostWebSocketPath,
  RUNTIME_HOST_PROTOCOL_VERSION,
  requireHostRootId,
} from '../protocol/index.js';
import type { RuntimeHostProfileOfKind } from '../profile-kind.js';
import {
  connectRemoteRuntimeHost,
  connectRuntimeHostMessageTransport,
  normalizeRemoteRuntimeHostUrl,
  type ConnectRemoteRuntimeHostResult,
  type RuntimeHostConnection,
} from './connection.js';
import { FramedByteStreamTransport } from '../transport/framed-byte-stream-transport.js';
import {
  RuntimeHostPeerByteStream,
  RuntimeHostPeerError,
  readRuntimeHostPeerAuthenticationResult,
  writeRuntimeHostPeerAuthentication,
} from '../transport/peer-native.js';
import type { RuntimeHostPeerClient } from './peer-client.js';
import { RuntimeHostPermanentReconnectError } from './reconnect-lifecycle.js';
import { RuntimeHostRemoteCompatibilityError } from './remote-compatibility-error.js';
import {
  normalizeRuntimeHostSshDestination,
  openRuntimeHostSshTunnel,
  type RuntimeHostSshInteraction,
} from './ssh-tunnel.js';
import { activateRuntimeHostSshOperator } from './ssh-operator-activation.js';
import { waitForRuntimeHostReady } from './wait-for-ready.js';
import {
  connectRuntimeHostWslEnvironment,
  normalizeRuntimeHostWslDistribution,
  normalizeRuntimeHostWslOperatorPath,
  type RuntimeHostWslProcessFactory,
} from './wsl-environment.js';

const PROFILE_SCHEMA_VERSION = 2;
const PROFILE_DOCUMENT_MAX_BYTES = 64 * 1024;
const PROFILE_COUNT_MAX = 32;
const PROFILE_NAME_MAX_BYTES = 128;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PEER_ID_MAX_BYTES = 160;
const PEER_ADDRESS_MAX_BYTES = 2 * 1024;
const PEER_ROUTE_MAX = 16;
export const RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES = 8 * 1024;
export const RUNTIME_HOST_PLAINTEXT_ACKNOWLEDGEMENT = 'plaintext-bearer-v1' as const;

export const LOCAL_RUNTIME_HOST_PROFILE = Object.freeze({
  id: 'local',
  name: 'Local',
  kind: 'local',
} as const satisfies RuntimeHostProfileOfKind<'local'> & {
  readonly id: string;
  readonly name: string;
});

export type RuntimeHostProfile = typeof LOCAL_RUNTIME_HOST_PROFILE | PersistedRuntimeHostProfile;

export type PersistedRuntimeHostProfile = EnvironmentRuntimeHostProfile | RemoteRuntimeHostProfile;

export interface EnvironmentRuntimeHostProfile extends RuntimeHostProfileOfKind<'environment'> {
  readonly id: string;
  readonly name: string;
  readonly provider: {
    readonly kind: 'wsl';
    readonly distribution: string;
  };
  readonly rootId: string;
  readonly operatorPath: string;
}

export interface RemoteRuntimeHostProfile extends RuntimeHostProfileOfKind<'remote'> {
  readonly id: string;
  readonly name: string;
  readonly transport: RuntimeHostRemoteTransport;
  readonly rootId: string;
}

export type RuntimeHostRemoteTransport =
  | {
      readonly kind: 'tls';
      readonly url: string;
    }
  | {
      readonly kind: 'plaintext';
      readonly url: string;
      readonly acknowledgement: typeof RUNTIME_HOST_PLAINTEXT_ACKNOWLEDGEMENT;
    }
  | {
      readonly kind: 'ssh';
      readonly destination: string;
      readonly sshPort?: number;
      readonly remotePort: number;
      readonly websocketPath: string;
      readonly activation?: never;
    }
  | {
      readonly kind: 'ssh';
      readonly destination: string;
      readonly sshPort?: number;
      readonly activation: {
        readonly kind: 'ssh_operator';
        readonly operatorPath: string;
      };
      readonly remotePort?: never;
      readonly websocketPath?: never;
    }
  | {
      readonly kind: 'libp2p-direct';
      readonly peerId: string;
      readonly routeHints: readonly string[];
      readonly coordinationRelays: readonly string[];
    };

export interface RuntimeHostProfileDocument {
  readonly schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  readonly profiles: readonly PersistedRuntimeHostProfile[];
}

export interface ResolvedRuntimeHostProfile {
  readonly profile: RuntimeHostProfile;
  readonly credential?: string;
}

export function sameResolvedRuntimeHostProfileTarget(
  left: ResolvedRuntimeHostProfile,
  right: ResolvedRuntimeHostProfile,
): boolean {
  if (left.profile.kind !== right.profile.kind) return false;
  if (left.profile.kind === 'local' || right.profile.kind === 'local') return true;
  if (left.profile.kind === 'environment' || right.profile.kind === 'environment') {
    return profileTargetBinding(left.profile) === profileTargetBinding(right.profile);
  }
  return (
    left.profile.id === right.profile.id &&
    profileCredentialBinding(left.profile) === profileCredentialBinding(right.profile) &&
    left.credential === right.credential
  );
}

export function sameRemoteRuntimeHostProfileTarget(
  left: RemoteRuntimeHostProfile,
  right: RemoteRuntimeHostProfile,
): boolean {
  return profileCredentialBinding(left) === profileCredentialBinding(right);
}

export interface RuntimeHostProfileCatalog {
  read(): Promise<RuntimeHostProfileDocument>;
  resolve(profileId?: string): Promise<ResolvedRuntimeHostProfile>;
  create(
    profile: PersistedRuntimeHostProfile,
    credential?: string,
  ): Promise<RuntimeHostProfileDocument>;
  save(
    profile: PersistedRuntimeHostProfile,
    credential?: string,
  ): Promise<RuntimeHostProfileDocument>;
  remove(profileId: string): Promise<RuntimeHostProfileDocument>;
  removeIfCurrent(target: ResolvedRuntimeHostProfile): Promise<{
    readonly removed: boolean;
    readonly document: RuntimeHostProfileDocument;
  }>;
  rebindIfCurrent(
    target: ResolvedRuntimeHostProfile,
    profile: RemoteRuntimeHostProfile,
    credential: string,
  ): Promise<{
    readonly rebound: boolean;
    readonly document: RuntimeHostProfileDocument;
  }>;
}

export interface RuntimeHostProfileCredentialStore {
  get(profile: RemoteRuntimeHostProfile): Promise<string | null>;
  set(profile: RemoteRuntimeHostProfile, credential: string): Promise<void>;
  delete(profile: RemoteRuntimeHostProfile): Promise<void>;
}

export function createFileRuntimeHostProfileCatalog(
  path: string,
  credentials: RuntimeHostProfileCredentialStore,
): RuntimeHostProfileCatalog {
  return new FileRuntimeHostProfileCatalog(path, credentials);
}

export function createClientRuntimeHostProfileCatalog(
  clientDataRoot: string,
  credentialStore: CredentialStore = createClientRuntimeHostCredentialStore(clientDataRoot),
): RuntimeHostProfileCatalog {
  return createFileRuntimeHostProfileCatalog(
    join(clientDataRoot, 'runtime-host-profiles.json'),
    createRuntimeHostProfileCredentialStore(credentialStore),
  );
}

export function createClientRuntimeHostCredentialStore(clientDataRoot: string): CredentialStore {
  return createFileCredentialStore(join(clientDataRoot, 'runtime-host-client'));
}

export function createRuntimeHostProfileCredentialStore(
  credentials: Pick<CredentialStore, 'getSecret' | 'setSecret' | 'deleteSecret'>,
): RuntimeHostProfileCredentialStore {
  return {
    get: async (profile) => {
      return credentials.getSecret(profileCredentialSlot(profile), 'runtime_host_access');
    },
    set: (profile, credential) => {
      if (
        !credential ||
        /\s/u.test(credential) ||
        Buffer.byteLength(credential, 'utf8') > RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES
      ) {
        return Promise.reject(new Error('Runtime Host access credential is invalid'));
      }
      return credentials.setSecret(
        profileCredentialSlot(profile),
        'runtime_host_access',
        credential,
      );
    },
    delete: (profile) =>
      credentials.deleteSecret(profileCredentialSlot(profile), 'runtime_host_access'),
  };
}

export async function connectRuntimeHostProfile(
  input: {
    readonly profile: PersistedRuntimeHostProfile;
    readonly credential?: string;
    readonly clientInstanceId: string;
    readonly signal?: AbortSignal;
    readonly connectTimeoutMs?: number;
    readonly handshakeTimeoutMs?: number;
    readonly readyTimeoutMs?: number;
    readonly sshInteraction?: RuntimeHostSshInteraction;
    readonly peerClient?: RuntimeHostPeerClient;
  },
  overrides: {
    connect?: typeof connectRemoteRuntimeHost;
    connectPeer?: typeof connectPeerRuntimeHost;
    waitForReady?: typeof waitForRuntimeHostReady;
    openSshTunnel?: typeof openRuntimeHostSshTunnel;
    activateSshOperator?: typeof activateRuntimeHostSshOperator;
    connectWsl?: typeof connectRuntimeHostWslEnvironment;
    wslProcessFactory?: RuntimeHostWslProcessFactory;
    wslExecutable?: string;
  } = {},
): Promise<RuntimeHostConnection> {
  if (input.profile.kind === 'environment') {
    return (overrides.connectWsl ?? connectRuntimeHostWslEnvironment)(
      {
        distribution: input.profile.provider.distribution,
        operatorPath: input.profile.operatorPath,
        rootId: input.profile.rootId,
        clientInstanceId: input.clientInstanceId,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.handshakeTimeoutMs === undefined
          ? {}
          : { handshakeTimeoutMs: input.handshakeTimeoutMs }),
        ...(input.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: input.readyTimeoutMs }),
      },
      {
        ...(overrides.waitForReady ? { waitForReady: overrides.waitForReady } : {}),
        ...(overrides.wslProcessFactory ? { processFactory: overrides.wslProcessFactory } : {}),
        ...(overrides.wslExecutable ? { wslExecutable: overrides.wslExecutable } : {}),
      },
    );
  }
  if (!input.credential) {
    throw new RuntimeHostPermanentReconnectError(
      `Runtime Host profile ${input.profile.id} has no access credential`,
    );
  }
  return connectRemoteRuntimeHostProfile(
    { ...input, profile: input.profile, credential: input.credential },
    overrides,
  );
}

export async function connectRemoteRuntimeHostProfile(
  input: {
    readonly profile: RemoteRuntimeHostProfile;
    readonly credential: string;
    readonly clientInstanceId: string;
    readonly signal?: AbortSignal;
    readonly connectTimeoutMs?: number;
    readonly handshakeTimeoutMs?: number;
    readonly readyTimeoutMs?: number;
    readonly sshInteraction?: RuntimeHostSshInteraction;
    readonly peerClient?: RuntimeHostPeerClient;
  },
  overrides: {
    connect?: typeof connectRemoteRuntimeHost;
    connectPeer?: typeof connectPeerRuntimeHost;
    waitForReady?: typeof waitForRuntimeHostReady;
    openSshTunnel?: typeof openRuntimeHostSshTunnel;
    activateSshOperator?: typeof activateRuntimeHostSshOperator;
  } = {},
): Promise<RuntimeHostConnection> {
  input.signal?.throwIfAborted();
  const transport = input.profile.transport;
  let connection: RuntimeHostConnection;
  if (transport.kind === 'libp2p-direct') {
    connection = await (overrides.connectPeer ?? connectPeerRuntimeHost)({
      profileId: input.profile.id,
      transport,
      credential: input.credential,
      expectedRootId: input.profile.rootId,
      clientInstanceId: input.clientInstanceId,
      peerClient: requireRuntimeHostPeerClient(input.peerClient),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(input.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: input.connectTimeoutMs }),
      ...(input.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: input.handshakeTimeoutMs }),
    });
  } else {
    const activation =
      transport.kind === 'ssh' && transport.activation
        ? await (overrides.activateSshOperator ?? activateRuntimeHostSshOperator)({
            destination: transport.destination,
            ...(transport.sshPort === undefined ? {} : { sshPort: transport.sshPort }),
            operatorPath: transport.activation.operatorPath,
            rootId: input.profile.rootId,
            interaction: input.sshInteraction ?? 'batch',
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          })
        : undefined;
    const sshEndpoint =
      transport.kind === 'ssh'
        ? (activation?.endpoint ?? requireConnectOnlySshEndpoint(transport))
        : undefined;
    const tunnel =
      transport.kind === 'ssh'
        ? await (overrides.openSshTunnel ?? openRuntimeHostSshTunnel)({
            destination: transport.destination,
            ...(transport.sshPort === undefined ? {} : { sshPort: transport.sshPort }),
            remotePort: sshEndpoint!.port,
            websocketPath: sshEndpoint!.websocketPath,
            interaction: input.sshInteraction ?? 'batch',
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          })
        : undefined;
    const connected = await (overrides.connect ?? connectRemoteRuntimeHost)({
      url: transport.kind === 'ssh' ? tunnel!.url : transport.url,
      ...(transport.kind === 'plaintext' ? { allowInsecureRemote: true } : {}),
      ...(tunnel ? { connectionResource: tunnel.resource } : {}),
      credential: input.credential,
      expectedRootId: input.profile.rootId,
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
      clientInstanceId: input.clientInstanceId,
      ...(input.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: input.connectTimeoutMs }),
      ...(input.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: input.handshakeTimeoutMs }),
    });
    try {
      input.signal?.throwIfAborted();
    } catch (error) {
      if (connected.kind === 'connected') {
        await connected.connection.close().catch(() => undefined);
      }
      throw error;
    }
    if (connected.kind === 'incompatible') {
      throw new RuntimeHostRemoteCompatibilityError(input.profile.id, connected.handshake);
    }
    if (connected.kind !== 'connected') {
      if (connected.kind === 'draining') {
        throw new Error(`Runtime Host profile ${input.profile.id} is draining`);
      }
      throw remoteRuntimeHostUnavailableError(
        `Runtime Host profile ${input.profile.id}`,
        connected.reason,
      );
    }
    connection = connected.connection;
  }
  try {
    input.signal?.throwIfAborted();
    await (overrides.waitForReady ?? waitForRuntimeHostReady)(
      connection,
      input.readyTimeoutMs ?? 45_000,
      input.signal,
    );
    return connection;
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error;
  }
}

function requireConnectOnlySshEndpoint(
  transport: Extract<RuntimeHostRemoteTransport, { kind: 'ssh' }>,
): {
  readonly port: number;
  readonly websocketPath: string;
} {
  if (transport.remotePort === undefined || transport.websocketPath === undefined) {
    throw new Error('SSH activation did not return a Runtime Host endpoint');
  }
  return { port: transport.remotePort, websocketPath: transport.websocketPath };
}

export async function connectPeerRuntimeHost(input: {
  readonly profileId: string;
  readonly transport: Extract<RuntimeHostRemoteTransport, { kind: 'libp2p-direct' }>;
  readonly credential: string;
  readonly expectedRootId: string;
  readonly clientInstanceId: string;
  readonly peerClient: RuntimeHostPeerClient;
  readonly signal?: AbortSignal;
  readonly connectTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
}): Promise<RuntimeHostConnection> {
  input.signal?.throwIfAborted();
  const stream = await input.peerClient.connect(
    {
      peerId: input.transport.peerId,
      routeHints: input.transport.routeHints,
      coordinationRelays: input.transport.coordinationRelays,
      directDeadlineMs: Math.min(input.connectTimeoutMs ?? 40_000, 120_000),
    },
    input.signal,
  );
  const abort = () => stream.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  if (input.signal?.aborted) abort();
  let transferred = false;
  try {
    input.signal?.throwIfAborted();
    await writeRuntimeHostPeerAuthentication(stream, input.credential);
    const authentication = await readRuntimeHostPeerAuthenticationResult(
      stream,
      input.handshakeTimeoutMs,
    );
    if (!authentication.accepted) {
      throw new RuntimeHostPermanentReconnectError(
        `Runtime Host profile ${input.profileId} rejected its access credential`,
      );
    }
    const result = await connectRuntimeHostMessageTransport({
      transport: new FramedByteStreamTransport(
        new RuntimeHostPeerByteStream(stream, authentication.remainder),
      ),
      expectedRootId: input.expectedRootId,
      compositionId: INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
      protocol: {
        min: RUNTIME_HOST_PROTOCOL_VERSION,
        max: RUNTIME_HOST_PROTOCOL_VERSION,
      },
      clientInstanceId: input.clientInstanceId,
      ...(input.handshakeTimeoutMs === undefined
        ? {}
        : { handshakeTimeoutMs: input.handshakeTimeoutMs }),
    });
    input.signal?.throwIfAborted();
    if (result.kind === 'incompatible') {
      throw new RuntimeHostRemoteCompatibilityError(input.profileId, result.handshake);
    }
    if (result.kind === 'draining') throw new Error('Runtime Host direct peer is draining');
    if (result.kind === 'unavailable') {
      throw remoteRuntimeHostUnavailableError('Runtime Host direct peer', result.reason);
    }
    transferred = true;
    return result.connection;
  } finally {
    input.signal?.removeEventListener('abort', abort);
    if (!transferred) stream.abort();
  }
}

function requireRuntimeHostPeerClient(
  peerClient: RuntimeHostPeerClient | undefined,
): RuntimeHostPeerClient {
  if (peerClient) return peerClient;
  throw new RuntimeHostPeerError(
    'peer_native_unavailable',
    'Experimental direct peer requires a Client peer endpoint owner',
  );
}

export function remoteRuntimeHostUnavailableError(
  subject: string,
  reason: Extract<ConnectRemoteRuntimeHostResult, { kind: 'unavailable' }>['reason'],
): Error {
  let message: string;
  switch (reason) {
    case 'authentication_failed':
      return new RuntimeHostPermanentReconnectError(`${subject} rejected its access credential`);
    case 'root_mismatch':
      return new RuntimeHostPermanentReconnectError(
        `${subject} connected to an unexpected State Root`,
      );
    case 'composition_mismatch':
      return new RuntimeHostPermanentReconnectError(
        `${subject} has an incompatible Host composition`,
      );
    case 'tls_failed':
      message = `${subject} could not verify the TLS connection`;
      break;
    case 'unreachable':
      message = `${subject} could not reach its endpoint`;
      break;
    default:
      message = `${subject} is unavailable (${reason})`;
  }
  return new Error(message);
}

export function decodeRuntimeHostProfileDocument(value: unknown): RuntimeHostProfileDocument {
  const record = requireExactRecord(value, 'Runtime Host profile document', [
    'schemaVersion',
    'profiles',
  ]);
  if (record.schemaVersion !== 1 && record.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new Error('Runtime Host profile document has an unsupported schema');
  }
  if (!Array.isArray(record.profiles) || record.profiles.length > PROFILE_COUNT_MAX) {
    throw new Error('Runtime Host profile document has an invalid profile list');
  }
  const profiles = record.profiles.map(decodePersistedRuntimeHostProfile);
  if (
    record.schemaVersion === 1 &&
    profiles.some(
      (profile) =>
        profile.kind === 'environment' ||
        (profile.transport.kind === 'ssh' && profile.transport.activation !== undefined),
    )
  ) {
    throw new Error('Runtime Host profile schema 1 cannot contain activation');
  }
  const ids = new Set<string>();
  for (const profile of profiles) {
    if (ids.has(profile.id)) throw new Error(`Duplicate Runtime Host profile: ${profile.id}`);
    ids.add(profile.id);
  }
  return Object.freeze({
    schemaVersion: PROFILE_SCHEMA_VERSION,
    profiles: Object.freeze(profiles),
  });
}

class FileRuntimeHostProfileCatalog implements RuntimeHostProfileCatalog {
  #operation = Promise.resolve();

  constructor(
    private readonly path: string,
    private readonly credentials: RuntimeHostProfileCredentialStore,
  ) {}

  async read(): Promise<RuntimeHostProfileDocument> {
    return this.#readSnapshot();
  }

  async #readSnapshot(): Promise<RuntimeHostProfileDocument> {
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return emptyProfileDocument();
      }
      throw error;
    }
    if (bytes.length > PROFILE_DOCUMENT_MAX_BYTES) {
      throw new Error('Runtime Host profile document exceeds its size limit');
    }
    try {
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      return decodeRuntimeHostProfileDocument(value);
    } catch (error) {
      throw new Error('Runtime Host profile document is invalid', { cause: error });
    }
  }

  async resolve(profileId?: string): Promise<ResolvedRuntimeHostProfile> {
    if (profileId === undefined || profileId === LOCAL_RUNTIME_HOST_PROFILE.id) {
      return { profile: LOCAL_RUNTIME_HOST_PROFILE };
    }
    const id = requireProfileId(profileId);
    const document = await this.read();
    const profile = document.profiles.find((candidate) => candidate.id === id);
    if (!profile) {
      throw new RuntimeHostPermanentReconnectError(`Unknown Runtime Host profile: ${id}`);
    }
    if (profile.kind === 'environment') return { profile };
    const credential = await this.credentials.get(profile);
    if (!credential) {
      throw new RuntimeHostPermanentReconnectError(
        `Runtime Host profile ${profile.id} has no access credential`,
      );
    }
    return { profile, credential };
  }

  save(
    value: PersistedRuntimeHostProfile,
    suppliedCredential?: string,
  ): Promise<RuntimeHostProfileDocument> {
    return this.#save(value, suppliedCredential, false);
  }

  create(
    value: PersistedRuntimeHostProfile,
    suppliedCredential?: string,
  ): Promise<RuntimeHostProfileDocument> {
    return this.#save(value, suppliedCredential, true);
  }

  #save(
    value: PersistedRuntimeHostProfile,
    suppliedCredential: string | undefined,
    requireNew: boolean,
  ): Promise<RuntimeHostProfileDocument> {
    const profile = decodePersistedRuntimeHostProfile(value);
    return this.#exclusive(async () => {
      const current = await this.#readSnapshot();
      const previousProfile = current.profiles.find((candidate) => candidate.id === profile.id);
      if (requireNew && previousProfile) {
        throw new Error('A new Runtime Host profile must use a new profile id');
      }
      const targetChanged = previousProfile
        ? profileTargetBinding(previousProfile) !== profileTargetBinding(profile)
        : false;
      if (targetChanged) {
        throw new Error('A Runtime Host profile target cannot be changed; create a new profile id');
      }
      if (profile.kind === 'environment' && suppliedCredential !== undefined) {
        throw new Error('A WSL Runtime Host environment does not accept an access credential');
      }
      const previousCredential =
        previousProfile?.kind === 'remote' ? await this.credentials.get(previousProfile) : null;
      if (
        profile.kind === 'remote' &&
        suppliedCredential === undefined &&
        (!previousProfile || !previousCredential)
      ) {
        throw new Error('A remote Runtime Host access credential is required');
      }
      const next = decodeRuntimeHostProfileDocument({
        schemaVersion: PROFILE_SCHEMA_VERSION,
        profiles: previousProfile
          ? current.profiles.map((candidate) => (candidate.id === profile.id ? profile : candidate))
          : [...current.profiles, profile],
      });
      if (profile.kind === 'remote' && suppliedCredential !== undefined) {
        await this.credentials.set(profile, suppliedCredential);
      }
      try {
        await writeProfileDocument(this.path, next);
      } catch (error) {
        if (profile.kind === 'remote' && suppliedCredential !== undefined) {
          try {
            await restoreCredential(
              this.credentials,
              previousProfile?.kind === 'remote' ? previousProfile : profile,
              previousCredential,
            );
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              'Runtime Host profile credential update failed and the profile could not be restored',
            );
          }
        }
        throw error;
      }
      return next;
    });
  }

  remove(profileId: string): Promise<RuntimeHostProfileDocument> {
    if (profileId === LOCAL_RUNTIME_HOST_PROFILE.id) {
      return Promise.reject(new Error('The built-in local Runtime Host profile cannot be removed'));
    }
    const id = requireProfileId(profileId);
    return this.#exclusive(async () => {
      const current = await this.#readSnapshot();
      const profile = current.profiles.find((candidate) => candidate.id === id);
      if (!profile) return current;
      return this.#removeProfile(current, profile);
    });
  }

  removeIfCurrent(target: ResolvedRuntimeHostProfile): Promise<{
    readonly removed: boolean;
    readonly document: RuntimeHostProfileDocument;
  }> {
    if (target.profile.kind === 'local') {
      return Promise.reject(new Error('Expected a resolved persisted Runtime Host profile'));
    }
    const expectedProfile = decodePersistedRuntimeHostProfile(target.profile);
    return this.#exclusive(async () => {
      const current = await this.#readSnapshot();
      const profile = current.profiles.find((candidate) => candidate.id === expectedProfile.id);
      if (
        !profile ||
        !samePersistedRuntimeHostProfile(profile, expectedProfile) ||
        (profile.kind === 'remote' &&
          (target.credential === undefined ||
            (await this.credentials.get(profile)) !== target.credential))
      ) {
        return { removed: false, document: current };
      }
      return { removed: true, document: await this.#removeProfile(current, profile) };
    });
  }

  rebindIfCurrent(
    target: ResolvedRuntimeHostProfile,
    value: RemoteRuntimeHostProfile,
    credential: string,
  ): Promise<{
    readonly rebound: boolean;
    readonly document: RuntimeHostProfileDocument;
  }> {
    if (target.profile.kind !== 'remote' || target.credential === undefined) {
      return Promise.reject(new Error('Expected a resolved remote Runtime Host profile'));
    }
    const expectedProfile = decodeRemoteRuntimeHostProfile(target.profile);
    const profile = decodeRemoteRuntimeHostProfile(value);
    if (
      profile.id !== expectedProfile.id ||
      !sameRemoteRuntimeHostProfileTarget(profile, expectedProfile)
    ) {
      return Promise.reject(new Error('A Runtime Host profile rebind must retain its connection'));
    }
    return this.#exclusive(async () => {
      const current = await this.#readSnapshot();
      const stored = current.profiles.find((candidate) => candidate.id === expectedProfile.id);
      if (
        !stored ||
        stored.kind !== 'remote' ||
        !sameRemoteRuntimeHostProfile(stored, expectedProfile) ||
        (await this.credentials.get(stored)) !== target.credential
      ) {
        return { rebound: false, document: current };
      }
      const next = decodeRuntimeHostProfileDocument({
        schemaVersion: PROFILE_SCHEMA_VERSION,
        profiles: current.profiles.map((candidate) =>
          candidate.id === profile.id ? profile : candidate,
        ),
      });
      await this.credentials.set(profile, credential);
      try {
        await writeProfileDocument(this.path, next);
      } catch (error) {
        await restoreCredential(this.credentials, profile, target.credential).catch(
          (rollbackError) => {
            throw new AggregateError(
              [error, rollbackError],
              'Runtime Host profile rebind failed and its credential could not be restored',
            );
          },
        );
        throw error;
      }
      return { rebound: true, document: next };
    });
  }

  async #removeProfile(
    current: RuntimeHostProfileDocument,
    profile: PersistedRuntimeHostProfile,
  ): Promise<RuntimeHostProfileDocument> {
    const next = decodeRuntimeHostProfileDocument({
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profiles: current.profiles.filter((candidate) => candidate.id !== profile.id),
    });
    await writeProfileDocument(this.path, next);
    if (profile.kind === 'environment') return next;
    try {
      await this.credentials.delete(profile);
    } catch (error) {
      try {
        await writeProfileDocument(this.path, current);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Runtime Host profile credential removal failed and the profile could not be restored',
        );
      }
      throw error;
    }
    return next;
  }

  #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#operation.then(async () => {
      await prepareProfileDirectory(this.path);
      return withFileUpdateLock(this.path, operation);
    });
    this.#operation = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }
}

export function decodePersistedRuntimeHostProfile(value: unknown): PersistedRuntimeHostProfile {
  return requireRecord(value, 'Runtime Host profile').kind === 'environment'
    ? decodeEnvironmentRuntimeHostProfile(value)
    : decodeRemoteRuntimeHostProfile(value);
}

export function decodeEnvironmentRuntimeHostProfile(value: unknown): EnvironmentRuntimeHostProfile {
  const record = requireExactRecord(value, 'WSL Runtime Host environment profile', [
    'id',
    'name',
    'kind',
    'provider',
    'rootId',
    'operatorPath',
  ]);
  if (record.kind !== 'environment') {
    throw new Error('Runtime Host environment profile kind must be environment');
  }
  const provider = requireExactRecord(record.provider, 'WSL Runtime Host environment provider', [
    'kind',
    'distribution',
  ]);
  if (provider.kind !== 'wsl') throw new Error('Runtime Host environment provider must be WSL');
  return Object.freeze({
    id: requireProfileId(record.id),
    name: requireProfileName(record.name),
    kind: 'environment',
    provider: Object.freeze({
      kind: 'wsl',
      distribution: normalizeRuntimeHostWslDistribution(
        requireString(provider.distribution, 'WSL distribution'),
      ),
    }),
    rootId: requireHostRootId(record.rootId),
    operatorPath: normalizeRuntimeHostWslOperatorPath(
      requireString(record.operatorPath, 'WSL operator path'),
    ),
  });
}

export function decodeRemoteRuntimeHostProfile(value: unknown): RemoteRuntimeHostProfile {
  const record = requireExactRecord(value, 'Remote Runtime Host profile', [
    'id',
    'name',
    'kind',
    'transport',
    'rootId',
  ]);
  if (record.kind !== 'remote') throw new Error('Runtime Host profile kind must be remote');
  return Object.freeze({
    id: requireProfileId(record.id),
    name: requireProfileName(record.name),
    kind: 'remote',
    transport: decodeRuntimeHostRemoteTransport(record.transport),
    rootId: requireHostRootId(record.rootId),
  });
}

export function decodeRuntimeHostRemoteTransport(value: unknown): RuntimeHostRemoteTransport {
  const kind = requireRecord(value, 'Runtime Host transport').kind;
  if (kind === 'tls') {
    const record = requireExactRecord(value, 'Runtime Host TLS transport', ['kind', 'url']);
    const rawUrl = requireString(record.url, 'Runtime Host TLS URL');
    if (new URL(rawUrl).protocol !== 'wss:') {
      throw new Error('Runtime Host TLS URL must use wss');
    }
    const url = normalizeRemoteRuntimeHostUrl(rawUrl);
    return Object.freeze({ kind: 'tls', url: url.toString() });
  }
  if (kind === 'plaintext') {
    const record = requireExactRecord(value, 'Runtime Host plaintext transport', [
      'kind',
      'url',
      'acknowledgement',
    ]);
    if (record.acknowledgement !== RUNTIME_HOST_PLAINTEXT_ACKNOWLEDGEMENT) {
      throw new Error('Runtime Host plaintext transport requires explicit acknowledgement');
    }
    const rawUrl = requireString(record.url, 'Runtime Host plaintext URL');
    if (new URL(rawUrl).protocol !== 'ws:') {
      throw new Error('Runtime Host plaintext URL must use ws');
    }
    const url = normalizeRemoteRuntimeHostUrl(rawUrl, { allowInsecureRemote: true });
    return Object.freeze({
      kind: 'plaintext',
      url: url.toString(),
      acknowledgement: RUNTIME_HOST_PLAINTEXT_ACKNOWLEDGEMENT,
    });
  }
  if (kind === 'ssh') {
    const candidate = requireRecord(value, 'Runtime Host SSH transport');
    const activated = candidate.activation !== undefined;
    const record = activated
      ? requireExactRecord(
          value,
          'Runtime Host activated SSH transport',
          ['kind', 'destination', 'activation'],
          ['sshPort'],
        )
      : requireExactRecord(
          value,
          'Runtime Host connect-only SSH transport',
          ['kind', 'destination', 'remotePort', 'websocketPath'],
          ['sshPort'],
        );
    const destination = normalizeRuntimeHostSshDestination(
      requireString(record.destination, 'Runtime Host SSH destination'),
    );
    const sshPort = optionalPort(record.sshPort, 'Runtime Host SSH port');
    if (activated) {
      const activation = requireExactRecord(record.activation, 'Runtime Host SSH activation', [
        'kind',
        'operatorPath',
      ]);
      if (activation.kind !== 'ssh_operator') {
        throw new Error('Runtime Host SSH activation kind is invalid');
      }
      const operatorPath = requireOperatorPath(activation.operatorPath);
      return Object.freeze({
        kind: 'ssh',
        destination,
        ...(sshPort === undefined ? {} : { sshPort }),
        activation: Object.freeze({ kind: 'ssh_operator', operatorPath }),
      });
    }
    const remotePort = requirePort(record.remotePort, 'Runtime Host SSH remote port');
    const websocketPath = requireWebSocketPath(record.websocketPath);
    return Object.freeze({
      kind: 'ssh',
      destination,
      ...(sshPort === undefined ? {} : { sshPort }),
      remotePort,
      websocketPath,
    });
  }
  if (kind === 'libp2p-direct') {
    const record = requireExactRecord(value, 'Runtime Host direct peer transport', [
      'kind',
      'peerId',
      'routeHints',
      'coordinationRelays',
    ]);
    const peerId = requireBoundedToken(record.peerId, 'Runtime Host peer id', PEER_ID_MAX_BYTES);
    const routeHints = requirePeerAddresses(record.routeHints, 'Runtime Host peer route hints');
    const coordinationRelays = requirePeerAddresses(
      record.coordinationRelays,
      'Runtime Host coordination relays',
    );
    if (routeHints.length === 0 && coordinationRelays.length === 0) {
      throw new Error('Runtime Host direct peer transport requires at least one route');
    }
    return Object.freeze({
      kind: 'libp2p-direct',
      peerId,
      routeHints,
      coordinationRelays,
    });
  }
  throw new Error('Runtime Host transport kind is invalid');
}

function requireProfileId(value: unknown): string {
  const id = requireString(value, 'Runtime Host profile id');
  if (!PROFILE_ID_PATTERN.test(id) || id === LOCAL_RUNTIME_HOST_PROFILE.id) {
    throw new Error('Runtime Host profile id is invalid or reserved');
  }
  return id;
}

function profileCredentialSlot(profile: RemoteRuntimeHostProfile): string {
  return `runtime-host-profile:${requireProfileId(profile.id)}:${profileCredentialBinding(profile)}`;
}

function profileTargetBinding(profile: PersistedRuntimeHostProfile): string {
  if (profile.kind === 'remote') return `remote\0${profileCredentialBinding(profile)}`;
  const normalized = decodeEnvironmentRuntimeHostProfile(profile);
  return [
    'environment',
    normalized.provider.kind,
    normalized.provider.distribution,
    normalized.operatorPath,
    normalized.rootId,
  ].join('\0');
}

function profileCredentialBinding(profile: RemoteRuntimeHostProfile): string {
  const normalized = decodeRemoteRuntimeHostProfile(profile);
  return createHash('sha256')
    .update(normalized.transport.kind)
    .update('\0')
    .update(transportCredentialBinding(normalized.transport))
    .update('\0')
    .update(normalized.rootId)
    .digest('hex');
}

function transportCredentialBinding(transport: RuntimeHostRemoteTransport): string {
  switch (transport.kind) {
    case 'tls':
      return transport.url;
    case 'plaintext':
      return `${transport.url}\0${transport.acknowledgement}`;
    case 'ssh':
      return transport.activation
        ? `${transport.destination}\0${transport.sshPort ?? ''}\0activate\0${transport.activation.operatorPath}`
        : `${transport.destination}\0${transport.sshPort ?? ''}\0${transport.remotePort}\0${transport.websocketPath}`;
    case 'libp2p-direct':
      return transport.peerId;
  }
}

function requirePeerAddresses(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length > PEER_ROUTE_MAX) {
    throw new Error(`${label} must be an array with at most ${PEER_ROUTE_MAX} entries`);
  }
  const addresses = value.map((entry) => {
    const address = requireString(entry, label);
    if (
      !address.startsWith('/') ||
      Buffer.byteLength(address, 'utf8') > PEER_ADDRESS_MAX_BYTES ||
      /[\s\u0000-\u001f\u007f]/u.test(address)
    ) {
      throw new Error(`${label} contains an invalid multiaddr`);
    }
    return address;
  });
  if (new Set(addresses).size !== addresses.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return Object.freeze(addresses);
}

function requireBoundedToken(value: unknown, label: string, maxBytes: number): string {
  const token = requireString(value, label);
  if (
    token.length === 0 ||
    Buffer.byteLength(token, 'utf8') > maxBytes ||
    /[\s\u0000-\u001f\u007f]/u.test(token)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return token;
}

function sameRemoteRuntimeHostProfile(
  left: RemoteRuntimeHostProfile,
  right: RemoteRuntimeHostProfile,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    profileCredentialBinding(left) === profileCredentialBinding(right)
  );
}

function samePersistedRuntimeHostProfile(
  left: PersistedRuntimeHostProfile,
  right: PersistedRuntimeHostProfile,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    profileTargetBinding(left) === profileTargetBinding(right)
  );
}

function restoreCredential(
  credentials: RuntimeHostProfileCredentialStore,
  profile: RemoteRuntimeHostProfile,
  previousCredential: string | null,
): Promise<void> {
  return previousCredential === null
    ? credentials.delete(profile)
    : credentials.set(profile, previousCredential);
}

function requireProfileName(value: unknown): string {
  const name = requireString(value, 'Runtime Host profile name').trim();
  if (
    name.length === 0 ||
    Buffer.byteLength(name, 'utf8') > PROFILE_NAME_MAX_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new Error('Runtime Host profile name is invalid');
  }
  return name;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function optionalPort(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requirePort(value, label);
}

function requirePort(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${label} must be an integer between 1 and 65535`);
  }
  return value;
}

function requireWebSocketPath(value: unknown): string {
  const path = requireString(value, 'Runtime Host SSH WebSocket path');
  if (!isCanonicalRuntimeHostWebSocketPath(path)) {
    throw new Error('Runtime Host SSH WebSocket path must be a canonical absolute URL path');
  }
  return path;
}

function requireOperatorPath(value: unknown): string {
  const path = requireString(value, 'Runtime Host SSH operator path');
  if (
    !posix.isAbsolute(path) ||
    Buffer.byteLength(path, 'utf8') > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(path)
  ) {
    throw new Error('Runtime Host SSH operator path must be an absolute POSIX path');
  }
  return posix.normalize(path);
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireExactRecord(
  value: unknown,
  label: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const expected = new Set([...requiredKeys, ...optionalKeys]);
  if (Object.keys(record).some((key) => !expected.has(key))) {
    throw new Error(`${label} contains unknown fields`);
  }
  if (requiredKeys.some((key) => !Object.hasOwn(record, key))) {
    throw new Error(`${label} is missing required fields`);
  }
  return record;
}

function emptyProfileDocument(): RuntimeHostProfileDocument {
  return Object.freeze({ schemaVersion: PROFILE_SCHEMA_VERSION, profiles: Object.freeze([]) });
}

async function writeProfileDocument(
  path: string,
  document: RuntimeHostProfileDocument,
): Promise<void> {
  const schemaVersion = document.profiles.some(
    (profile) =>
      profile.kind === 'environment' ||
      (profile.transport.kind === 'ssh' && profile.transport.activation !== undefined),
  )
    ? PROFILE_SCHEMA_VERSION
    : 1;
  const encoded = `${JSON.stringify({ ...document, schemaVersion }, null, 2)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > PROFILE_DOCUMENT_MAX_BYTES) {
    throw new Error('Runtime Host profile document exceeds its size limit');
  }
  const directory = dirname(path);
  const temporaryPath = join(directory, `.runtime-host-profiles-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    try {
      await handle.writeFile(encoded, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

async function prepareProfileDirectory(path: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
}
