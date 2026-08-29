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

import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import { runtimeHostAccessCredentialHash } from '../access-credential-identity.js';
import {
  type AccessCredentialIssueInput,
  type AccessCredentialIssueResult,
  type AccessCredentialFinalizeResult,
  type AccessCredentialPrepareInput,
  type AccessCredentialPrepareResult,
  type AccessCredentialReplaceInput,
  type AccessCredentialReplaceResult,
  type AccessCredentialRevokeInput,
  type AccessCredentialRevokeResult,
  type AccessCredentialRotationPrepareInput,
  type AccessCredentialRotationPrepareResult,
  type AccessCredentialRotationRevokeInput,
  type AccessCredentialRotationRevokeResult,
  type AccessPrincipalRevokeInput,
  type AccessPrincipalRevokeResult,
  type CollaborationAccessQueryInput,
  type CollaborationAccessQueryResult,
  type CollaborationGrantRevokeInput,
  type CollaborationGrantRevokeResult,
  type CollaborationInvitationPrepareInput,
  type CollaborationInvitationPrepareResult,
  type CollaborationPrincipalRevokeResult,
  encodeCollaborationInvitationCode,
  type SessionCollaborationGrant,
  type SessionCollaborationGrantKind,
} from '../protocol/index.js';
import {
  createRuntimeHostConnectionAuthority,
  type RuntimeHostConnectionAuthority,
} from './connection-authority.js';
import type { OperationOutcome } from '../protocol/operations.js';
import {
  createAccessCredentialDelivery,
  discardAccessCredentialDelivery,
  purgeAccessCredentialDeliveries,
} from '../control/access-credential-delivery.js';
import {
  ACCESS_FILE_NAME,
  assertAccessCredentialFileCapacity,
  createAccessCredentialFile,
  issuedAccessGrants,
  readAccessCredentialFile,
  RuntimeHostAccessCommitOutcomeUnknownError,
  RuntimeHostAccessInputError,
  type AccessCredentialFile,
  type StoredAccessCredential,
  SESSION_GUEST_OPERATION_GRANTS,
  writeAccessCredentialFile,
} from './access-credential-store.js';

const ACCESS_CREDENTIAL_PREFIX = 'maka_rh_';
const PENDING_CREDENTIAL_LIFETIME_MS = 15 * 60_000;
const CAPABILITY_PROVIDER_GRANTS = new Set([
  'host.status',
  'client.capability.replace',
  'client.capability.unregister',
]);

export interface RuntimeHostAccessAuthority {
  authenticate(credential: string): RuntimeHostConnectionAuthority | undefined;
  issue(input: AccessCredentialIssueInput): Promise<AccessCredentialIssueResult>;
  replace(input: AccessCredentialReplaceInput): Promise<AccessCredentialReplaceResult>;
  prepare(input: AccessCredentialPrepareInput): Promise<AccessCredentialPrepareResult>;
  revoke(input: AccessCredentialRevokeInput): Promise<AccessCredentialRevokeResult>;
  revokePrincipal(input: AccessPrincipalRevokeInput): Promise<AccessPrincipalRevokeResult>;
  prepareRotation(
    input: AccessCredentialRotationPrepareInput,
  ): Promise<AccessCredentialRotationPrepareResult>;
  revokeRotation(
    input: AccessCredentialRotationRevokeInput,
  ): Promise<AccessCredentialRotationRevokeResult>;
  finalize(credentialId: string, clientInstanceId: string): Promise<AccessCredentialFinalizeResult>;
  prepareCollaborationInvitation(
    rootId: string,
    input: CollaborationInvitationPrepareInput,
  ): Promise<CollaborationInvitationPrepareResult>;
  queryCollaborationAccess(input: CollaborationAccessQueryInput): CollaborationAccessQueryResult;
  revokeCollaborationGrant(
    input: CollaborationGrantRevokeInput,
  ): Promise<CollaborationGrantRevokeResult>;
  revokeCollaborationPrincipal(principalId: string): Promise<CollaborationPrincipalRevokeResult>;
  activeSessionGrant(
    principalId: string,
    sessionId: string,
    kind: SessionCollaborationGrantKind,
  ): SessionCollaborationGrant | undefined;
  activeSessionGrantForPrincipal(
    principalId: string,
    kind: SessionCollaborationGrantKind,
  ): SessionCollaborationGrant | undefined;
  subscribeRevocations(listener: (credentialId: string) => void): () => void;
  subscribeGrantRevocations(listener: (grant: SessionCollaborationGrant) => void): () => void;
  close(): Promise<void>;
}

export async function openRuntimeHostAccessAuthority(
  controlDirectory: string,
  input: {
    readonly writeFile?: typeof writeAccessCredentialFile;
  } = {},
): Promise<RuntimeHostAccessAuthority> {
  await purgeAccessCredentialDeliveries(controlDirectory);
  const path = join(controlDirectory, ACCESS_FILE_NAME);
  return new FileRuntimeHostAccessAuthority(
    controlDirectory,
    path,
    await readAccessCredentialFile(path),
    input.writeFile ?? writeAccessCredentialFile,
  );
}

class FileRuntimeHostAccessAuthority implements RuntimeHostAccessAuthority {
  readonly #controlDirectory: string;
  readonly #path: string;
  readonly #writeFile: typeof writeAccessCredentialFile;
  #file: AccessCredentialFile;
  #mutation = Promise.resolve();
  #expiryTimer: NodeJS.Timeout | undefined;
  #closed = false;
  readonly #revocationListeners = new Set<(credentialId: string) => void>();
  readonly #grantRevocationListeners = new Set<(grant: SessionCollaborationGrant) => void>();

  constructor(
    controlDirectory: string,
    path: string,
    file: AccessCredentialFile,
    writeFile: typeof writeAccessCredentialFile,
  ) {
    this.#controlDirectory = controlDirectory;
    this.#path = path;
    this.#file = file;
    this.#writeFile = writeFile;
    this.#schedulePendingExpiry();
  }

  authenticate(credential: string): RuntimeHostConnectionAuthority | undefined {
    if (this.#closed) return undefined;
    const candidate = runtimeHostAccessCredentialHash(credential);
    let match: StoredAccessCredential | undefined;
    for (const stored of this.#file.credentials) {
      const storedHash = Buffer.from(stored.credentialHash, 'hex');
      const equal =
        storedHash.byteLength === candidate.byteLength && timingSafeEqual(storedHash, candidate);
      if (
        equal &&
        (stored.status === 'active' ||
          (stored.status === 'pending' && Date.parse(stored.expiresAt!) > Date.now()))
      ) {
        match = stored;
      }
    }
    return match
      ? createRuntimeHostConnectionAuthority({
          principalKind: match.principalKind,
          principalId: match.principalId,
          credentialId: match.credentialId,
          operationGrants: match.bindClientInstanceOnFinalize
            ? ['host.status', 'access.credential.finalize']
            : match.operationGrants,
          canPublishClientCapabilities:
            !match.bindClientInstanceOnFinalize && match.canPublishClientCapabilities,
          canUseHostPaths: !match.bindClientInstanceOnFinalize && match.canUseHostPaths,
          ...(match.clientInstanceId ? { clientInstanceId: match.clientInstanceId } : {}),
        })
      : undefined;
  }

  issue(input: AccessCredentialIssueInput): Promise<AccessCredentialIssueResult> {
    return this.#issue(input, 'issue');
  }

  replace(input: AccessCredentialReplaceInput): Promise<AccessCredentialReplaceResult> {
    return this.#issue(input, 'replace');
  }

  prepare(input: AccessCredentialPrepareInput): Promise<AccessCredentialPrepareResult> {
    return this.#issue(input, 'prepare');
  }

  prepareCollaborationInvitation(
    rootId: string,
    input: CollaborationInvitationPrepareInput,
  ): Promise<CollaborationInvitationPrepareResult> {
    return this.#mutate(async () => {
      const principalId = `session_guest:${randomUUID()}`;
      const credentialId = randomUUID();
      const credential = `${ACCESS_CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`;
      const created = new Date();
      const createdAt = created.toISOString();
      const expiresAt = new Date(created.getTime() + PENDING_CREDENTIAL_LIFETIME_MS).toISOString();
      const stored: StoredAccessCredential = {
        credentialId,
        credentialHash: runtimeHostAccessCredentialHash(credential).toString('hex'),
        principalId,
        principalKind: 'session_guest',
        status: 'pending',
        operationGrants: SESSION_GUEST_OPERATION_GRANTS,
        canPublishClientCapabilities: false,
        canUseHostPaths: false,
        createdAt,
        expiresAt,
        bindClientInstanceOnFinalize: true,
      };
      const grants = input.grantKinds.map(
        (kind): SessionCollaborationGrant => ({
          kind,
          grantId: randomUUID(),
          principalId,
          sessionId: input.sessionId,
          createdAt,
        }),
      );
      const nextFile = createAccessCredentialFile(
        [...this.#file.credentials, stored],
        [...this.#file.sessionGrants, ...grants],
      );
      assertAccessCredentialFileCapacity(nextFile);
      await this.#commit(nextFile);
      return {
        invitationCode: encodeCollaborationInvitationCode({
          schemaVersion: 1,
          rootId,
          credential,
        }),
        principalId,
        expiresAt,
        grants,
      };
    });
  }

  queryCollaborationAccess(input: CollaborationAccessQueryInput): CollaborationAccessQueryResult {
    const grants = this.#file.sessionGrants.filter(
      (grant) => input.sessionId === undefined || grant.sessionId === input.sessionId,
    );
    const now = Date.now();
    const principals = [...new Set(grants.map((grant) => grant.principalId))].flatMap(
      (principalId) => {
        const credentials = this.#file.credentials.filter(
          (candidate) =>
            candidate.principalKind === 'session_guest' &&
            candidate.principalId === principalId &&
            (candidate.status === 'active' ||
              (candidate.status === 'pending' && Date.parse(candidate.expiresAt!) > now)),
        );
        const credential =
          credentials.find((candidate) => candidate.status === 'active') ?? credentials[0];
        return credential
          ? [
              {
                principalId,
                status: credential.status as 'active' | 'pending',
                createdAt: credential.createdAt,
                ...(credential.expiresAt ? { expiresAt: credential.expiresAt } : {}),
              },
            ]
          : [];
      },
    );
    return { principals, grants };
  }

  revokeCollaborationGrant(
    input: CollaborationGrantRevokeInput,
  ): Promise<CollaborationGrantRevokeResult> {
    return this.#mutate(async () => {
      const current = this.#file.sessionGrants.find((grant) => grant.grantId === input.grantId);
      if (!current) return { revoked: false };
      await this.#commit(
        createAccessCredentialFile(
          this.#file.credentials,
          this.#file.sessionGrants.filter((grant) => grant !== current),
        ),
        [],
        [current],
      );
      return { revoked: true };
    });
  }

  revokeCollaborationPrincipal(principalId: string): Promise<CollaborationPrincipalRevokeResult> {
    return this.revokePrincipal({ principalKind: 'session_guest', principalId });
  }

  activeSessionGrant(
    principalId: string,
    sessionId: string,
    kind: SessionCollaborationGrantKind,
  ): SessionCollaborationGrant | undefined {
    return this.#file.sessionGrants.find(
      (grant) =>
        grant.principalId === principalId && grant.sessionId === sessionId && grant.kind === kind,
    );
  }

  activeSessionGrantForPrincipal(
    principalId: string,
    kind: SessionCollaborationGrantKind,
  ): SessionCollaborationGrant | undefined {
    return this.#file.sessionGrants.find(
      (grant) => grant.principalId === principalId && grant.kind === kind,
    );
  }

  prepareRotation(
    input: AccessCredentialRotationPrepareInput,
  ): Promise<AccessCredentialRotationPrepareResult> {
    return this.#mutate(async () => {
      const current = this.#file.credentials.find(
        (credential) =>
          credential.credentialId === input.replacementOfCredentialId &&
          credential.status === 'active',
      );
      if (!current) {
        throw new RuntimeHostAccessInputError('The credential being rotated is no longer active');
      }
      if (current.principalKind !== 'remote_owner') {
        throw new RuntimeHostAccessInputError('This credential cannot use owner rotation');
      }
      return this.#createCredential(
        {
          principalId: current.principalId,
          principalKind: current.principalKind,
          operationGrants: current.operationGrants,
          canPublishClientCapabilities: current.canPublishClientCapabilities,
          canUseHostPaths: current.canUseHostPaths,
          bindClientInstance: current.bindClientInstanceOnFinalize === true,
        },
        'prepare',
        current.operationGrants,
      );
    });
  }

  #issue(
    input: AccessCredentialIssueInput | AccessCredentialPrepareInput,
    mode: 'issue' | 'replace' | 'prepare',
  ): Promise<AccessCredentialIssueResult> {
    return this.#mutate(() => this.#createCredential(input, mode));
  }

  async #createCredential(
    input: AccessCredentialIssueInput | AccessCredentialPrepareInput,
    mode: 'issue' | 'replace' | 'prepare',
    operationGrants = issuedAccessGrants(input.operationGrants),
  ): Promise<AccessCredentialIssueResult> {
    assertCredentialAuthority(input, operationGrants);
    if (
      mode === 'prepare' &&
      (input.principalKind !== 'remote_owner' ||
        !operationGrants.includes('access.credential.finalize'))
    ) {
      throw new RuntimeHostAccessInputError(
        'A pairing candidate must be a remote owner that can finalize its pairing',
      );
    }
    const credentialId = randomUUID();
    createRuntimeHostConnectionAuthority({
      principalKind: input.principalKind,
      principalId: input.principalId,
      credentialId,
      operationGrants,
      canPublishClientCapabilities: input.canPublishClientCapabilities,
      canUseHostPaths: input.canUseHostPaths,
    });
    const credential = `${ACCESS_CREDENTIAL_PREFIX}${randomBytes(32).toString('base64url')}`;
    const createdAt = new Date();
    const stored: StoredAccessCredential = {
      credentialId,
      credentialHash: runtimeHostAccessCredentialHash(credential).toString('hex'),
      principalId: input.principalId,
      principalKind: input.principalKind,
      status: mode === 'prepare' ? 'pending' : 'active',
      operationGrants,
      canPublishClientCapabilities: input.canPublishClientCapabilities,
      canUseHostPaths: input.canUseHostPaths,
      createdAt: createdAt.toISOString(),
      ...(mode === 'prepare'
        ? {
            expiresAt: new Date(createdAt.getTime() + PENDING_CREDENTIAL_LIFETIME_MS).toISOString(),
            ...('bindClientInstance' in input && input.bindClientInstance
              ? { bindClientInstanceOnFinalize: true as const }
              : {}),
          }
        : {}),
    };
    const replaced = this.#file.credentials.filter(
      (candidate) =>
        candidate.principalKind === input.principalKind &&
        candidate.principalId === input.principalId &&
        ((mode === 'replace' && candidate.status !== 'revoked') ||
          (mode === 'prepare' && candidate.status === 'pending')),
    );
    const retained =
      replaced.length === 0
        ? this.#file.credentials
        : this.#file.credentials.filter((candidate) => !replaced.includes(candidate));
    const nextFile = createAccessCredentialFile([...retained, stored], this.#file.sessionGrants);
    assertAccessCredentialFileCapacity(nextFile);
    const deliveryId = await createAccessCredentialDelivery(
      this.#controlDirectory,
      credentialId,
      credential,
    );
    try {
      await this.#commit(
        nextFile,
        replaced.map((credential) => credential.credentialId),
      );
    } catch (error) {
      await discardAccessCredentialDelivery(this.#controlDirectory, deliveryId);
      throw error;
    }
    return {
      credentialId,
      deliveryId,
      principalId: stored.principalId,
      principalKind: input.principalKind,
      operationGrants,
      canPublishClientCapabilities: stored.canPublishClientCapabilities,
      canUseHostPaths: stored.canUseHostPaths,
    };
  }

  revoke(input: AccessCredentialRevokeInput): Promise<AccessCredentialRevokeResult> {
    return this.#mutate(async () => {
      return this.#revoke(input.credentialId);
    });
  }

  revokePrincipal(input: AccessPrincipalRevokeInput): Promise<AccessPrincipalRevokeResult> {
    return this.#mutate(async () => {
      const matches = this.#file.credentials.filter(
        (credential) =>
          credential.status !== 'revoked' &&
          credential.principalKind === input.principalKind &&
          credential.principalId === input.principalId,
      );
      const activeGrants =
        input.principalKind === 'session_guest'
          ? this.#file.sessionGrants.filter((grant) => grant.principalId === input.principalId)
          : [];
      if (matches.length === 0 && activeGrants.length === 0) return { revoked: false };

      const matchedIds = new Set(matches.map((credential) => credential.credentialId));
      const revokedAt = new Date().toISOString();
      const credentials = this.#file.credentials.flatMap((credential) => {
        if (!matchedIds.has(credential.credentialId)) return [credential];
        if (credential.status === 'pending') return [];
        const { clientInstanceId: _clientInstanceId, ...revoked } = credential;
        return [{ ...revoked, status: 'revoked' as const, revokedAt }];
      });
      await this.#commit(
        createAccessCredentialFile(
          credentials,
          this.#file.sessionGrants.filter((grant) => !activeGrants.includes(grant)),
        ),
        [...matchedIds],
        activeGrants,
      );
      return { revoked: true };
    });
  }

  revokeRotation(
    input: AccessCredentialRotationRevokeInput,
  ): Promise<AccessCredentialRotationRevokeResult> {
    return this.#mutate(async () => {
      const requiredActiveCredential = this.#file.credentials.find(
        (credential) => credential.credentialId === input.requiredActiveCredentialId,
      );
      if (!requiredActiveCredential || requiredActiveCredential.status !== 'active') {
        throw new RuntimeHostAccessInputError(
          'The required credential is no longer active on this Runtime Host',
        );
      }
      if (input.credentialId === input.requiredActiveCredentialId) {
        throw new RuntimeHostAccessInputError('A credential cannot revoke itself');
      }
      return this.#revoke(input.credentialId);
    });
  }

  async #revoke(credentialId: string): Promise<AccessCredentialRevokeResult> {
    const index = this.#file.credentials.findIndex(
      (credential) => credential.credentialId === credentialId,
    );
    if (index === -1 || this.#file.credentials[index]?.status === 'revoked') {
      return { credentialId, revoked: false };
    }
    const current = this.#file.credentials[index]!;
    const pendingForPrincipal =
      current.status === 'active'
        ? this.#file.credentials.filter(
            (credential) =>
              credential.status === 'pending' &&
              credential.principalKind === current.principalKind &&
              credential.principalId === current.principalId,
          )
        : [];
    const credentials =
      current.status === 'pending'
        ? this.#file.credentials.filter((credential) => credential !== current)
        : this.#file.credentials
            .filter((credential) => !pendingForPrincipal.includes(credential))
            .map((credential) => {
              if (credential !== current) return credential;
              const { clientInstanceId: _clientInstanceId, ...revoked } = credential;
              return {
                ...revoked,
                status: 'revoked' as const,
                revokedAt: new Date().toISOString(),
              };
            });
    await this.#commit(
      createAccessCredentialFile(credentials, this.#file.sessionGrants),
      [current, ...pendingForPrincipal].map((credential) => credential.credentialId),
    );
    return { credentialId, revoked: true };
  }

  finalize(
    credentialId: string,
    clientInstanceId: string,
  ): Promise<AccessCredentialFinalizeResult> {
    return this.#mutate(async () => {
      const retained = this.#file.credentials.find(
        (credential) => credential.credentialId === credentialId,
      );
      if (!retained || retained.status === 'revoked') {
        throw new RuntimeHostAccessInputError('The current access credential is no longer active');
      }
      return this.#finalize(retained, clientInstanceId);
    });
  }

  async #finalize(
    retained: StoredAccessCredential,
    clientInstanceId: string,
  ): Promise<AccessCredentialFinalizeResult> {
    if (retained.status === 'active') {
      if (retained.clientInstanceId && retained.clientInstanceId !== clientInstanceId) {
        throw new RuntimeHostAccessInputError(
          'The pairing candidate was claimed by another Client',
        );
      }
      return { reconnectRequired: retained.clientInstanceId !== undefined };
    }
    if (Date.parse(retained.expiresAt!) <= Date.now()) {
      await this.#expirePending();
      throw new RuntimeHostAccessInputError('The pairing candidate has expired');
    }
    const revoked = this.#file.credentials.filter(
      (credential) =>
        credential.credentialId !== retained.credentialId &&
        credential.status === 'active' &&
        credential.principalKind === retained.principalKind &&
        credential.principalId === retained.principalId,
    );
    const finalized = createAccessCredentialFile(
      this.#file.credentials
        .filter((credential) => !revoked.includes(credential))
        .map((credential) =>
          credential === retained
            ? activatePendingCredential(credential, clientInstanceId)
            : credential,
        ),
      this.#file.sessionGrants,
    );
    await this.#commit(
      finalized,
      revoked.map((credential) => credential.credentialId),
    );
    return { reconnectRequired: retained.bindClientInstanceOnFinalize === true };
  }

  subscribeRevocations(listener: (credentialId: string) => void): () => void {
    if (this.#closed) return () => undefined;
    this.#revocationListeners.add(listener);
    return () => this.#revocationListeners.delete(listener);
  }

  subscribeGrantRevocations(listener: (grant: SessionCollaborationGrant) => void): () => void {
    if (this.#closed) return () => undefined;
    this.#grantRevocationListeners.add(listener);
    return () => this.#grantRevocationListeners.delete(listener);
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
      this.#expiryTimer = undefined;
      this.#revocationListeners.clear();
      this.#grantRevocationListeners.clear();
    }
    return this.#mutation;
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new Error('Runtime Host access authority is closed'));
    }
    const result = this.#mutation.then(operation, operation);
    this.#mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #commit(
    file: AccessCredentialFile,
    revokedCredentialIds: readonly string[] = [],
    revokedGrants: readonly SessionCollaborationGrant[] = [],
  ): Promise<void> {
    let outcomeUnknown: RuntimeHostAccessCommitOutcomeUnknownError | undefined;
    try {
      await this.#writeFile(this.#path, file);
    } catch (error) {
      if (!(error instanceof RuntimeHostAccessCommitOutcomeUnknownError)) throw error;
      outcomeUnknown = error;
    }
    this.#file = file;
    this.#schedulePendingExpiry();
    for (const credentialId of revokedCredentialIds) this.#publishRevocation(credentialId);
    for (const grant of revokedGrants) this.#publishGrantRevocation(grant);
    if (outcomeUnknown) throw outcomeUnknown;
  }

  async #expirePending(): Promise<void> {
    const now = Date.now();
    const expired = this.#file.credentials.filter(
      (credential) => credential.status === 'pending' && Date.parse(credential.expiresAt!) <= now,
    );
    if (expired.length === 0) {
      this.#schedulePendingExpiry();
      return;
    }
    const expiredGuestPrincipals = new Set(
      expired
        .filter((credential) => credential.principalKind === 'session_guest')
        .map((credential) => credential.principalId),
    );
    const expiredGrants = this.#file.sessionGrants.filter((grant) =>
      expiredGuestPrincipals.has(grant.principalId),
    );
    await this.#commit(
      createAccessCredentialFile(
        this.#file.credentials.filter((credential) => !expired.includes(credential)),
        this.#file.sessionGrants.filter((grant) => !expiredGrants.includes(grant)),
      ),
      expired.map((credential) => credential.credentialId),
      expiredGrants,
    );
  }

  #schedulePendingExpiry(retryMs?: number): void {
    if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
    if (this.#closed) {
      this.#expiryTimer = undefined;
      return;
    }
    const nextExpiry = this.#file.credentials.reduce<number | undefined>((earliest, credential) => {
      if (credential.status !== 'pending') return earliest;
      const expiresAt = Date.parse(credential.expiresAt!);
      return earliest === undefined || expiresAt < earliest ? expiresAt : earliest;
    }, undefined);
    if (nextExpiry === undefined) {
      this.#expiryTimer = undefined;
      return;
    }
    this.#expiryTimer = setTimeout(
      () => {
        this.#expiryTimer = undefined;
        void this.#mutate(() => this.#expirePending()).catch(() => {
          if (!this.#closed) this.#schedulePendingExpiry(1_000);
        });
      },
      retryMs ?? Math.max(0, nextExpiry - Date.now()),
    );
    this.#expiryTimer.unref();
  }

  #publishRevocation(credentialId: string): void {
    for (const listener of this.#revocationListeners) {
      try {
        listener(credentialId);
      } catch {
        // Revocation is already durable; an observer cannot roll it back.
      }
    }
  }

  #publishGrantRevocation(grant: SessionCollaborationGrant): void {
    for (const listener of this.#grantRevocationListeners) {
      try {
        listener(grant);
      } catch {
        // The revocation is already durable; an observer cannot roll it back.
      }
    }
  }
}

function activatePendingCredential(
  credential: StoredAccessCredential,
  clientInstanceId: string,
): StoredAccessCredential {
  const { expiresAt: _expiresAt, bindClientInstanceOnFinalize, ...retained } = credential;
  return {
    ...retained,
    status: 'active',
    ...(bindClientInstanceOnFinalize ? { clientInstanceId } : {}),
  };
}

function assertCredentialAuthority(
  input: AccessCredentialIssueInput,
  operationGrants: readonly string[],
): void {
  if (input.principalKind !== 'capability_provider') return;
  if (!input.canPublishClientCapabilities || input.canUseHostPaths) {
    throw new RuntimeHostAccessInputError(
      'A capability provider must publish Client Capabilities without Host path authority',
    );
  }
  if (
    operationGrants.length !== CAPABILITY_PROVIDER_GRANTS.size ||
    operationGrants.some((grant) => !CAPABILITY_PROVIDER_GRANTS.has(grant))
  ) {
    throw new RuntimeHostAccessInputError(
      'A capability provider credential may grant only Client Capability publication operations',
    );
  }
}

export async function issueAccessCredential(
  authority: RuntimeHostAccessAuthority | undefined,
  input: AccessCredentialIssueInput,
): Promise<OperationOutcome<'access.credential.issue'>> {
  if (!authority) return unavailable('issue');
  try {
    return { ok: true, result: await authority.issue(input) };
  } catch (error) {
    if (error instanceof RuntimeHostAccessInputError) {
      return { ok: false, error: { code: 'invalid_request', message: error.message } };
    }
    return accessPersistenceFailure(
      error,
      'Access credential issuance outcome is unknown',
      'Access credential could not be issued',
    );
  }
}

export async function replaceAccessCredential(
  authority: RuntimeHostAccessAuthority | undefined,
  input: AccessCredentialReplaceInput,
): Promise<OperationOutcome<'access.credential.replace'>> {
  if (!authority) return unavailable('replace');
  try {
    return { ok: true, result: await authority.replace(input) };
  } catch (error) {
    if (error instanceof RuntimeHostAccessInputError) {
      return { ok: false, error: { code: 'invalid_request', message: error.message } };
    }
    return accessPersistenceFailure(
      error,
      'Access credential replacement outcome is unknown',
      'Access credential could not be replaced',
    );
  }
}

export async function prepareAccessCredential(
  authority: RuntimeHostAccessAuthority | undefined,
  input: AccessCredentialPrepareInput,
): Promise<OperationOutcome<'access.credential.prepare'>> {
  if (!authority) return unavailable('prepare');
  try {
    return { ok: true, result: await authority.prepare(input) };
  } catch (error) {
    if (error instanceof RuntimeHostAccessInputError) {
      return { ok: false, error: { code: 'invalid_request', message: error.message } };
    }
    return accessPersistenceFailure(
      error,
      'Access credential pairing preparation outcome is unknown',
      'Access credential pairing could not begin',
    );
  }
}

export async function prepareAccessCredentialRotation(
  authority: RuntimeHostAccessAuthority | undefined,
  input: AccessCredentialRotationPrepareInput,
): Promise<OperationOutcome<'access.credential.rotation.prepare'>> {
  if (!authority) return unavailable('rotation.prepare');
  try {
    return { ok: true, result: await authority.prepareRotation(input) };
  } catch (error) {
    if (error instanceof RuntimeHostAccessInputError) {
      return { ok: false, error: { code: 'invalid_request', message: error.message } };
    }
    return accessPersistenceFailure(
      error,
      'Access credential rotation preparation outcome is unknown',
      'Access credential rotation could not begin',
    );
  }
}

export async function revokeAccessCredential(
  authority: RuntimeHostAccessAuthority | undefined,
  input: AccessCredentialRevokeInput,
): Promise<OperationOutcome<'access.credential.revoke'>> {
  if (!authority) return unavailable('revoke');
  try {
    return { ok: true, result: await authority.revoke(input) };
  } catch (error) {
    if (error instanceof RuntimeHostAccessInputError) {
      return { ok: false, error: { code: 'invalid_request', message: error.message } };
    }
    return accessPersistenceFailure(
      error,
      'Access credential revocation outcome is unknown',
      'Access credential could not be revoked',
    );
  }
}

export async function revokeAccessPrincipal(
  authority: RuntimeHostAccessAuthority | undefined,
  input: AccessPrincipalRevokeInput,
): Promise<OperationOutcome<'access.principal.revoke'>> {
  if (!authority) return unavailable('principal.revoke');
  try {
    return { ok: true, result: await authority.revokePrincipal(input) };
  } catch (error) {
    return accessPersistenceFailure(
      error,
      'Access principal revocation outcome is unknown',
      'Access principal could not be revoked',
    );
  }
}

export async function revokeAccessCredentialRotation(
  authority: RuntimeHostAccessAuthority | undefined,
  input: AccessCredentialRotationRevokeInput,
): Promise<OperationOutcome<'access.credential.rotation.revoke'>> {
  if (!authority) return unavailable('rotation.revoke');
  try {
    return { ok: true, result: await authority.revokeRotation(input) };
  } catch (error) {
    if (error instanceof RuntimeHostAccessInputError) {
      return { ok: false, error: { code: 'invalid_request', message: error.message } };
    }
    return accessPersistenceFailure(
      error,
      'Access credential rotation revocation outcome is unknown',
      'Access credential could not be revoked',
    );
  }
}

export async function finalizeAccessCredential(
  authority: RuntimeHostAccessAuthority | undefined,
  credentialId: string | undefined,
  clientInstanceId: string | undefined,
): Promise<OperationOutcome<'access.credential.finalize'>> {
  if (!authority) return unavailable('finalize');
  if (!credentialId) {
    return {
      ok: false,
      error: { code: 'invalid_request', message: 'A remote access credential is required' },
    };
  }
  if (!clientInstanceId) {
    return {
      ok: false,
      error: { code: 'invalid_request', message: 'A Client identity is required' },
    };
  }
  try {
    return { ok: true, result: await authority.finalize(credentialId, clientInstanceId) };
  } catch (error) {
    if (error instanceof RuntimeHostAccessInputError) {
      return { ok: false, error: { code: 'invalid_request', message: error.message } };
    }
    return accessPersistenceFailure(
      error,
      'Access credential pairing finalization outcome is unknown',
      'Access credential pairing could not be finalized',
    );
  }
}

export async function prepareCollaborationInvitation(
  authority: RuntimeHostAccessAuthority | undefined,
  rootId: string,
  input: CollaborationInvitationPrepareInput,
): Promise<OperationOutcome<'collaboration.invitation.prepare'>> {
  if (!authority) return collaborationUnavailable('collaboration.invitation.prepare');
  try {
    return { ok: true, result: await authority.prepareCollaborationInvitation(rootId, input) };
  } catch (error) {
    if (error instanceof RuntimeHostAccessInputError) {
      return { ok: false, error: { code: 'invalid_request', message: error.message } };
    }
    return accessPersistenceFailure(
      error,
      'Collaboration invitation outcome is unknown',
      'Collaboration invitation could not be created',
    );
  }
}

export async function revokeCollaborationGrant(
  authority: RuntimeHostAccessAuthority | undefined,
  input: CollaborationGrantRevokeInput,
): Promise<OperationOutcome<'collaboration.grant.revoke'>> {
  if (!authority) return collaborationUnavailable('collaboration.grant.revoke');
  try {
    return { ok: true, result: await authority.revokeCollaborationGrant(input) };
  } catch (error) {
    return accessPersistenceFailure(
      error,
      'Collaboration grant revocation outcome is unknown',
      'Collaboration grant could not be revoked',
    );
  }
}

export async function revokeCollaborationPrincipal(
  authority: RuntimeHostAccessAuthority | undefined,
  principalId: string,
): Promise<OperationOutcome<'collaboration.principal.revoke'>> {
  if (!authority) return collaborationUnavailable('collaboration.principal.revoke');
  try {
    return { ok: true, result: await authority.revokeCollaborationPrincipal(principalId) };
  } catch (error) {
    return accessPersistenceFailure(
      error,
      'Collaboration Guest revocation outcome is unknown',
      'Collaboration Guest could not be revoked',
    );
  }
}

function collaborationUnavailable<
  K extends
    | 'collaboration.invitation.prepare'
    | 'collaboration.grant.revoke'
    | 'collaboration.principal.revoke',
>(operation: K): OperationOutcome<K> {
  return {
    ok: false,
    error: {
      code: 'operation_unavailable',
      message: 'Runtime Host collaboration authority is unavailable',
    },
  } as OperationOutcome<K>;
}

function accessPersistenceFailure(error: unknown, unknownMessage: string, failureMessage: string) {
  return {
    ok: false as const,
    error:
      error instanceof RuntimeHostAccessCommitOutcomeUnknownError
        ? { code: 'commit_outcome_unknown' as const, message: unknownMessage }
        : { code: 'persistence_failed' as const, message: failureMessage },
  };
}

function unavailable(operation: 'issue'): OperationOutcome<'access.credential.issue'>;
function unavailable(operation: 'replace'): OperationOutcome<'access.credential.replace'>;
function unavailable(operation: 'prepare'): OperationOutcome<'access.credential.prepare'>;
function unavailable(operation: 'revoke'): OperationOutcome<'access.credential.revoke'>;
function unavailable(operation: 'principal.revoke'): OperationOutcome<'access.principal.revoke'>;
function unavailable(
  operation: 'rotation.prepare',
): OperationOutcome<'access.credential.rotation.prepare'>;
function unavailable(
  operation: 'rotation.revoke',
): OperationOutcome<'access.credential.rotation.revoke'>;
function unavailable(operation: 'finalize'): OperationOutcome<'access.credential.finalize'>;
function unavailable(
  _operation:
    | 'issue'
    | 'replace'
    | 'prepare'
    | 'revoke'
    | 'principal.revoke'
    | 'rotation.prepare'
    | 'rotation.revoke'
    | 'finalize',
):
  | OperationOutcome<'access.credential.issue'>
  | OperationOutcome<'access.credential.replace'>
  | OperationOutcome<'access.credential.prepare'>
  | OperationOutcome<'access.credential.revoke'>
  | OperationOutcome<'access.principal.revoke'>
  | OperationOutcome<'access.credential.rotation.prepare'>
  | OperationOutcome<'access.credential.rotation.revoke'>
  | OperationOutcome<'access.credential.finalize'> {
  return {
    ok: false,
    error: {
      code: 'operation_unavailable',
      message: 'Runtime Host access credentials are unavailable in this composition',
    },
  };
}
