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
const LEGACY_TRANSCRIPT_QUERY_GRANT = 'session.transcript.query';
const TRANSCRIPT_QUERY_REPLACEMENT_GRANTS = [
  'session.transcript.page',
  'session.transcript.overlay.release',
] as const satisfies readonly OperationKey[];
const TURN_QUERY_GRANT = 'session.turns.query';
const TURN_QUERY_REPLACEMENT_GRANTS = [
  TURN_QUERY_GRANT,
  'session.turn_landmarks.query',
] as const satisfies readonly OperationKey[];
// Operations that left the protocol entirely. A previously issued access file
// may still grant them; the grant is released on decode — there is nothing to
// migrate it to — because failing the whole file would keep the Host from
// starting over a capability it could not serve anyway.
const RETIRED_OPERATION_GRANTS = new Set([
  // Retired with the Claude subscription provider, whose client identity the
  // usage report required.
  'oauth.account.usage.fetch',
  // Retired with the second execution-inspection contract; no shipped surface
  // called execution.inspect.resolve, so a stored grant is released on decode.
  'execution.inspect.resolve',
]);

export const ACCESS_FILE_NAME = 'runtime-host-access.json';

export const SESSION_GUEST_OPERATION_GRANTS = Object.freeze([
  'host.status',
  'artifact.query',
  'collaboration.turn-request.create',
  'collaboration.turn-request.acknowledge',
  'collaboration.turn-request.query',
  'runtime.resource.query',
  'session.shared.query',
  'subscription.open',
  'subscription.close',
  'session.transcript.page',
  'session.transcript.overlay.release',
] as const satisfies readonly OperationKey[]);

export interface StoredAccessCredential {
  readonly credentialId: string;
  readonly credentialHash: string;
  readonly principalId: string;
  readonly principalKind: AccessCredentialPrincipalKind;
  readonly status: 'pending' | 'active' | 'revoked';
  readonly operationGrants: readonly OperationKey[];
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

function serializeAccessCredentialFile(file: AccessCredentialFile): string {
  const contents = `${JSON.stringify(file, null, 2)}\n`;
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
  const storedOperationGrants = value.operationGrants.map((grant) =>
    requireStoredString(grant, 'operationGrant'),
  );
  if (new Set(storedOperationGrants).size !== storedOperationGrants.length) {
    throw new Error('Duplicate Runtime Host access operation grant');
  }
  const migratedOperationGrants = validateStoredGrants(
    migrateStoredOperationGrants(storedOperationGrants),
  );
  if (
    principalKind === 'session_guest' &&
    migratedOperationGrants.some(
      (grant) => !(SESSION_GUEST_OPERATION_GRANTS as readonly OperationKey[]).includes(grant),
    )
  ) {
    throw new Error('Session Guest credential has an invalid operation grant');
  }
  const operationGrants = Object.freeze(
    principalKind === 'session_guest'
      ? [...SESSION_GUEST_OPERATION_GRANTS]
      : migratedOperationGrants.filter(operationAllowsRemoteOwner),
  );
  if (!operationGrants.includes('host.status')) {
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
    operationGrants,
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

function migrateStoredOperationGrants(grants: readonly string[]): readonly string[] {
  const migrated: string[] = [];
  const seen = new Set<string>();
  for (const stored of grants) {
    const replacements = RETIRED_OPERATION_GRANTS.has(stored)
      ? []
      : stored === LEGACY_TRANSCRIPT_QUERY_GRANT
        ? TRANSCRIPT_QUERY_REPLACEMENT_GRANTS
        : stored === TURN_QUERY_GRANT
          ? TURN_QUERY_REPLACEMENT_GRANTS
          : [stored];
    for (const replacement of replacements) {
      if (seen.has(replacement)) continue;
      seen.add(replacement);
      migrated.push(replacement);
    }
  }
  return migrated;
}

function validateStoredGrants(grants: readonly string[]): readonly OperationKey[] {
  for (const grant of grants) {
    if (!Object.hasOwn(HOST_OPERATION_SPECS, grant)) {
      throw new RuntimeHostAccessInputError(`Unknown Runtime Host operation grant: ${grant}`);
    }
  }
  return Object.freeze([...grants] as OperationKey[]);
}

function validateIssuedGrants(grants: readonly OperationKey[]): readonly OperationKey[] {
  validateStoredGrants(grants);
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
