import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import {
  type AccessCredentialIssueInput,
  type AccessCredentialIssueResult,
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
  RuntimeHostAccessInputError,
  type AccessCredentialFile,
  type StoredAccessCredential,
  writeAccessCredentialFile,
} from './access-credential-store.js';

const ACCESS_CREDENTIAL_PREFIX = 'maka_rh_';
const CAPABILITY_PROVIDER_GRANTS = new Set([
  'host.status',
  'client.capability.replace',
  'client.capability.unregister',
]);

export interface RuntimeHostAccessAuthority {
  authenticate(credential: string): RuntimeHostConnectionAuthority | undefined;
  issue(input: AccessCredentialIssueInput): Promise<AccessCredentialIssueResult>;
  replace(input: AccessCredentialReplaceInput): Promise<AccessCredentialReplaceResult>;
  revoke(input: AccessCredentialRevokeInput): Promise<AccessCredentialRevokeResult>;
  subscribeRevocations(listener: (credentialId: string) => void): () => void;
}

export async function openRuntimeHostAccessAuthority(
  controlDirectory: string,
): Promise<RuntimeHostAccessAuthority> {
  await purgeAccessCredentialDeliveries(controlDirectory);
  const path = join(controlDirectory, ACCESS_FILE_NAME);
  return new FileRuntimeHostAccessAuthority(
    controlDirectory,
    path,
    await readAccessCredentialFile(path),
  );
}

class FileRuntimeHostAccessAuthority implements RuntimeHostAccessAuthority {
  readonly #controlDirectory: string;
  readonly #path: string;
  #file: AccessCredentialFile;
  #mutation = Promise.resolve();
  readonly #revocationListeners = new Set<(credentialId: string) => void>();

  constructor(controlDirectory: string, path: string, file: AccessCredentialFile) {
    this.#controlDirectory = controlDirectory;
    this.#path = path;
    this.#file = file;
  }

  authenticate(credential: string): RuntimeHostConnectionAuthority | undefined {
    const candidate = hashCredential(credential);
    let match: StoredAccessCredential | undefined;
    for (const stored of this.#file.credentials) {
      const storedHash = Buffer.from(stored.credentialHash, 'hex');
      const equal =
        storedHash.byteLength === candidate.byteLength && timingSafeEqual(storedHash, candidate);
      if (equal && stored.status === 'active') match = stored;
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
    return this.#issue(input, false);
  }

  replace(input: AccessCredentialReplaceInput): Promise<AccessCredentialReplaceResult> {
    return this.#issue(input, true);
  }

  #issue(
    input: AccessCredentialIssueInput,
    replacePrincipal: boolean,
  ): Promise<AccessCredentialIssueResult> {
    return this.#mutate(async () => {
      const operationGrants = issuedAccessGrants(input.operationGrants);
      assertCredentialAuthority(input, operationGrants);
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
      const stored: StoredAccessCredential = {
        credentialId,
        credentialHash: hashCredential(credential).toString('hex'),
        principalId: input.principalId,
        principalKind: input.principalKind,
        status: 'active',
        operationGrants,
        canPublishClientCapabilities: input.canPublishClientCapabilities,
        canUseHostPaths: input.canUseHostPaths,
        createdAt: new Date().toISOString(),
      };
      const replaced = replacePrincipal
        ? this.#file.credentials.filter(
            (candidate) =>
              candidate.status === 'active' &&
              candidate.principalKind === input.principalKind &&
              candidate.principalId === input.principalId,
          )
        : [];
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
        await this.#commit(nextFile);
      } catch (error) {
        await discardAccessCredentialDelivery(this.#controlDirectory, deliveryId);
        throw error;
      }
      for (const replacedCredential of replaced) {
        this.#publishRevocation(replacedCredential.credentialId);
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
      const credentials = [...this.#file.credentials];
      credentials[index] = {
        ...credentials[index]!,
        status: 'revoked',
        revokedAt: new Date().toISOString(),
      };
      await this.#commit(createAccessCredentialFile(credentials));
      this.#publishRevocation(input.credentialId);
      return { credentialId: input.credentialId, revoked: true };
    });
  }

  subscribeRevocations(listener: (credentialId: string) => void): () => void {
    this.#revocationListeners.add(listener);
    return () => this.#revocationListeners.delete(listener);
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(operation, operation);
    this.#mutation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #commit(file: AccessCredentialFile): Promise<void> {
    await writeAccessCredentialFile(this.#path, file);
    this.#file = file;
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
    return {
      ok: false,
      error: { code: 'persistence_failed', message: 'Access credential could not be issued' },
    };
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
    return {
      ok: false,
      error: { code: 'persistence_failed', message: 'Access credential could not be replaced' },
    };
  }
}

export async function revokeAccessCredential(
  authority: RuntimeHostAccessAuthority | undefined,
  input: AccessCredentialRevokeInput,
): Promise<OperationOutcome<'access.credential.revoke'>> {
  if (!authority) return unavailable('revoke');
  try {
    return { ok: true, result: await authority.revoke(input) };
  } catch {
    return {
      ok: false,
      error: { code: 'persistence_failed', message: 'Access credential could not be revoked' },
    };
  }
}

function unavailable(operation: 'issue'): OperationOutcome<'access.credential.issue'>;
function unavailable(operation: 'replace'): OperationOutcome<'access.credential.replace'>;
function unavailable(operation: 'revoke'): OperationOutcome<'access.credential.revoke'>;
function unavailable(
  _operation: 'issue' | 'replace' | 'revoke',
):
  | OperationOutcome<'access.credential.issue'>
  | OperationOutcome<'access.credential.replace'>
  | OperationOutcome<'access.credential.revoke'> {
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
