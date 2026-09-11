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

export const MANAGED_SECRET_REFERENCE_SCHEMA_VERSION = 1 as const;
export const MANAGED_SECRET_MAX_VALUE_BYTES = 64 * 1024;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export interface ManagedSecretReference {
  readonly schemaVersion: typeof MANAGED_SECRET_REFERENCE_SCHEMA_VERSION;
  readonly secretId: string;
}

export type ManagedSecretStatus = 'active' | 'revoked' | 'deleted';

/**
 * Public metadata deliberately omits the secret value and encrypted envelope.
 * `revision` changes on rotate and revoke while the reference remains stable,
 * so portable Session state never needs rewriting for those changes. A
 * successful delete returns terminal metadata but does not persist a tombstone.
 */
export interface ManagedSecretMetadata {
  readonly reference: ManagedSecretReference;
  readonly ownerPrincipalId: string;
  readonly revision: number;
  readonly status: ManagedSecretStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/**
 * Trusted internal identity established before entering the Secret Store.
 *
 * The store does not authenticate this value. A control-plane composition must
 * derive it from its authenticated request context; it must never decode it
 * directly from an Activation payload, Renderer message, or other client input.
 * V1 uses one principal as the ownership boundary. Organization/project sharing
 * requires a separate, explicit authorization model.
 */
export interface ManagedSecretPrincipalContext {
  readonly principalId: string;
}

/**
 * A Cloud Session authority already checked by the calling control plane.
 * Constructing this context asserts that `cloudSessionId` belongs to, or has
 * explicitly been delegated to, `principalId`; the Secret Store does not own
 * the Cloud Session repository needed to prove that relation.
 */
export interface ManagedSecretSessionContext extends ManagedSecretPrincipalContext {
  readonly cloudSessionId: string;
}

export interface ManagedSecretActivationContext extends ManagedSecretSessionContext {
  readonly activationId: string;
}

export interface ManagedSecretMaterial {
  readonly reference: ManagedSecretReference;
  readonly revision: number;
  /** Sensitive: only the Activation injection boundary may consume this value. */
  readonly value: string;
}

export type ManagedSecretMutationResult =
  | { readonly kind: 'committed'; readonly secret: ManagedSecretMetadata }
  | { readonly kind: 'revision_conflict'; readonly actualRevision: number };

export interface CreateManagedSecretInput extends ManagedSecretPrincipalContext {
  readonly value: string;
}

export interface GetManagedSecretMetadataInput extends ManagedSecretPrincipalContext {
  readonly reference: ManagedSecretReference;
}

export interface MutateManagedSecretInput extends ManagedSecretPrincipalContext {
  readonly reference: ManagedSecretReference;
  readonly expectedRevision: number;
}

export interface RotateManagedSecretInput extends MutateManagedSecretInput {
  readonly value: string;
}

export interface AuthorizeManagedSecretSessionInput extends ManagedSecretSessionContext {
  readonly reference: ManagedSecretReference;
}

export interface ResolveManagedSecretsForActivationInput {
  readonly context: ManagedSecretActivationContext;
  readonly references: readonly ManagedSecretReference[];
}

/**
 * Control-plane authority for values and Session grants.
 *
 * A Session Bundle may carry `ManagedSecretReference` values, but a copied
 * reference is inert until this store has a grant for the target Cloud Session.
 * That is the fork/restore re-authorization boundary.
 *
 * This is a trusted internal control-plane interface, not a network, IPC, or
 * Renderer boundary. Every principal and Session context must be established by
 * the caller before invoking it.
 */
export interface ManagedSecretStore {
  createSecret(input: CreateManagedSecretInput): Promise<ManagedSecretMetadata>;
  getSecretMetadata(input: GetManagedSecretMetadataInput): Promise<ManagedSecretMetadata | null>;
  rotateSecret(input: RotateManagedSecretInput): Promise<ManagedSecretMutationResult>;
  revokeSecret(input: MutateManagedSecretInput): Promise<ManagedSecretMutationResult>;
  deleteSecret(input: MutateManagedSecretInput): Promise<ManagedSecretMutationResult>;
  authorizeSession(input: AuthorizeManagedSecretSessionInput): Promise<void>;
  revokeSessionAuthorization(input: AuthorizeManagedSecretSessionInput): Promise<void>;
  /** Resolves the complete set or fails before returning any material. */
  resolveForActivation(
    input: ResolveManagedSecretsForActivationInput,
  ): Promise<readonly ManagedSecretMaterial[]>;
}

export type ManagedSecretErrorCode =
  | 'invalid_input'
  | 'secret_not_found'
  | 'unauthorized'
  | 'secret_revoked'
  | 'key_unavailable'
  | 'integrity_failure'
  | 'storage_failure'
  | 'injection_failed'
  | 'cleanup_failed';

export class ManagedSecretError extends Error {
  constructor(
    readonly code: ManagedSecretErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'ManagedSecretError';
  }
}

interface InMemorySecretRecord extends ManagedSecretMetadata {
  value?: string;
}

export interface InMemoryManagedSecretStoreOptions {
  readonly now?: () => number;
  readonly newSecretId?: () => string;
}

/** Deterministic control-plane fake used by Activation and Fork coordinators. */
export class InMemoryManagedSecretStore implements ManagedSecretStore {
  readonly #records = new Map<string, InMemorySecretRecord>();
  readonly #grants = new Set<string>();
  readonly #now: () => number;
  readonly #newSecretId: () => string;

  constructor(options: InMemoryManagedSecretStoreOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#newSecretId = options.newSecretId ?? randomUUID;
  }

  async createSecret(input: CreateManagedSecretInput): Promise<ManagedSecretMetadata> {
    const principalId = managedSecretIdentifier(input.principalId, 'principalId');
    const value = managedSecretValue(input.value);
    const secretId = this.#newSecretId();
    assertManagedSecretId(secretId);
    if (this.#records.has(secretId)) {
      throw new ManagedSecretError('storage_failure', 'Managed Secret identity collision');
    }
    const now = managedSecretTimestamp(this.#now());
    const record: InMemorySecretRecord = {
      reference: managedSecretReference(secretId),
      ownerPrincipalId: principalId,
      revision: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      value,
    };
    this.#records.set(secretId, record);
    return publicMetadata(record);
  }

  async getSecretMetadata(
    input: GetManagedSecretMetadataInput,
  ): Promise<ManagedSecretMetadata | null> {
    const principal = managedSecretIdentifier(input.principalId, 'principalId');
    const normalized = decodeManagedSecretReference(input.reference);
    const record = this.#records.get(normalized.secretId);
    if (!record) return null;
    assertOwner(record, principal);
    return publicMetadata(record);
  }

  async rotateSecret(input: RotateManagedSecretInput): Promise<ManagedSecretMutationResult> {
    const prepared = this.#prepareMutation(input);
    if (prepared.kind === 'revision_conflict') return prepared;
    assertActive(prepared.record);
    const record: InMemorySecretRecord = {
      ...prepared.record,
      revision: prepared.record.revision + 1,
      updatedAt: mutationTimestamp(prepared.record, this.#now()),
      value: managedSecretValue(input.value),
    };
    this.#records.set(record.reference.secretId, record);
    return { kind: 'committed', secret: publicMetadata(record) };
  }

  async revokeSecret(input: MutateManagedSecretInput): Promise<ManagedSecretMutationResult> {
    const prepared = this.#prepareMutation(input);
    if (prepared.kind === 'revision_conflict') return prepared;
    assertActive(prepared.record);
    const record: InMemorySecretRecord = {
      ...prepared.record,
      revision: prepared.record.revision + 1,
      status: 'revoked',
      updatedAt: mutationTimestamp(prepared.record, this.#now()),
      value: undefined,
    };
    this.#records.set(record.reference.secretId, record);
    return { kind: 'committed', secret: publicMetadata(record) };
  }

  async deleteSecret(input: MutateManagedSecretInput): Promise<ManagedSecretMutationResult> {
    const prepared = this.#prepareMutation(input);
    if (prepared.kind === 'revision_conflict') return prepared;
    const record: InMemorySecretRecord = {
      ...prepared.record,
      revision: prepared.record.revision + 1,
      status: 'deleted',
      updatedAt: mutationTimestamp(prepared.record, this.#now()),
      value: undefined,
    };
    this.#records.delete(record.reference.secretId);
    for (const grant of this.#grants) {
      if (grant.startsWith(`${record.reference.secretId}\0`)) this.#grants.delete(grant);
    }
    return { kind: 'committed', secret: publicMetadata(record) };
  }

  async authorizeSession(input: AuthorizeManagedSecretSessionInput): Promise<void> {
    const normalized = normalizeAuthorizationInput(input);
    const record = requiredRecord(this.#records, normalized.reference);
    assertOwner(record, normalized.principalId);
    assertActive(record);
    this.#grants.add(grantKey(record.reference.secretId, normalized));
  }

  async revokeSessionAuthorization(input: AuthorizeManagedSecretSessionInput): Promise<void> {
    const normalized = normalizeAuthorizationInput(input);
    const record = requiredRecord(this.#records, normalized.reference);
    assertOwner(record, normalized.principalId);
    this.#grants.delete(grantKey(record.reference.secretId, normalized));
  }

  async resolveForActivation(
    input: ResolveManagedSecretsForActivationInput,
  ): Promise<readonly ManagedSecretMaterial[]> {
    const context = normalizeActivationContext(input.context);
    if (!Array.isArray(input.references) || input.references.length > 128) {
      throw invalidInput('Managed Secret references must be a bounded array');
    }
    return input.references.map((candidate) => {
      const reference = decodeManagedSecretReference(candidate);
      const record = requiredRecord(this.#records, reference);
      assertOwner(record, context.principalId);
      assertActive(record);
      if (!this.#grants.has(grantKey(reference.secretId, context))) {
        throw new ManagedSecretError(
          'unauthorized',
          'Managed Secret is not authorized for this Cloud Session',
        );
      }
      if (record.value === undefined) {
        throw new ManagedSecretError('integrity_failure', 'Managed Secret material is unavailable');
      }
      return {
        reference: { ...record.reference },
        revision: record.revision,
        value: record.value,
      };
    });
  }

  #prepareMutation(
    input: MutateManagedSecretInput,
  ):
    | { readonly kind: 'ready'; readonly record: InMemorySecretRecord }
    | Extract<ManagedSecretMutationResult, { kind: 'revision_conflict' }> {
    const principalId = managedSecretIdentifier(input.principalId, 'principalId');
    const reference = decodeManagedSecretReference(input.reference);
    const expectedRevision = managedSecretRevision(input.expectedRevision);
    const record = requiredRecord(this.#records, reference);
    assertOwner(record, principalId);
    if (record.revision !== expectedRevision) {
      return { kind: 'revision_conflict', actualRevision: record.revision };
    }
    return { kind: 'ready', record };
  }
}

export function decodeManagedSecretReference(value: unknown): ManagedSecretReference {
  if (!isRecord(value)) throw invalidInput('Managed Secret reference must be an object');
  if (Object.keys(value).length !== 2 || value.schemaVersion !== 1) {
    throw invalidInput('Managed Secret reference schema is unsupported');
  }
  assertManagedSecretId(value.secretId);
  return managedSecretReference(value.secretId);
}

export function decodeManagedSecretEnvironmentName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 128 ||
    !ENVIRONMENT_NAME_PATTERN.test(value)
  ) {
    throw invalidInput('Managed Secret environment target is invalid');
  }
  return value;
}

export function managedSecretIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value !== value.trim() ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw invalidInput(`Managed Secret ${field} is invalid`);
  }
  return value;
}

export function managedSecretRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw invalidInput('Managed Secret revision is invalid');
  }
  return value as number;
}

export function managedSecretTimestamp(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidInput('Managed Secret timestamp is invalid');
  }
  return value as number;
}

export function managedSecretValue(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > MANAGED_SECRET_MAX_VALUE_BYTES
  ) {
    throw invalidInput('Managed Secret value must be non-empty and within the size limit');
  }
  return value;
}

export function managedSecretReference(secretId: string): ManagedSecretReference {
  assertManagedSecretId(secretId);
  return { schemaVersion: MANAGED_SECRET_REFERENCE_SCHEMA_VERSION, secretId };
}

export function publicManagedSecretMetadata(record: ManagedSecretMetadata): ManagedSecretMetadata {
  return publicMetadata(record);
}

function normalizeAuthorizationInput(input: AuthorizeManagedSecretSessionInput) {
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

function requiredRecord(
  records: ReadonlyMap<string, InMemorySecretRecord>,
  reference: ManagedSecretReference,
): InMemorySecretRecord {
  const record = records.get(reference.secretId);
  if (!record) {
    throw new ManagedSecretError('secret_not_found', 'Managed Secret was not found');
  }
  return record;
}

function assertOwner(record: ManagedSecretMetadata, principalId: string): void {
  if (record.ownerPrincipalId !== principalId) {
    throw new ManagedSecretError('unauthorized', 'Managed Secret access is not authorized');
  }
}

function assertActive(record: ManagedSecretMetadata): void {
  if (record.status !== 'active') {
    throw new ManagedSecretError('secret_revoked', 'Managed Secret is revoked');
  }
}

function grantKey(
  secretId: string,
  input: Pick<AuthorizeManagedSecretSessionInput, 'principalId' | 'cloudSessionId'>,
): string {
  return `${secretId}\0${input.principalId}\0${input.cloudSessionId}`;
}

function publicMetadata(record: ManagedSecretMetadata): ManagedSecretMetadata {
  return {
    reference: { ...record.reference },
    ownerPrincipalId: record.ownerPrincipalId,
    revision: record.revision,
    status: record.status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

function mutationTimestamp(record: Pick<ManagedSecretMetadata, 'updatedAt'>, now: number): number {
  return Math.max(record.updatedAt, managedSecretTimestamp(now));
}

function assertManagedSecretId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw invalidInput('Managed Secret identity is invalid');
  }
}

function invalidInput(message: string): ManagedSecretError {
  return new ManagedSecretError('invalid_input', message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
