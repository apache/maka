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

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
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
  finalize(credentialId: string): Promise<AccessCredentialFinalizeResult>;
  subscribeRevocations(listener: (credentialId: string) => void): () => void;
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
    const candidate = hashCredential(credential);
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
          operationGrants: match.operationGrants,
          canPublishClientCapabilities: match.canPublishClientCapabilities,
          canUseHostPaths: match.canUseHostPaths,
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

  #issue(
    input: AccessCredentialIssueInput,
    mode: 'issue' | 'replace' | 'prepare',
  ): Promise<AccessCredentialIssueResult> {
    return this.#mutate(async () => {
      const operationGrants = issuedAccessGrants(input.operationGrants);
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
        credentialHash: hashCredential(credential).toString('hex'),
        principalId: input.principalId,
        principalKind: input.principalKind,
        status: mode === 'prepare' ? 'pending' : 'active',
        operationGrants,
        canPublishClientCapabilities: input.canPublishClientCapabilities,
        canUseHostPaths: input.canUseHostPaths,
        createdAt: createdAt.toISOString(),
        ...(mode === 'prepare'
          ? {
              expiresAt: new Date(
                createdAt.getTime() + PENDING_CREDENTIAL_LIFETIME_MS,
              ).toISOString(),
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
      const nextFile = createAccessCredentialFile([...retained, stored]);
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
        principalKind: stored.principalKind,
        operationGrants,
        canPublishClientCapabilities: stored.canPublishClientCapabilities,
        canUseHostPaths: stored.canUseHostPaths,
      };
    });
  }

  revoke(input: AccessCredentialRevokeInput): Promise<AccessCredentialRevokeResult> {
    return this.#mutate(async () => {
      const index = this.#file.credentials.findIndex(
        (credential) => credential.credentialId === input.credentialId,
      );
      if (index === -1 || this.#file.credentials[index]?.status === 'revoked') {
        return { credentialId: input.credentialId, revoked: false };
      }
      const current = this.#file.credentials[index]!;
      const credentials =
        current.status === 'pending'
          ? this.#file.credentials.filter((credential) => credential !== current)
          : this.#file.credentials.map((credential, candidateIndex) =>
              candidateIndex === index
                ? { ...credential, status: 'revoked' as const, revokedAt: new Date().toISOString() }
                : credential,
            );
      await this.#commit(createAccessCredentialFile(credentials), [input.credentialId]);
      return { credentialId: input.credentialId, revoked: true };
    });
  }

  finalize(credentialId: string): Promise<AccessCredentialFinalizeResult> {
    return this.#mutate(async () => {
      const retained = this.#file.credentials.find(
        (credential) => credential.credentialId === credentialId,
      );
      if (!retained || retained.status === 'revoked') {
        throw new RuntimeHostAccessInputError('The current access credential is no longer active');
      }
      if (retained.status === 'active') return {};
      if (Date.parse(retained.expiresAt!) <= Date.now()) {
        await this.#expirePending();
        throw new RuntimeHostAccessInputError('The pairing candidate has expired');
      }
      const revoked = this.#file.credentials.filter(
        (credential) =>
          credential.credentialId !== credentialId &&
          credential.status === 'active' &&
          credential.principalKind === retained.principalKind &&
          credential.principalId === retained.principalId,
      );
      const finalized = createAccessCredentialFile(
        this.#file.credentials
          .filter((credential) => !revoked.includes(credential))
          .map((credential) =>
            credential === retained ? activatePendingCredential(credential) : credential,
          ),
      );
      await this.#commit(
        finalized,
        revoked.map((credential) => credential.credentialId),
      );
      return {};
    });
  }

  subscribeRevocations(listener: (credentialId: string) => void): () => void {
    if (this.#closed) return () => undefined;
    this.#revocationListeners.add(listener);
    return () => this.#revocationListeners.delete(listener);
  }

  close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
      this.#expiryTimer = undefined;
      this.#revocationListeners.clear();
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
    await this.#commit(
      createAccessCredentialFile(
        this.#file.credentials.filter((credential) => !expired.includes(credential)),
      ),
      expired.map((credential) => credential.credentialId),
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
}

function activatePendingCredential(credential: StoredAccessCredential): StoredAccessCredential {
  const { expiresAt: _expiresAt, ...retained } = credential;
  return { ...retained, status: 'active' };
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

export async function revokeAccessCredential(
  authority: RuntimeHostAccessAuthority | undefined,
  input: AccessCredentialRevokeInput,
): Promise<OperationOutcome<'access.credential.revoke'>> {
  if (!authority) return unavailable('revoke');
  try {
    return { ok: true, result: await authority.revoke(input) };
  } catch (error) {
    return accessPersistenceFailure(
      error,
      'Access credential revocation outcome is unknown',
      'Access credential could not be revoked',
    );
  }
}

export async function finalizeAccessCredential(
  authority: RuntimeHostAccessAuthority | undefined,
  credentialId: string | undefined,
): Promise<OperationOutcome<'access.credential.finalize'>> {
  if (!authority) return unavailable('finalize');
  if (!credentialId) {
    return {
      ok: false,
      error: { code: 'invalid_request', message: 'A remote access credential is required' },
    };
  }
  try {
    return { ok: true, result: await authority.finalize(credentialId) };
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
function unavailable(operation: 'finalize'): OperationOutcome<'access.credential.finalize'>;
function unavailable(
  _operation: 'issue' | 'replace' | 'prepare' | 'revoke' | 'finalize',
):
  | OperationOutcome<'access.credential.issue'>
  | OperationOutcome<'access.credential.replace'>
  | OperationOutcome<'access.credential.prepare'>
  | OperationOutcome<'access.credential.revoke'>
  | OperationOutcome<'access.credential.finalize'> {
  return {
    ok: false,
    error: {
      code: 'operation_unavailable',
      message: 'Runtime Host access credentials are unavailable in this composition',
    },
  };
}

function hashCredential(credential: string): Buffer {
  return createHash('sha256').update(credential, 'utf8').digest();
}
