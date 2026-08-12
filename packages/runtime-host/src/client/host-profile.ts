import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createFileCredentialStore, type CredentialStore } from '@maka/storage';
import { withFileUpdateLock } from '@maka/storage/file-update-lock';
import {
  INTERACTIVE_RUNTIME_HOST_COMPOSITION_ID,
  RUNTIME_HOST_PROTOCOL_VERSION,
  requireHostRootId,
  type ClientSurface,
} from '../protocol/index.js';
import {
  connectRemoteRuntimeHost,
  normalizeRemoteRuntimeHostUrl,
  type ConnectRemoteRuntimeHostResult,
  type RuntimeHostConnection,
} from './connection.js';
import { RuntimeHostPermanentReconnectError } from './reconnect-lifecycle.js';
import { openRuntimeHostSshTunnel, type RuntimeHostSshInteraction } from './ssh-tunnel.js';
import { waitForRuntimeHostReady } from './wait-for-ready.js';

const PROFILE_SCHEMA_VERSION = 1;
const PROFILE_DOCUMENT_MAX_BYTES = 64 * 1024;
const PROFILE_COUNT_MAX = 32;
const PROFILE_NAME_MAX_BYTES = 128;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const RUNTIME_HOST_ACCESS_CREDENTIAL_MAX_BYTES = 8 * 1024;
export const RUNTIME_HOST_PLAINTEXT_ACKNOWLEDGEMENT = 'plaintext-bearer-v1' as const;

export const LOCAL_RUNTIME_HOST_PROFILE = Object.freeze({
  id: 'local',
  name: 'Local',
  kind: 'local',
} as const);

export type RuntimeHostProfile = typeof LOCAL_RUNTIME_HOST_PROFILE | RemoteRuntimeHostProfile;

export interface RemoteRuntimeHostProfile {
  readonly id: string;
  readonly name: string;
  readonly kind: 'remote';
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
    };

export interface RuntimeHostProfileDocument {
  readonly schemaVersion: typeof PROFILE_SCHEMA_VERSION;
  readonly profiles: readonly RemoteRuntimeHostProfile[];
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
  return (
    left.profile.id === right.profile.id &&
    profileCredentialBinding(left.profile) === profileCredentialBinding(right.profile) &&
    left.credential === right.credential
  );
}

export interface RuntimeHostProfileCatalog {
  read(): Promise<RuntimeHostProfileDocument>;
  resolve(profileId?: string): Promise<ResolvedRuntimeHostProfile>;
  create(
    profile: RemoteRuntimeHostProfile,
    credential: string,
  ): Promise<RuntimeHostProfileDocument>;
  save(profile: RemoteRuntimeHostProfile, credential?: string): Promise<RuntimeHostProfileDocument>;
  remove(profileId: string): Promise<RuntimeHostProfileDocument>;
  removeIfCurrent(target: ResolvedRuntimeHostProfile): Promise<{
    readonly removed: boolean;
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
): RuntimeHostProfileCatalog {
  return createFileRuntimeHostProfileCatalog(
    join(clientDataRoot, 'runtime-host-profiles.json'),
    createRuntimeHostProfileCredentialStore(
      createFileCredentialStore(join(clientDataRoot, 'runtime-host-client')),
    ),
  );
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

export async function connectRemoteRuntimeHostProfile(
  input: {
    readonly profile: RemoteRuntimeHostProfile;
    readonly credential: string;
    readonly surface: ClientSurface;
    readonly clientInstanceId: string;
    readonly signal?: AbortSignal;
    readonly connectTimeoutMs?: number;
    readonly handshakeTimeoutMs?: number;
    readonly readyTimeoutMs?: number;
    readonly sshInteraction?: RuntimeHostSshInteraction;
  },
  overrides: {
    connect?: typeof connectRemoteRuntimeHost;
    waitForReady?: typeof waitForRuntimeHostReady;
    openSshTunnel?: typeof openRuntimeHostSshTunnel;
  } = {},
): Promise<RuntimeHostConnection> {
  input.signal?.throwIfAborted();
  const transport = input.profile.transport;
  const tunnel =
    transport.kind === 'ssh'
      ? await (overrides.openSshTunnel ?? openRuntimeHostSshTunnel)({
          destination: transport.destination,
          ...(transport.sshPort === undefined ? {} : { sshPort: transport.sshPort }),
          remotePort: transport.remotePort,
          websocketPath: transport.websocketPath,
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
    surface: input.surface,
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
    throw new RuntimeHostPermanentReconnectError(
      `Runtime Host profile ${input.profile.id} is incompatible with this Maka Client`,
    );
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
  try {
    input.signal?.throwIfAborted();
    await (overrides.waitForReady ?? waitForRuntimeHostReady)(
      connected.connection,
      input.readyTimeoutMs ?? 45_000,
      input.signal,
    );
    return connected.connection;
  } catch (error) {
    await connected.connection.close().catch(() => undefined);
    throw error;
  }
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
  if (record.schemaVersion !== PROFILE_SCHEMA_VERSION) {
    throw new Error('Runtime Host profile document has an unsupported schema');
  }
  if (!Array.isArray(record.profiles) || record.profiles.length > PROFILE_COUNT_MAX) {
    throw new Error('Runtime Host profile document has an invalid profile list');
  }
  const profiles = record.profiles.map(decodeRemoteRuntimeHostProfile);
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
    let bytes: Buffer;
    try {
      bytes = await readFile(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyProfileDocument();
      throw error;
    }
    if (bytes.length > PROFILE_DOCUMENT_MAX_BYTES) {
      throw new Error('Runtime Host profile document exceeds its size limit');
    }
    try {
      return decodeRuntimeHostProfileDocument(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      );
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
    const credential = await this.credentials.get(profile);
    if (!credential) {
      throw new RuntimeHostPermanentReconnectError(
        `Runtime Host profile ${profile.id} has no access credential`,
      );
    }
    return { profile, credential };
  }

  save(
    value: RemoteRuntimeHostProfile,
    suppliedCredential?: string,
  ): Promise<RuntimeHostProfileDocument> {
    return this.#save(value, suppliedCredential, false);
  }

  create(
    value: RemoteRuntimeHostProfile,
    suppliedCredential: string,
  ): Promise<RuntimeHostProfileDocument> {
    return this.#save(value, suppliedCredential, true);
  }

  #save(
    value: RemoteRuntimeHostProfile,
    suppliedCredential: string | undefined,
    requireNew: boolean,
  ): Promise<RuntimeHostProfileDocument> {
    const profile = decodeRemoteRuntimeHostProfile(value);
    return this.#exclusive(async () => {
      const current = await this.read();
      const previousProfile = current.profiles.find((candidate) => candidate.id === profile.id);
      if (requireNew && previousProfile) {
        throw new Error('A new Runtime Host profile must use a new profile id');
      }
      const targetChanged = previousProfile
        ? profileCredentialBinding(previousProfile) !== profileCredentialBinding(profile)
        : false;
      if (targetChanged) {
        throw new Error('A Runtime Host profile target cannot be changed; create a new profile id');
      }
      const previousCredential = previousProfile
        ? await this.credentials.get(previousProfile)
        : null;
      if (suppliedCredential === undefined && (!previousProfile || !previousCredential)) {
        throw new Error('A Runtime Host access credential is required');
      }
      const next = decodeRuntimeHostProfileDocument({
        schemaVersion: PROFILE_SCHEMA_VERSION,
        profiles: previousProfile
          ? current.profiles.map((candidate) => (candidate.id === profile.id ? profile : candidate))
          : [...current.profiles, profile],
      });
      if (suppliedCredential !== undefined) {
        await this.credentials.set(profile, suppliedCredential);
      }
      try {
        await writeProfileDocument(this.path, next);
      } catch (error) {
        if (suppliedCredential !== undefined) {
          try {
            await restoreCredential(
              this.credentials,
              previousProfile ?? profile,
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
      const current = await this.read();
      const profile = current.profiles.find((candidate) => candidate.id === id);
      if (!profile) return current;
      return this.#removeProfile(current, profile);
    });
  }

  removeIfCurrent(target: ResolvedRuntimeHostProfile): Promise<{
    readonly removed: boolean;
    readonly document: RuntimeHostProfileDocument;
  }> {
    if (target.profile.kind !== 'remote' || target.credential === undefined) {
      return Promise.reject(new Error('Expected a resolved remote Runtime Host profile'));
    }
    const expectedProfile = decodeRemoteRuntimeHostProfile(target.profile);
    return this.#exclusive(async () => {
      const current = await this.read();
      const profile = current.profiles.find((candidate) => candidate.id === expectedProfile.id);
      if (
        !profile ||
        !sameRemoteRuntimeHostProfile(profile, expectedProfile) ||
        (await this.credentials.get(profile)) !== target.credential
      ) {
        return { removed: false, document: current };
      }
      return { removed: true, document: await this.#removeProfile(current, profile) };
    });
  }

  async #removeProfile(
    current: RuntimeHostProfileDocument,
    profile: RemoteRuntimeHostProfile,
  ): Promise<RuntimeHostProfileDocument> {
    const next = decodeRuntimeHostProfileDocument({
      schemaVersion: PROFILE_SCHEMA_VERSION,
      profiles: current.profiles.filter((candidate) => candidate.id !== profile.id),
    });
    await writeProfileDocument(this.path, next);
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

function decodeRemoteRuntimeHostProfile(value: unknown): RemoteRuntimeHostProfile {
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

function decodeRuntimeHostRemoteTransport(value: unknown): RuntimeHostRemoteTransport {
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
    const record = requireExactRecord(
      value,
      'Runtime Host SSH transport',
      ['kind', 'destination', 'remotePort', 'websocketPath'],
      ['sshPort'],
    );
    const destination = requireSshDestination(record.destination);
    const sshPort = optionalPort(record.sshPort, 'Runtime Host SSH port');
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
      return `${transport.destination}\0${transport.sshPort ?? ''}\0${transport.remotePort}\0${transport.websocketPath}`;
  }
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

function requireSshDestination(value: unknown): string {
  const destination = requireString(value, 'Runtime Host SSH destination').trim();
  if (
    destination.length === 0 ||
    destination.length > 512 ||
    destination.startsWith('-') ||
    /\s|[\u0000-\u001f\u007f]/u.test(destination)
  ) {
    throw new Error('Runtime Host SSH destination is invalid');
  }
  return destination;
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
  if (!path.startsWith('/') || path.includes('?') || path.includes('#')) {
    throw new Error('Runtime Host SSH WebSocket path must be an absolute URL path');
  }
  return path;
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
  const encoded = `${JSON.stringify(document, null, 2)}\n`;
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
