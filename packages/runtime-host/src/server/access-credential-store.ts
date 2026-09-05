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
import { chmod, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  type AccessCredentialPrincipalKind,
  type ClientCapabilityOwnerIdentity,
  HOST_OPERATION_SPECS,
  operationAllowsRemoteOwner,
  type SessionCollaborationGrant,
  decodeSessionTurnAccessRequest,
  type SessionTurnAccessRequest,
  type OperationKey,
} from '../protocol/index.js';

// Schema 4 makes provider ownership downgrade-safe once an association exists.
// Ordinary access files remain schema 3 so this feature does not fence a
// downgrade before there is an owner association to preserve.
const ACCESS_FILE_SCHEMA_VERSION = 4;
const PRE_CAPABILITY_OWNER_ACCESS_FILE_SCHEMA_VERSION = 3;
const ACCESS_FILE_MAX_BYTES = 512 * 1024;
// What a stored grant means to the current protocol. The access file is the
// Host's own record of what it already granted, written by a build that may be
// several releases old, and no peer is present to negotiate a version. An entry
// here is the only thing that rewrites that record: `replace` carries the
// stored authority to the operations that succeeded it, `release` drops it
// because nothing did. A stored grant naming no entry is kept verbatim — see
// `migratePersistedGrants`.
type PersistedGrantMigration =
  | {
      readonly kind: 'replace';
      // Non-empty by construction: a migration that names no successor is a
      // release, and has to say so.
      readonly successors: readonly [OperationKey, ...OperationKey[]];
    }
  | { readonly kind: 'release' };

const PERSISTED_GRANT_MIGRATIONS: ReadonlyMap<string, PersistedGrantMigration> = new Map<
  string,
  PersistedGrantMigration
>([
  // The transcript query split into paging and its overlay release.
  [
    'session.transcript.query',
    {
      kind: 'replace',
      successors: ['session.transcript.page', 'session.transcript.overlay.release'],
    },
  ],
  // The Turn query kept its name and gained a separate landmark query beside it.
  [
    'session.turns.query',
    { kind: 'replace', successors: ['session.turns.query', 'session.turn_landmarks.query'] },
  ],
  // Resource inventory is a dedicated facet of the existing Host diagnostics authority.
  [
    'host.diagnostics.query',
    { kind: 'replace', successors: ['host.diagnostics.query', 'host.resources.query'] },
  ],
  // TaskLedger became SessionTodo; the query carried its authority over.
  ['task.ledger.query', { kind: 'replace', successors: ['session.todo.query'] }],
  // Retired with the Claude subscription provider, whose client identity the
  // usage report required.
  ['oauth.account.usage.fetch', { kind: 'release' }],
  // Retired with the second execution-inspection contract; no shipped surface
  // called execution.inspect.resolve.
  ['execution.inspect.resolve', { kind: 'release' }],
]);

export const ACCESS_FILE_NAME = 'runtime-host-access.json';

export const SESSION_GUEST_OPERATION_GRANTS = Object.freeze([
  'host.status',
  'artifact.query',
  'collaboration.turn-request.create',
  'collaboration.turn-request.acknowledge',
  'collaboration.turn-request.query',
  'collaboration.turn-request.withdraw',
  'runtime.resource.query',
  'session.shared.query',
  'subscription.open',
  'subscription.close',
  'session.transcript.page',
  'session.transcript.overlay.release',
] as const satisfies readonly OperationKey[]);

// A Client Capability provider serves exactly this much and nothing else. It
// sits beside the Session Guest list because both are principal policy that
// `effectiveOperationGrants` re-applies on every decode: what a principal may
// hold is decided by the running build, never by what its record happens to say.
export const CAPABILITY_PROVIDER_OPERATION_GRANTS = Object.freeze([
  'host.status',
  'client.capability.replace',
  'client.capability.unregister',
] as const satisfies readonly OperationKey[]);

export interface StoredAccessCredential {
  readonly credentialId: string;
  readonly credentialHash: string;
  readonly principalId: string;
  readonly principalKind: AccessCredentialPrincipalKind;
  readonly status: 'pending' | 'active' | 'revoked';
  // What this credential was granted, as the file records it. Kept verbatim
  // across versions the current build does not share a vocabulary with, so it
  // is a `string[]`, not an `OperationKey[]`. What the credential may actually
  // exercise is derived by `effectiveOperationGrants` and never written back.
  readonly grants: readonly string[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
  readonly capabilityOwner?: ClientCapabilityOwnerIdentity;
  readonly createdAt: string;
  readonly bindClientInstanceOnFinalize?: true;
  readonly clientInstanceId?: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string;
}

export interface AccessCredentialFile {
  readonly schemaVersion:
    | typeof PRE_CAPABILITY_OWNER_ACCESS_FILE_SCHEMA_VERSION
    | typeof ACCESS_FILE_SCHEMA_VERSION;
  readonly credentials: readonly StoredAccessCredential[];
  readonly sessionGrants: readonly SessionCollaborationGrant[];
  readonly turnAccessRequests: readonly SessionTurnAccessRequest[];
}

export class RuntimeHostAccessInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RuntimeHostAccessInputError';
  }
}

export class RuntimeHostAccessCapacityError extends Error {
  constructor() {
    super('Runtime Host access credential storage is full');
    this.name = 'RuntimeHostAccessCapacityError';
  }
}

export class RuntimeHostAccessCommitOutcomeUnknownError extends Error {
  constructor(cause: unknown) {
    super('Runtime Host access credential commit outcome is unknown', { cause });
    this.name = 'RuntimeHostAccessCommitOutcomeUnknownError';
  }
}

export function createAccessCredentialFile(
  credentials: readonly StoredAccessCredential[],
  sessionGrants: readonly SessionCollaborationGrant[] = [],
  turnAccessRequests: readonly SessionTurnAccessRequest[] = [],
): AccessCredentialFile {
  return {
    schemaVersion: credentials.some((credential) => credential.capabilityOwner !== undefined)
      ? ACCESS_FILE_SCHEMA_VERSION
      : PRE_CAPABILITY_OWNER_ACCESS_FILE_SCHEMA_VERSION,
    credentials,
    sessionGrants,
    turnAccessRequests,
  };
}

export function issuedAccessGrants(grants: readonly OperationKey[]): readonly OperationKey[] {
  return validateIssuedGrants([...new Set<OperationKey>(['host.status', ...grants])]);
}

// What the running build lets this credential exercise. Derived from the record
// on every decode and never persisted: a grant the current protocol does not
// define, or that the current policy for this principal no longer allows, is
// absent here while staying in the record. Dropping it from the record instead
// would make an unrelated later write erase it for good (#4420).
export function effectiveOperationGrants(
  credential: StoredAccessCredential,
): readonly OperationKey[] {
  // A Session Guest holds whatever the guest policy grants now. Its record was
  // never authoritative — issuance writes the policy list wholesale.
  if (credential.principalKind === 'session_guest') return SESSION_GUEST_OPERATION_GRANTS;
  const permitted =
    credential.principalKind === 'capability_provider'
      ? new Set<string>(CAPABILITY_PROVIDER_OPERATION_GRANTS)
      : undefined;
  return Object.freeze(
    credential.grants.filter(
      (grant): grant is OperationKey =>
        Object.hasOwn(HOST_OPERATION_SPECS, grant) &&
        operationAllowsRemoteOwner(grant as OperationKey) &&
        (permitted === undefined || permitted.has(grant)),
    ),
  );
}

// Stored grants this build can neither serve nor account for: absent from the
// protocol and named by no migration entry. A rename that ships without its
// entry leaves its old key here, which is what the released forward roll
// asserts against — the record survives, so the omission is recoverable, but it
// is still an omission.
export function unresolvedPersistedGrants(file: AccessCredentialFile): readonly string[] {
  const unresolved = new Set<string>();
  for (const credential of file.credentials) {
    for (const grant of credential.grants) {
      if (!Object.hasOwn(HOST_OPERATION_SPECS, grant)) unresolved.add(grant);
    }
  }
  return Object.freeze([...unresolved].sort());
}

export function assertAccessCredentialFileCapacity(file: AccessCredentialFile): void {
  const fullyRevoked = createAccessCredentialFile(
    file.credentials.map((credential) =>
      credential.status === 'revoked'
        ? credential
        : {
            ...credential,
            status: 'revoked',
            revokedAt: '9999-12-31T23:59:59.999Z',
          },
    ),
    file.sessionGrants,
    file.turnAccessRequests.map(reserveTurnAccessRequestCompletionCapacity),
  );
  serializeAccessCredentialFile(fullyRevoked);
}

function reserveTurnAccessRequestCompletionCapacity(
  request: SessionTurnAccessRequest,
): SessionTurnAccessRequest {
  if (request.state.kind !== 'pending' && request.state.kind !== 'approved') return request;
  if (request.state.kind === 'approved' && request.state.admission !== 'pending') return request;
  return {
    ...request,
    state: {
      kind: 'approved',
      decidedAt:
        request.state.kind === 'approved' ? request.state.decidedAt : '9999-12-31T23:59:59.999Z',
      decidedBy: request.state.kind === 'approved' ? request.state.decidedBy : 'x'.repeat(128),
      admission: 'failed',
    },
  };
}

export async function readAccessCredentialFile(path: string): Promise<AccessCredentialFile> {
  let handle: FileHandle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return createAccessCredentialFile([]);
    throw error;
  }
  let raw: Buffer;
  try {
    const buffer = Buffer.alloc(ACCESS_FILE_MAX_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, 0);
    if (bytesRead > ACCESS_FILE_MAX_BYTES) {
      throw new Error('Runtime Host access file is too large');
    }
    raw = buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
  return decodeAccessFile(JSON.parse(raw.toString('utf8')) as unknown);
}

export async function writeAccessCredentialFile(
  path: string,
  file: AccessCredentialFile,
): Promise<void> {
  const contents = serializeAccessCredentialFile(file);
  const tempPath = `${path}.${randomUUID()}.tmp`;
  let published = false;
  try {
    const handle = await open(tempPath, 'wx', 0o600);
    try {
      await handle.writeFile(contents, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.platform !== 'win32') await chmod(tempPath, 0o600);
    await rename(tempPath, path);
    published = true;
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(tempPath, { force: true });
    if (published) throw new RuntimeHostAccessCommitOutcomeUnknownError(error);
    throw error;
  }
}

// The on-disk shape, stated once. The record's field is `grants` in memory and
// `operationGrants` on disk, and only what this function names is written — so
// a field added to the runtime type cannot reach the file by accident, and the
// key an older build reads keeps its published name.
function encodeAccessCredentialFile(file: AccessCredentialFile): unknown {
  return {
    schemaVersion: file.schemaVersion,
    credentials: file.credentials.map((credential) => ({
      credentialId: credential.credentialId,
      credentialHash: credential.credentialHash,
      principalId: credential.principalId,
      principalKind: credential.principalKind,
      status: credential.status,
      operationGrants: credential.grants,
      canPublishClientCapabilities: credential.canPublishClientCapabilities,
      canUseHostPaths: credential.canUseHostPaths,
      ...(credential.capabilityOwner ? { capabilityOwner: credential.capabilityOwner } : {}),
      createdAt: credential.createdAt,
      ...(credential.bindClientInstanceOnFinalize === true
        ? { bindClientInstanceOnFinalize: true }
        : {}),
      ...(credential.clientInstanceId === undefined
        ? {}
        : { clientInstanceId: credential.clientInstanceId }),
      ...(credential.expiresAt === undefined ? {} : { expiresAt: credential.expiresAt }),
      ...(credential.revokedAt === undefined ? {} : { revokedAt: credential.revokedAt }),
    })),
    sessionGrants: file.sessionGrants,
    turnAccessRequests: file.turnAccessRequests,
  };
}

function serializeAccessCredentialFile(file: AccessCredentialFile): string {
  const contents = `${JSON.stringify(encodeAccessCredentialFile(file), null, 2)}\n`;
  if (Buffer.byteLength(contents) > ACCESS_FILE_MAX_BYTES) {
    throw new RuntimeHostAccessCapacityError();
  }
  return contents;
}

function decodeAccessFile(value: unknown): AccessCredentialFile {
  if (
    !isRecord(value) ||
    (value.schemaVersion !== 1 &&
      value.schemaVersion !== 2 &&
      value.schemaVersion !== 3 &&
      value.schemaVersion !== 4)
  ) {
    throw new Error('Unsupported Runtime Host access file');
  }
  if (!Array.isArray(value.credentials)) throw new Error('Invalid Runtime Host access file');
  const credentials = value.credentials.map(decodeStoredCredential);
  if (
    value.schemaVersion < ACCESS_FILE_SCHEMA_VERSION &&
    credentials.some((credential) => credential.capabilityOwner !== undefined)
  ) {
    throw new Error('Pre-association Runtime Host access files cannot declare capability owners');
  }
  if (
    new Set(credentials.map((credential) => credential.credentialId)).size !== credentials.length
  ) {
    throw new Error('Duplicate Runtime Host access credential identity');
  }
  const pendingPrincipals = credentials
    .filter((credential) => credential.status === 'pending')
    .map((credential) => `${credential.principalKind}:${credential.principalId}`);
  if (new Set(pendingPrincipals).size !== pendingPrincipals.length) {
    throw new Error('Duplicate Runtime Host pending credential principal');
  }
  const sessionGrants =
    value.schemaVersion === 1
      ? []
      : Array.isArray(value.sessionGrants)
        ? value.sessionGrants.map(decodeStoredSessionGrant)
        : (() => {
            throw new Error('Invalid Runtime Host access grants');
          })();
  if (new Set(sessionGrants.map((grant) => grant.grantId)).size !== sessionGrants.length) {
    throw new Error('Duplicate Runtime Host Session grant identity');
  }
  const sessionByGuest = new Map<string, string>();
  for (const grant of sessionGrants) {
    const existing = sessionByGuest.get(grant.principalId);
    if (existing !== undefined && existing !== grant.sessionId) {
      throw new Error('A Session Guest cannot be granted multiple Sessions');
    }
    sessionByGuest.set(grant.principalId, grant.sessionId);
  }
  const turnAccessRequests =
    value.schemaVersion < 3
      ? []
      : Array.isArray(value.turnAccessRequests)
        ? value.turnAccessRequests.map(decodeSessionTurnAccessRequest)
        : (() => {
            throw new Error('Invalid Runtime Host Turn access requests');
          })();
  if (
    new Set(turnAccessRequests.map((request) => request.requestId)).size !==
    turnAccessRequests.length
  ) {
    throw new Error('Duplicate Runtime Host Turn access request identity');
  }
  return createAccessCredentialFile(credentials, sessionGrants, turnAccessRequests);
}

function decodeStoredCredential(value: unknown): StoredAccessCredential {
  if (!isRecord(value)) throw new Error('Invalid Runtime Host access credential');
  const credentialId = requireStoredString(value.credentialId, 'credentialId');
  const credentialHash = requireStoredString(value.credentialHash, 'credentialHash');
  if (!/^[a-f0-9]{64}$/u.test(credentialHash)) throw new Error('Invalid credentialHash');
  const principalId = requireStoredString(value.principalId, 'principalId');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(principalId)) throw new Error('Invalid principalId');
  const principalKind = value.principalKind === undefined ? 'remote_owner' : value.principalKind;
  if (
    principalKind !== 'remote_owner' &&
    principalKind !== 'capability_provider' &&
    principalKind !== 'session_guest'
  ) {
    throw new Error('Invalid principalKind');
  }
  if (value.status !== 'pending' && value.status !== 'active' && value.status !== 'revoked') {
    throw new Error('Invalid status');
  }
  if (!Array.isArray(value.operationGrants)) throw new Error('Invalid operationGrants');
  const storedGrants = value.operationGrants.map((grant) =>
    requireStoredString(grant, 'operationGrant'),
  );
  if (new Set(storedGrants).size !== storedGrants.length) {
    throw new Error('Duplicate Runtime Host access operation grant');
  }
  const grants = migratePersistedGrants(storedGrants);
  if (!grants.includes('host.status')) {
    throw new Error('Runtime Host access credential lacks its liveness grant');
  }
  if (
    typeof value.canPublishClientCapabilities !== 'boolean' ||
    typeof value.canUseHostPaths !== 'boolean'
  ) {
    throw new Error('Invalid access credential authority');
  }
  const createdAt = requireStoredString(value.createdAt, 'createdAt');
  const bindClientInstanceOnFinalize = value.bindClientInstanceOnFinalize;
  if (bindClientInstanceOnFinalize !== undefined && bindClientInstanceOnFinalize !== true) {
    throw new Error('Invalid bindClientInstanceOnFinalize');
  }
  const clientInstanceId = value.clientInstanceId;
  if (
    clientInstanceId !== undefined &&
    (typeof clientInstanceId !== 'string' ||
      clientInstanceId.length === 0 ||
      clientInstanceId.length > 128)
  ) {
    throw new Error('Invalid clientInstanceId');
  }
  if (
    (bindClientInstanceOnFinalize !== undefined && value.status !== 'pending') ||
    (clientInstanceId !== undefined && value.status !== 'active') ||
    (bindClientInstanceOnFinalize !== undefined && clientInstanceId !== undefined)
  ) {
    throw new Error('Invalid access credential Client binding state');
  }
  const capabilityOwner = decodeCapabilityOwner(value.capabilityOwner);
  if (capabilityOwner && principalKind !== 'capability_provider') {
    throw new Error('Only a capability provider may declare a Client Capability owner');
  }
  const expiresAt = value.expiresAt;
  if (value.status === 'pending') {
    if (typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt))) {
      throw new Error('Invalid expiresAt');
    }
  } else if (expiresAt !== undefined) {
    throw new Error('Invalid expiresAt');
  }
  const revokedAt = value.revokedAt;
  if (revokedAt !== undefined && typeof revokedAt !== 'string') {
    throw new Error('Invalid revokedAt');
  }
  return {
    credentialId,
    credentialHash,
    principalId,
    principalKind,
    status: value.status,
    grants,
    canPublishClientCapabilities: value.canPublishClientCapabilities,
    canUseHostPaths: value.canUseHostPaths,
    ...(capabilityOwner ? { capabilityOwner } : {}),
    createdAt,
    ...(bindClientInstanceOnFinalize === true ? { bindClientInstanceOnFinalize } : {}),
    ...(typeof clientInstanceId === 'string' ? { clientInstanceId } : {}),
    ...(typeof expiresAt === 'string' ? { expiresAt } : {}),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

function decodeStoredSessionGrant(value: unknown): SessionCollaborationGrant {
  if (!isRecord(value)) throw new Error('Invalid Runtime Host Session grant');
  if (value.kind !== 'session_observation' && value.kind !== 'session_turn_request') {
    throw new Error('Invalid Runtime Host Session grant kind');
  }
  const grantId = requireStoredString(value.grantId, 'grantId');
  const principalId = requireStoredString(value.principalId, 'principalId');
  const sessionId = requireStoredString(value.sessionId, 'sessionId');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(principalId)) throw new Error('Invalid principalId');
  if (!/^[A-Za-z0-9_.:-]{1,256}$/u.test(grantId)) throw new Error('Invalid grantId');
  if (!/^[A-Za-z0-9_.:-]{1,256}$/u.test(sessionId)) throw new Error('Invalid sessionId');
  const createdAt = requireStoredTimestamp(value.createdAt, 'createdAt');
  return Object.freeze({
    kind: value.kind,
    grantId,
    principalId,
    sessionId,
    createdAt,
  });
}

function decodeCapabilityOwner(value: unknown): ClientCapabilityOwnerIdentity | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Invalid Client Capability owner identity');
  const principalId = requireStoredString(value.principalId, 'capabilityOwner.principalId');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(principalId)) {
    throw new Error('Invalid capabilityOwner.principalId');
  }
  const clientInstanceId = requireStoredString(
    value.clientInstanceId,
    'capabilityOwner.clientInstanceId',
  );
  if (clientInstanceId.length > 128) {
    throw new Error('Invalid capabilityOwner.clientInstanceId');
  }
  return Object.freeze({ principalId, clientInstanceId });
}

// Rewrites the record, and only where a migration entry says to. A stored grant
// naming no entry is carried through unchanged, whether or not this build knows
// it: an older build must not erase a key a newer one wrote, and a newer build
// must not erase a key whose migration entry was forgotten. Both erasures are
// permanent, because the next unrelated mutation rewrites the whole file.
function migratePersistedGrants(grants: readonly string[]): readonly string[] {
  const migrated: string[] = [];
  const seen = new Set<string>();
  for (const stored of grants) {
    const migration = PERSISTED_GRANT_MIGRATIONS.get(stored);
    const successors: readonly string[] = migration
      ? migration.kind === 'replace'
        ? migration.successors
        : []
      : [stored];
    for (const successor of successors) {
      if (seen.has(successor)) continue;
      seen.add(successor);
      migrated.push(successor);
    }
  }
  return Object.freeze(migrated);
}

// The issuance gate. Nothing the current protocol does not define may enter the
// record through this Host; what a predecessor already wrote is the decoder's
// problem, not this one's.
function assertCurrentOperations(grants: readonly OperationKey[]): void {
  for (const grant of grants) {
    if (!Object.hasOwn(HOST_OPERATION_SPECS, grant)) {
      throw new RuntimeHostAccessInputError(`Unknown Runtime Host operation grant: ${grant}`);
    }
  }
}

function validateIssuedGrants(grants: readonly OperationKey[]): readonly OperationKey[] {
  assertCurrentOperations(grants);
  for (const grant of grants) {
    if (!operationAllowsRemoteOwner(grant)) {
      throw new RuntimeHostAccessInputError(`Runtime Host operation ${grant} is local-owner only`);
    }
  }
  return Object.freeze([...grants]);
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireStoredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) {
    throw new Error(`Invalid Runtime Host access ${label}`);
  }
  return value;
}

function requireStoredTimestamp(value: unknown, label: string): string {
  const timestamp = requireStoredString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`Invalid ${label}`);
  return timestamp;
}
