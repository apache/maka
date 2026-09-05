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

import { createHash } from 'node:crypto';
import { LOCAL_MEMORY_MAX_BYTES } from '@maka/core/local-memory';

export const MEMORY_DOCUMENT_MAX_BYTES = LOCAL_MEMORY_MAX_BYTES;

export type MemoryDocumentName = 'memory' | 'pending';
export type MemoryRevision = `sha256:${string}`;
export type MemoryBackupKind = 'save' | 'reset' | 'restore';

export type MemoryDocumentSnapshot =
  | {
      readonly kind: 'missing';
      readonly revision: null;
      readonly byteLength: 0;
    }
  | {
      readonly kind: 'document';
      readonly revision: MemoryRevision;
      readonly byteLength: number;
      readonly bytes: Uint8Array;
    }
  | {
      readonly kind: 'safe_mode';
      readonly revision: MemoryRevision;
      readonly byteLength: number;
      readonly reason: 'invalid_utf8' | 'oversize';
    };

export interface MemoryBundleSnapshot {
  readonly revision: MemoryRevision;
  readonly memory: MemoryDocumentSnapshot;
  readonly pending: MemoryDocumentSnapshot;
}

export interface MemoryBackupSnapshot {
  readonly kind: MemoryBackupKind;
  readonly revision: MemoryRevision;
  readonly updatedAt: number;
  readonly document: Exclude<MemoryDocumentSnapshot, { kind: 'missing' }>;
}

export interface CommitMemoryBundleInput {
  readonly expectedRevision: MemoryRevision;
  readonly memory: Uint8Array;
  readonly pending: Uint8Array | null;
  readonly backup?: Exclude<MemoryBackupKind, 'restore'>;
}

export interface RestoreMemoryBackupInput {
  readonly expectedRevision: MemoryRevision;
  readonly expectedBackupRevision: MemoryRevision;
  readonly kind: MemoryBackupKind;
}

export interface MemoryBundleMutationResult {
  readonly changed: boolean;
  readonly snapshot: MemoryBundleSnapshot;
}

export type MemoryBundleStoreErrorCode =
  | 'invalid_document'
  | 'io_failed'
  | 'commit_outcome_unknown'
  | 'recovery_conflict';

export class MemoryBundleStoreError extends Error {
  constructor(
    readonly code: MemoryBundleStoreErrorCode,
    message: string,
    readonly candidateRevision?: MemoryRevision,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'MemoryBundleStoreError';
  }
}

export class MemoryBundleRevisionConflictError extends Error {
  readonly code = 'revision_conflict';

  constructor(
    readonly expectedRevision: MemoryRevision,
    readonly actual: MemoryBundleSnapshot,
  ) {
    super(
      `Memory bundle revision conflict: expected ${expectedRevision}, actual ${actual.revision}`,
    );
    this.name = 'MemoryBundleRevisionConflictError';
  }
}

export class MemoryBundleBackupNotFoundError extends Error {
  readonly code = 'backup_not_found';

  constructor(readonly kind: MemoryBackupKind) {
    super(`Memory backup not found: ${kind}`);
    this.name = 'MemoryBundleBackupNotFoundError';
  }
}

export class MemoryBundleBackupRevisionConflictError extends Error {
  readonly code = 'backup_revision_conflict';

  constructor(
    readonly kind: MemoryBackupKind,
    readonly expectedRevision: MemoryRevision,
    readonly actualRevision: MemoryRevision,
  ) {
    super(
      `Memory ${kind} backup revision conflict: expected ${expectedRevision}, actual ${actualRevision}`,
    );
    this.name = 'MemoryBundleBackupRevisionConflictError';
  }
}

export interface MemoryBundleTarget {
  readonly snapshot: MemoryBundleSnapshot;
  readonly memory: Buffer;
  readonly pending: Buffer | null;
}

export function validateDocumentBytes(name: MemoryDocumentName, input: Uint8Array): Buffer {
  if (!(input instanceof Uint8Array)) {
    throw invalidMemoryDocument(`${displayName(name)} bytes are required`);
  }
  const bytes = Buffer.from(input);
  if (bytes.byteLength > MEMORY_DOCUMENT_MAX_BYTES) {
    throw invalidMemoryDocument(
      `${displayName(name)} exceeds its ${MEMORY_DOCUMENT_MAX_BYTES} byte limit`,
    );
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw invalidMemoryDocument(`${displayName(name)} is not valid UTF-8`, error);
  }
  return bytes;
}

export function bundleTarget(
  memory: Buffer,
  pending: Buffer | null,
  allowUnsafeMemory = false,
): MemoryBundleTarget {
  const memoryBytes = Buffer.from(memory);
  const pendingBytes = pending === null ? null : Buffer.from(pending);
  const snapshot = bundleSnapshot(
    allowUnsafeMemory ? snapshotForBytes(memoryBytes) : documentSnapshot(memoryBytes),
    pendingBytes === null ? missingDocument() : documentSnapshot(pendingBytes),
  );
  return { snapshot, memory: memoryBytes, pending: pendingBytes };
}

export function bundleSnapshot(
  memory: MemoryDocumentSnapshot,
  pending: MemoryDocumentSnapshot,
): MemoryBundleSnapshot {
  const hash = createHash('sha256');
  hash.update('maka-memory-bundle-v1\0');
  updateBundleHash(hash, 'memory', memory);
  updateBundleHash(hash, 'pending', pending);
  return {
    revision: `sha256:${hash.digest('hex')}`,
    memory: cloneDocument(memory),
    pending: cloneDocument(pending),
  };
}

export function snapshotForBytes(
  bytes: Uint8Array,
): Exclude<MemoryDocumentSnapshot, { kind: 'missing' }> {
  const documentRevision = revision(bytes);
  if (bytes.byteLength > MEMORY_DOCUMENT_MAX_BYTES) {
    return {
      kind: 'safe_mode',
      revision: documentRevision,
      byteLength: bytes.byteLength,
      reason: 'oversize',
    };
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return {
      kind: 'safe_mode',
      revision: documentRevision,
      byteLength: bytes.byteLength,
      reason: 'invalid_utf8',
    };
  }
  return documentSnapshot(bytes, documentRevision);
}

export function documentSnapshot(
  bytes: Uint8Array,
  documentRevision: MemoryRevision = revision(bytes),
): Extract<MemoryDocumentSnapshot, { kind: 'document' }> {
  return {
    kind: 'document',
    revision: documentRevision,
    byteLength: bytes.byteLength,
    bytes: Uint8Array.from(bytes),
  };
}

export function missingDocument(): Extract<MemoryDocumentSnapshot, { kind: 'missing' }> {
  return { kind: 'missing', revision: null, byteLength: 0 };
}

export function revision(bytes: Uint8Array): MemoryRevision {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function isRevision(input: unknown): input is MemoryRevision {
  return typeof input === 'string' && /^sha256:[a-f0-9]{64}$/.test(input);
}

export function invalidMemoryDocument(message: string, cause?: unknown): MemoryBundleStoreError {
  return new MemoryBundleStoreError(
    'invalid_document',
    message,
    undefined,
    cause === undefined ? undefined : { cause },
  );
}

export function memoryBundleIoFailed(message: string, cause: unknown): MemoryBundleStoreError {
  return new MemoryBundleStoreError('io_failed', message, undefined, { cause });
}

export function memoryBundleRecoveryConflict(message: string): MemoryBundleStoreError {
  return new MemoryBundleStoreError('recovery_conflict', message);
}

function updateBundleHash(
  hash: ReturnType<typeof createHash>,
  name: MemoryDocumentName,
  document: MemoryDocumentSnapshot,
): void {
  hash.update(`${name}\0${document.kind}\0${document.byteLength}\0`);
  hash.update(document.revision ?? 'missing');
  hash.update('\0');
}

function cloneDocument(document: MemoryDocumentSnapshot): MemoryDocumentSnapshot {
  return document.kind === 'document'
    ? { ...document, bytes: Uint8Array.from(document.bytes) }
    : { ...document };
}

function displayName(name: MemoryDocumentName): string {
  return name === 'memory' ? 'MEMORY.md' : 'PENDING.md';
}
