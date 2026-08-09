import { randomUUID } from 'node:crypto';
import { chmod, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';
import { HOST_OPERATION_SPECS, type OperationKey } from '../protocol/index.js';

const ACCESS_FILE_SCHEMA_VERSION = 1;
const ACCESS_FILE_MAX_BYTES = 512 * 1024;

export const ACCESS_FILE_NAME = 'runtime-host-access.json';

export interface StoredAccessCredential {
  readonly credentialId: string;
  readonly credentialHash: string;
  readonly principalId: string;
  readonly status: 'active' | 'revoked';
  readonly operationGrants: readonly OperationKey[];
  readonly canPublishClientCapabilities: boolean;
  readonly canUseHostPaths: boolean;
  readonly createdAt: string;
  readonly revokedAt?: string;
}

export interface AccessCredentialFile {
  readonly schemaVersion: typeof ACCESS_FILE_SCHEMA_VERSION;
  readonly credentials: readonly StoredAccessCredential[];
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

export function createAccessCredentialFile(
  credentials: readonly StoredAccessCredential[],
): AccessCredentialFile {
  return { schemaVersion: ACCESS_FILE_SCHEMA_VERSION, credentials };
}

export function issuedAccessGrants(grants: readonly OperationKey[]): readonly OperationKey[] {
  return validateGrants([...new Set<OperationKey>(['host.status', ...grants])]);
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
  );
  serializeAccessCredentialFile(fullyRevoked);
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
    await syncDirectory(dirname(path));
  } catch (error) {
    await rm(tempPath, { force: true });
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
  if (!isRecord(value) || value.schemaVersion !== ACCESS_FILE_SCHEMA_VERSION) {
    throw new Error('Unsupported Runtime Host access file');
  }
  if (!Array.isArray(value.credentials)) throw new Error('Invalid Runtime Host access file');
  const credentials = value.credentials.map(decodeStoredCredential);
  if (
    new Set(credentials.map((credential) => credential.credentialId)).size !== credentials.length
  ) {
    throw new Error('Duplicate Runtime Host access credential identity');
  }
  return createAccessCredentialFile(credentials);
}

function decodeStoredCredential(value: unknown): StoredAccessCredential {
  if (!isRecord(value)) throw new Error('Invalid Runtime Host access credential');
  const credentialId = requireStoredString(value.credentialId, 'credentialId');
  const credentialHash = requireStoredString(value.credentialHash, 'credentialHash');
  if (!/^[a-f0-9]{64}$/u.test(credentialHash)) throw new Error('Invalid credentialHash');
  const principalId = requireStoredString(value.principalId, 'principalId');
  if (!/^[A-Za-z0-9_.:-]{1,128}$/u.test(principalId)) throw new Error('Invalid principalId');
  if (value.status !== 'active' && value.status !== 'revoked') throw new Error('Invalid status');
  if (!Array.isArray(value.operationGrants)) throw new Error('Invalid operationGrants');
  const rawOperationGrants = value.operationGrants.map((grant) =>
    requireStoredString(grant, 'operationGrant'),
  ) as OperationKey[];
  if (new Set(rawOperationGrants).size !== rawOperationGrants.length) {
    throw new Error('Duplicate Runtime Host access operation grant');
  }
  const operationGrants = validateGrants(rawOperationGrants);
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
  const revokedAt = value.revokedAt;
  if (revokedAt !== undefined && typeof revokedAt !== 'string') {
    throw new Error('Invalid revokedAt');
  }
  return {
    credentialId,
    credentialHash,
    principalId,
    status: value.status,
    operationGrants,
    canPublishClientCapabilities: value.canPublishClientCapabilities,
    canUseHostPaths: value.canUseHostPaths,
    createdAt,
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

function validateGrants(grants: readonly OperationKey[]): readonly OperationKey[] {
  for (const grant of grants) {
    if (!Object.hasOwn(HOST_OPERATION_SPECS, grant)) {
      throw new RuntimeHostAccessInputError(`Unknown Runtime Host operation grant: ${grant}`);
    }
    if (grant === 'access.credential.issue' || grant === 'access.credential.revoke') {
      throw new RuntimeHostAccessInputError('Access credential administration is local-owner only');
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
