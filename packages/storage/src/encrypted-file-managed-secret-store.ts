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

import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { syncDirectory } from './stable-storage.js';
import {
  decodeManagedSecretReference,
  MANAGED_SECRET_MAX_VALUE_BYTES,
  managedSecretIdentifier,
  managedSecretReference,
  managedSecretRevision,
  managedSecretTimestamp,
  managedSecretValue,
  ManagedSecretError,
  publicManagedSecretMetadata,
  type AuthorizeManagedSecretSessionInput,
  type CreateManagedSecretInput,
  type GetManagedSecretMetadataInput,
  type ManagedSecretActivationContext,
  type ManagedSecretMaterial,
  type ManagedSecretMetadata,
  type ManagedSecretMutationResult,
  type ManagedSecretReference,
  type ManagedSecretStatus,
  type ManagedSecretStore,
  type MutateManagedSecretInput,
  type ResolveManagedSecretsForActivationInput,
  type RotateManagedSecretInput,
} from './managed-secret-store.js';

export const MANAGED_SECRET_DOCUMENT_SCHEMA_VERSION = 1 as const;
export const MANAGED_SECRET_DOCUMENT_FILE = 'managed-secrets.json';

const DOCUMENT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_SECRET_RECORDS = 2_048;
const MAX_GRANTS = 8_192;
const LOCK_POLL_MS = 25;
const LOCK_TIMEOUT_MS = 10_000;

/**
 * Raw AES material used only by the encrypted-file reference backend. This is
 * deliberately not a general KMS/HSM interface; production providers may keep
 * master keys non-exportable behind opaque envelope operations.
 */
export interface EncryptedFileManagedSecretKey {
  readonly keyId: string;
  /** Exactly 32 bytes. The provider, not the persisted store, owns this key. */
  readonly key: Uint8Array;
}

export interface EncryptedFileManagedSecretKeyProvider {
  activeKey(): Promise<EncryptedFileManagedSecretKey>;
  keyById(keyId: string): Promise<EncryptedFileManagedSecretKey | null>;
}

export interface EncryptedFileManagedSecretStoreOptions {
  /** A control-plane/config root that is outside Session-owned portable state. */
  readonly controlPlaneRoot: string;
  readonly keyProvider: EncryptedFileManagedSecretKeyProvider;
  readonly now?: () => number;
  readonly newSecretId?: () => string;
}

interface EncryptedSecretEnvelope {
  readonly algorithm: 'A256GCM';
  readonly keyId: string;
  readonly iv: string;
  readonly ciphertext: string;
  readonly tag: string;
}

interface StoredSecretRecord {
  readonly secretId: string;
  readonly ownerPrincipalId: string;
  readonly revision: number;
  readonly status: Exclude<ManagedSecretStatus, 'deleted'>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly envelope?: EncryptedSecretEnvelope;
}

interface StoredSecretGrant {
  readonly secretId: string;
  readonly ownerPrincipalId: string;
  readonly cloudSessionId: string;
  readonly createdAt: number;
}

interface ManagedSecretDocument {
  readonly schemaVersion: typeof MANAGED_SECRET_DOCUMENT_SCHEMA_VERSION;
  readonly revision: number;
  readonly secrets: readonly StoredSecretRecord[];
  readonly grants: readonly StoredSecretGrant[];
}

interface NormalizedAuthorization {
  readonly principalId: string;
  readonly reference: ManagedSecretReference;
  readonly cloudSessionId: string;
}

export function createEncryptedFileManagedSecretStore(
  options: EncryptedFileManagedSecretStoreOptions,
): ManagedSecretStore {
  return new EncryptedFileManagedSecretStore(options);
}

/**
 * Local/control-plane reference backend. The value store contains only
 * AES-256-GCM envelopes; key material is supplied out-of-band and never
 * serialized beside those envelopes.
 */
class EncryptedFileManagedSecretStore implements ManagedSecretStore {
  readonly #path: string;
  readonly #keyProvider: EncryptedFileManagedSecretKeyProvider;
  readonly #now: () => number;
  readonly #newSecretId: () => string;

  constructor(options: EncryptedFileManagedSecretStoreOptions) {
    this.#path = join(options.controlPlaneRoot, MANAGED_SECRET_DOCUMENT_FILE);
    this.#keyProvider = options.keyProvider;
    this.#now = options.now ?? Date.now;
    this.#newSecretId = options.newSecretId ?? randomUUID;
  }

  createSecret(input: CreateManagedSecretInput): Promise<ManagedSecretMetadata> {
    const principalId = managedSecretIdentifier(input.principalId, 'principalId');
    const value = managedSecretValue(input.value);
    return this.#locked(async (document) => {
      if (document.secrets.length >= MAX_SECRET_RECORDS) {
        throw new ManagedSecretError('storage_failure', 'Managed Secret record limit reached');
      }
      const reference = decodeManagedSecretReference(managedSecretReference(this.#newSecretId()));
      if (document.secrets.some((record) => record.secretId === reference.secretId)) {
        throw new ManagedSecretError('storage_failure', 'Managed Secret identity collision');
      }
      const now = managedSecretTimestamp(this.#now());
      const envelope = await sealSecret(this.#keyProvider, {
        reference,
        ownerPrincipalId: principalId,
        revision: 1,
        value,
      });
      const record: StoredSecretRecord = {
        secretId: reference.secretId,
        ownerPrincipalId: principalId,
        revision: 1,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        envelope,
      };
      await this.#write({
        ...document,
        revision: document.revision + 1,
        secrets: [...document.secrets, record],
      });
      return metadata(record);
    });
  }

  getSecretMetadata(input: GetManagedSecretMetadataInput): Promise<ManagedSecretMetadata | null> {
    const principal = managedSecretIdentifier(input.principalId, 'principalId');
    const normalized = decodeManagedSecretReference(input.reference);
    return this.#locked(async (document) => {
      const record = document.secrets.find((item) => item.secretId === normalized.secretId);
      if (!record) return null;
      assertOwner(record, principal);
      return metadata(record);
    });
  }

  rotateSecret(input: RotateManagedSecretInput): Promise<ManagedSecretMutationResult> {
    const normalized = normalizeMutation(input);
    const value = managedSecretValue(input.value);
    return this.#locked(async (document) => {
      const prepared = prepareMutation(document, normalized);
      if (prepared.kind === 'revision_conflict') return prepared;
      assertActive(prepared.record);
      const revision = prepared.record.revision + 1;
      const next: StoredSecretRecord = {
        ...prepared.record,
        revision,
        updatedAt: mutationTimestamp(prepared.record, this.#now()),
        envelope: await sealSecret(this.#keyProvider, {
          reference: normalized.reference,
          ownerPrincipalId: normalized.principalId,
          revision,
          value,
        }),
      };
      await this.#replaceSecret(document, prepared.index, next);
      return { kind: 'committed', secret: metadata(next) };
    });
  }

  revokeSecret(input: MutateManagedSecretInput): Promise<ManagedSecretMutationResult> {
    const normalized = normalizeMutation(input);
    return this.#locked(async (document) => {
      const prepared = prepareMutation(document, normalized);
      if (prepared.kind === 'revision_conflict') return prepared;
      assertActive(prepared.record);
      const next: StoredSecretRecord = {
        secretId: prepared.record.secretId,
        ownerPrincipalId: prepared.record.ownerPrincipalId,
        revision: prepared.record.revision + 1,
        status: 'revoked',
        createdAt: prepared.record.createdAt,
        updatedAt: mutationTimestamp(prepared.record, this.#now()),
      };
      await this.#replaceSecret(document, prepared.index, next);
      return { kind: 'committed', secret: metadata(next) };
    });
  }

  deleteSecret(input: MutateManagedSecretInput): Promise<ManagedSecretMutationResult> {
    const normalized = normalizeMutation(input);
    return this.#locked(async (document) => {
      const prepared = prepareMutation(document, normalized);
      if (prepared.kind === 'revision_conflict') return prepared;
      const deleted = publicManagedSecretMetadata({
        reference: managedSecretReference(prepared.record.secretId),
        ownerPrincipalId: prepared.record.ownerPrincipalId,
        revision: prepared.record.revision + 1,
        status: 'deleted',
        createdAt: prepared.record.createdAt,
        updatedAt: mutationTimestamp(prepared.record, this.#now()),
      });
      await this.#write({
        ...document,
        revision: document.revision + 1,
        secrets: document.secrets.filter((_, index) => index !== prepared.index),
        grants: document.grants.filter((grant) => grant.secretId !== deleted.reference.secretId),
      });
      return { kind: 'committed', secret: deleted };
    });
  }

  authorizeSession(input: AuthorizeManagedSecretSessionInput): Promise<void> {
    const normalized = normalizeAuthorization(input);
    return this.#locked(async (document) => {
      const record = requiredRecord(document, normalized.reference);
      assertOwner(record, normalized.principalId);
      assertActive(record);
      if (findGrant(document, normalized)) return;
      if (document.grants.length >= MAX_GRANTS) {
        throw new ManagedSecretError('storage_failure', 'Managed Secret grant limit reached');
      }
      await this.#write({
        ...document,
        revision: document.revision + 1,
        grants: [
          ...document.grants,
          {
            secretId: normalized.reference.secretId,
            ownerPrincipalId: normalized.principalId,
            cloudSessionId: normalized.cloudSessionId,
            createdAt: managedSecretTimestamp(this.#now()),
          },
        ],
      });
    });
  }

  revokeSessionAuthorization(input: AuthorizeManagedSecretSessionInput): Promise<void> {
    const normalized = normalizeAuthorization(input);
    return this.#locked(async (document) => {
      const record = requiredRecord(document, normalized.reference);
      assertOwner(record, normalized.principalId);
      const next = document.grants.filter((grant) => !sameGrant(grant, normalized));
      if (next.length === document.grants.length) return;
      await this.#write({ ...document, revision: document.revision + 1, grants: next });
    });
  }

  resolveForActivation(
    input: ResolveManagedSecretsForActivationInput,
  ): Promise<readonly ManagedSecretMaterial[]> {
    const context = normalizeActivationContext(input.context);
    if (!Array.isArray(input.references) || input.references.length > 128) {
      throw new ManagedSecretError(
        'invalid_input',
        'Managed Secret references must be a bounded array',
      );
    }
    const references = input.references.map(decodeManagedSecretReference);
    return this.#locked(async (document) => {
      const selected = references.map((reference) => {
        const record = requiredRecord(document, reference);
        assertOwner(record, context.principalId);
        assertActive(record);
        if (!findGrant(document, { ...context, reference })) {
          throw new ManagedSecretError(
            'unauthorized',
            'Managed Secret is not authorized for this Cloud Session',
          );
        }
        if (!record.envelope) {
          throw new ManagedSecretError(
            'integrity_failure',
            'Managed Secret envelope is unavailable',
          );
        }
        return { reference, record };
      });

      const material: ManagedSecretMaterial[] = [];
      for (const item of selected) {
        material.push({
          reference: { ...item.reference },
          revision: item.record.revision,
          value: await openSecret(this.#keyProvider, item.record),
        });
      }
      return material;
    });
  }

  #replaceSecret(
    document: ManagedSecretDocument,
    index: number,
    record: StoredSecretRecord,
  ): Promise<void> {
    const secrets = [...document.secrets];
    secrets[index] = record;
    return this.#write({ ...document, revision: document.revision + 1, secrets });
  }

  #locked<T>(operation: (document: ManagedSecretDocument) => Promise<T>): Promise<T> {
    return withManagedSecretFileLock(this.#path, async () =>
      operation(await readDocument(this.#path)),
    );
  }

  #write(document: ManagedSecretDocument): Promise<void> {
    return writeDocument(this.#path, decodeDocument(document));
  }
}

async function sealSecret(
  provider: EncryptedFileManagedSecretKeyProvider,
  input: {
    reference: ManagedSecretReference;
    ownerPrincipalId: string;
    revision: number;
    value: string;
  },
): Promise<EncryptedSecretEnvelope> {
  let material: EncryptedFileManagedSecretKey;
  try {
    material = await provider.activeKey();
  } catch {
    throw new ManagedSecretError('key_unavailable', 'Managed Secret encryption key is unavailable');
  }
  const keyId = managedSecretIdentifier(material.keyId, 'keyId');
  const key = encryptionKey(material);
  const iv = randomBytes(12);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(aad(input.reference, input.ownerPrincipalId, input.revision));
    const ciphertext = Buffer.concat([cipher.update(input.value, 'utf8'), cipher.final()]);
    return {
      algorithm: 'A256GCM',
      keyId,
      iv: iv.toString('base64url'),
      ciphertext: ciphertext.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
    };
  } catch (error) {
    if (error instanceof ManagedSecretError) throw error;
    throw new ManagedSecretError('integrity_failure', 'Managed Secret encryption failed', {
      cause: error,
    });
  } finally {
    key.fill(0);
  }
}

async function openSecret(
  provider: EncryptedFileManagedSecretKeyProvider,
  record: StoredSecretRecord,
): Promise<string> {
  const envelope = record.envelope;
  if (!envelope) {
    throw new ManagedSecretError('integrity_failure', 'Managed Secret envelope is unavailable');
  }
  let material: EncryptedFileManagedSecretKey | null;
  try {
    material = await provider.keyById(envelope.keyId);
  } catch {
    throw new ManagedSecretError('key_unavailable', 'Managed Secret encryption key is unavailable');
  }
  if (!material || material.keyId !== envelope.keyId) {
    throw new ManagedSecretError('key_unavailable', 'Managed Secret encryption key is unavailable');
  }
  const key = encryptionKey(material);
  try {
    const iv = decodeBase64Url(envelope.iv, 12, 'initialization vector');
    const tag = decodeBase64Url(envelope.tag, 16, 'authentication tag');
    const ciphertext = decodeBase64Url(envelope.ciphertext, undefined, 'ciphertext');
    if (ciphertext.length === 0 || ciphertext.length > MANAGED_SECRET_MAX_VALUE_BYTES) {
      throw new ManagedSecretError('integrity_failure', 'Managed Secret ciphertext is invalid');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    decipher.setAAD(
      aad(managedSecretReference(record.secretId), record.ownerPrincipalId, record.revision),
    );
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    } finally {
      plaintext.fill(0);
    }
  } catch (error) {
    if (error instanceof ManagedSecretError) throw error;
    throw new ManagedSecretError('integrity_failure', 'Managed Secret authentication failed', {
      cause: error,
    });
  } finally {
    key.fill(0);
  }
}

function encryptionKey(material: EncryptedFileManagedSecretKey): Buffer {
  managedSecretIdentifier(material.keyId, 'keyId');
  if (!(material.key instanceof Uint8Array) || material.key.byteLength !== 32) {
    throw new ManagedSecretError(
      'key_unavailable',
      'Managed Secret encryption key must contain 32 bytes',
    );
  }
  return Buffer.from(material.key);
}

function aad(reference: ManagedSecretReference, principalId: string, revision: number): Buffer {
  return Buffer.from(
    `maka-managed-secret/v1\0${reference.secretId}\0${principalId}\0${revision}`,
    'utf8',
  );
}

function decodeBase64Url(value: string, expectedBytes: number | undefined, field: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) {
    throw new ManagedSecretError('integrity_failure', `Managed Secret ${field} is invalid`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (
    bytes.toString('base64url') !== value ||
    (expectedBytes !== undefined && bytes.length !== expectedBytes)
  ) {
    throw new ManagedSecretError('integrity_failure', `Managed Secret ${field} is invalid`);
  }
  return bytes;
}

function normalizeMutation(input: MutateManagedSecretInput) {
  return {
    principalId: managedSecretIdentifier(input.principalId, 'principalId'),
    reference: decodeManagedSecretReference(input.reference),
    expectedRevision: managedSecretRevision(input.expectedRevision),
  };
}

function normalizeAuthorization(
  input: AuthorizeManagedSecretSessionInput,
): NormalizedAuthorization {
  return {
    principalId: managedSecretIdentifier(input.principalId, 'principalId'),
    reference: decodeManagedSecretReference(input.reference),
    cloudSessionId: managedSecretIdentifier(input.cloudSessionId, 'cloudSessionId'),
  };
}

function normalizeActivationContext(
  context: ManagedSecretActivationContext,
): ManagedSecretActivationContext {
  return {
    principalId: managedSecretIdentifier(context.principalId, 'principalId'),
    cloudSessionId: managedSecretIdentifier(context.cloudSessionId, 'cloudSessionId'),
    activationId: managedSecretIdentifier(context.activationId, 'activationId'),
  };
}

function prepareMutation(
  document: ManagedSecretDocument,
  input: ReturnType<typeof normalizeMutation>,
):
  | { readonly kind: 'ready'; readonly index: number; readonly record: StoredSecretRecord }
  | Extract<ManagedSecretMutationResult, { kind: 'revision_conflict' }> {
  const index = document.secrets.findIndex(
    (record) => record.secretId === input.reference.secretId,
  );
  const record = index < 0 ? undefined : document.secrets[index];
  if (!record) {
    throw new ManagedSecretError('secret_not_found', 'Managed Secret was not found');
  }
  assertOwner(record, input.principalId);
  if (record.revision !== input.expectedRevision) {
    return { kind: 'revision_conflict', actualRevision: record.revision };
  }
  return { kind: 'ready', index, record };
}

function requiredRecord(
  document: ManagedSecretDocument,
  reference: ManagedSecretReference,
): StoredSecretRecord {
  const record = document.secrets.find((item) => item.secretId === reference.secretId);
  if (!record) {
    throw new ManagedSecretError('secret_not_found', 'Managed Secret was not found');
  }
  return record;
}

function assertOwner(record: StoredSecretRecord, principalId: string): void {
  if (record.ownerPrincipalId !== principalId) {
    throw new ManagedSecretError('unauthorized', 'Managed Secret access is not authorized');
  }
}

function assertActive(record: StoredSecretRecord): void {
  if (record.status !== 'active') {
    throw new ManagedSecretError('secret_revoked', 'Managed Secret is revoked');
  }
}

function metadata(record: StoredSecretRecord): ManagedSecretMetadata {
  return publicManagedSecretMetadata({
    reference: managedSecretReference(record.secretId),
    ownerPrincipalId: record.ownerPrincipalId,
    revision: record.revision,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  });
}

function findGrant(
  document: ManagedSecretDocument,
  input: NormalizedAuthorization,
): StoredSecretGrant | undefined {
  return document.grants.find((grant) => sameGrant(grant, input));
}

function sameGrant(grant: StoredSecretGrant, input: NormalizedAuthorization): boolean {
  return (
    grant.secretId === input.reference.secretId &&
    grant.ownerPrincipalId === input.principalId &&
    grant.cloudSessionId === input.cloudSessionId
  );
}

function mutationTimestamp(record: Pick<StoredSecretRecord, 'updatedAt'>, now: number): number {
  return Math.max(record.updatedAt, managedSecretTimestamp(now));
}

async function readDocument(path: string): Promise<ManagedSecretDocument> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const flags =
      process.platform === 'win32'
        ? fsConstants.O_RDONLY
        : fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
    try {
      handle = await open(path, flags);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyDocument();
      throw error;
    }
    const info = await handle.stat();
    if (!info.isFile() || info.size > DOCUMENT_MAX_BYTES) {
      throw new ManagedSecretError('integrity_failure', 'Managed Secret document is invalid');
    }
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) await handle.chmod(0o600);
    const buffer = Buffer.alloc(info.size + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead !== info.size) {
      throw new ManagedSecretError(
        'integrity_failure',
        'Managed Secret document changed while read',
      );
    }
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead)),
      );
    } catch (error) {
      throw new ManagedSecretError('integrity_failure', 'Managed Secret document is invalid', {
        cause: error,
      });
    }
    return decodeDocument(value);
  } catch (error) {
    if (error instanceof ManagedSecretError) throw error;
    throw new ManagedSecretError('storage_failure', 'Managed Secret document could not be read', {
      cause: error,
    });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function writeDocument(path: string, document: ManagedSecretDocument): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
  if (bytes.length > DOCUMENT_MAX_BYTES) {
    throw new ManagedSecretError('storage_failure', 'Managed Secret document limit reached');
  }
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let published = false;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    published = true;
    await syncDirectory(dirname(path));
  } catch (error) {
    throw new ManagedSecretError(
      'storage_failure',
      published
        ? 'Managed Secret commit outcome is unknown; reload before retrying'
        : 'Managed Secret document could not be written',
      { cause: error },
    );
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function withManagedSecretFileLock<T>(
  targetPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const root = dirname(targetPath);
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(root, 0o700);
  } catch (error) {
    throw new ManagedSecretError('storage_failure', 'Managed Secret root is unavailable', {
      cause: error,
    });
  }
  const lockPath = `${targetPath}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw new ManagedSecretError('storage_failure', 'Managed Secret lock failed', {
          cause: error,
        });
      }
      if (Date.now() >= deadline) {
        throw new ManagedSecretError(
          'storage_failure',
          'Managed Secret store is locked; remove the abandoned lock only after confirming no owner is active',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
  let result: T | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    await rm(lockPath, { recursive: true, force: true });
  } catch (error) {
    cleanupError = error;
  }
  if (operationFailed && cleanupError !== undefined) {
    throw new ManagedSecretError(
      'storage_failure',
      'Managed Secret operation failed and lock cleanup was incomplete',
    );
  }
  if (operationFailed) throw operationError;
  if (cleanupError !== undefined) {
    throw new ManagedSecretError('storage_failure', 'Managed Secret lock cleanup failed', {
      cause: cleanupError,
    });
  }
  return result as T;
}

function decodeDocument(value: unknown): ManagedSecretDocument {
  const document = exactRecord(value, ['schemaVersion', 'revision', 'secrets', 'grants']);
  if (document.schemaVersion !== MANAGED_SECRET_DOCUMENT_SCHEMA_VERSION) {
    throw new ManagedSecretError(
      'integrity_failure',
      'Managed Secret document schema is unsupported',
    );
  }
  if (!Number.isSafeInteger(document.revision) || (document.revision as number) < 0) {
    throw invalidDocument();
  }
  if (!Array.isArray(document.secrets) || document.secrets.length > MAX_SECRET_RECORDS) {
    throw invalidDocument();
  }
  if (!Array.isArray(document.grants) || document.grants.length > MAX_GRANTS) {
    throw invalidDocument();
  }
  const secrets = document.secrets.map(decodeStoredSecret);
  const grants = document.grants.map(decodeStoredGrant);
  if (new Set(secrets.map((record) => record.secretId)).size !== secrets.length) {
    throw invalidDocument();
  }
  const secretById = new Map(secrets.map((record) => [record.secretId, record]));
  const grantKeys = new Set<string>();
  for (const grant of grants) {
    const record = secretById.get(grant.secretId);
    if (!record || record.ownerPrincipalId !== grant.ownerPrincipalId) {
      throw invalidDocument();
    }
    const key = `${grant.secretId}\0${grant.ownerPrincipalId}\0${grant.cloudSessionId}`;
    if (grantKeys.has(key)) throw invalidDocument();
    grantKeys.add(key);
  }
  return {
    schemaVersion: MANAGED_SECRET_DOCUMENT_SCHEMA_VERSION,
    revision: document.revision as number,
    secrets,
    grants,
  };
}

function decodeStoredSecret(value: unknown): StoredSecretRecord {
  const record = exactRecord(
    value,
    ['secretId', 'ownerPrincipalId', 'revision', 'status', 'createdAt', 'updatedAt'],
    ['envelope'],
  );
  const reference = decodeManagedSecretReference(managedSecretReference(asString(record.secretId)));
  const ownerPrincipalId = managedSecretIdentifier(record.ownerPrincipalId, 'ownerPrincipalId');
  const revision = managedSecretRevision(record.revision);
  const createdAt = managedSecretTimestamp(record.createdAt);
  const updatedAt = managedSecretTimestamp(record.updatedAt);
  if (updatedAt < createdAt) throw invalidDocument();
  if (record.status !== 'active' && record.status !== 'revoked') {
    throw invalidDocument();
  }
  const envelope = record.envelope === undefined ? undefined : decodeEnvelope(record.envelope);
  if ((record.status === 'active') !== (envelope !== undefined)) throw invalidDocument();
  return {
    secretId: reference.secretId,
    ownerPrincipalId,
    revision,
    status: record.status,
    createdAt,
    updatedAt,
    ...(envelope ? { envelope } : {}),
  };
}

function decodeStoredGrant(value: unknown): StoredSecretGrant {
  const grant = exactRecord(value, ['secretId', 'ownerPrincipalId', 'cloudSessionId', 'createdAt']);
  const reference = decodeManagedSecretReference(managedSecretReference(asString(grant.secretId)));
  return {
    secretId: reference.secretId,
    ownerPrincipalId: managedSecretIdentifier(grant.ownerPrincipalId, 'ownerPrincipalId'),
    cloudSessionId: managedSecretIdentifier(grant.cloudSessionId, 'cloudSessionId'),
    createdAt: managedSecretTimestamp(grant.createdAt),
  };
}

function decodeEnvelope(value: unknown): EncryptedSecretEnvelope {
  const envelope = exactRecord(value, ['algorithm', 'keyId', 'iv', 'ciphertext', 'tag']);
  if (envelope.algorithm !== 'A256GCM') throw invalidDocument();
  const keyId = managedSecretIdentifier(envelope.keyId, 'keyId');
  const iv = boundedString(envelope.iv, 64);
  const ciphertext = boundedString(envelope.ciphertext, 96 * 1024);
  const tag = boundedString(envelope.tag, 64);
  decodeBase64Url(iv, 12, 'initialization vector');
  decodeBase64Url(tag, 16, 'authentication tag');
  if (ciphertext.length === 0) throw invalidDocument();
  decodeBase64Url(ciphertext, undefined, 'ciphertext');
  return { algorithm: 'A256GCM', keyId, iv, ciphertext, tag };
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalidDocument();
  const record = value as Record<string, unknown>;
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in record)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw invalidDocument();
  }
  return record;
}

function asString(value: unknown): string {
  if (typeof value !== 'string') throw invalidDocument();
  return value;
}

function boundedString(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length > maxLength) throw invalidDocument();
  return value;
}

function invalidDocument(): ManagedSecretError {
  return new ManagedSecretError('integrity_failure', 'Managed Secret document is invalid');
}

function emptyDocument(): ManagedSecretDocument {
  return {
    schemaVersion: MANAGED_SECRET_DOCUMENT_SCHEMA_VERSION,
    revision: 0,
    secrets: [],
    grants: [],
  };
}
