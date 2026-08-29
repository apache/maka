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

import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  type ContextOffloadCopyResult,
  type ContextOffloadGarbageCollectionResult,
  type ContextOffloadLimits,
  type ContextOffloadOwner,
  type ContextOffloadPutResult,
  type ContextOffloadReadResult,
  type ContextOffloadRecord,
  type ContextOffloadRetirementResult,
  type ContextOffloadStore,
  type ContextOffloadUsage,
} from '@maka/core/context-offload';
import {
  configureSqliteContextOffloadDatabase,
  migrateSqliteContextOffloadDatabase,
} from './sqlite-context-offload-schema.js';
import {
  readStableBoundedFile,
  syncDirectory,
  syncDirectoryChain,
  syncFile,
} from './stable-storage.js';

const MAX_ID_CODE_POINTS = 512;
const MAX_MEDIA_TYPE_CODE_POINTS = 256;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const MANAGED_FILE_LOCATOR_PATTERN = /^sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/;
const require = createRequire(import.meta.url);

export const CONTEXT_OFFLOAD_DATABASE_NAME = 'context-offload.sqlite';
export const CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME = 'context-offload-values';

export type SqliteContextOffloadStoreFailpoint =
  | 'after_blob_insert'
  | 'after_ref_insert'
  | 'after_managed_file_staging'
  | 'after_managed_file_publish'
  | 'after_gc_blob_delete';

export interface SqliteContextOffloadStoreOptions {
  readonly limits: ContextOffloadLimits;
  readonly now?: () => number;
  readonly idFactory?: () => string;
  readonly failpoint?: (point: SqliteContextOffloadStoreFailpoint) => void;
  readonly onUnavailable?: (error: unknown) => void;
}

interface ContextReferenceRow {
  ref_id: unknown;
  session_id: unknown;
  owner_kind: unknown;
  owner_id: unknown;
  blob_id: unknown;
  size_bytes: unknown;
  media_type: unknown;
  created_at: unknown;
  storage_kind?: unknown;
  payload?: unknown;
}

interface ContextBlobRow {
  storage_kind: unknown;
  payload: unknown;
  size_bytes: unknown;
}

interface SessionUsageRow {
  reference_count: unknown;
  logical_bytes: unknown;
}

interface StoreUsageRow {
  blob_count: unknown;
  physical_bytes: unknown;
}

interface GarbageCandidateRow {
  blob_id: unknown;
  size_bytes: unknown;
  storage_kind: unknown;
  payload: unknown;
}

interface ManagedFilePublication {
  readonly locator: string;
}

type ContextBlobStorageKind = 'inline' | 'managed_file';

type PreparedContextRead =
  | ContextOffloadReadResult
  | {
      readonly kind: 'managed_file';
      readonly record: ContextOffloadRecord;
      readonly locator: string;
    };

/** Low-level implementation; production callers must use the Storage Root authority facade. */
export class SqliteContextOffloadStore implements ContextOffloadStore {
  readonly #database: DatabaseSync;
  readonly #limits: ContextOffloadLimits;
  readonly #now: () => number;
  readonly #idFactory: () => string;
  readonly #failpoint?: (point: SqliteContextOffloadStoreFailpoint) => void;
  readonly #onUnavailable?: (error: unknown) => void;
  readonly #storageRoot: string | undefined;
  readonly #valueRoot: string | undefined;
  #managedValueMutationTail: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(path: string, options: SqliteContextOffloadStoreOptions) {
    if (!path) throw new Error('Context-offload SQLite path is required');
    this.#limits = validateLimits(options.limits);
    this.#now = options.now ?? Date.now;
    this.#idFactory = options.idFactory ?? randomUUID;
    this.#failpoint = options.failpoint;
    this.#onUnavailable = options.onUnavailable;
    const storageRoot = path === ':memory:' ? undefined : dirname(path);
    if (storageRoot) mkdirSync(storageRoot, { recursive: true });
    this.#storageRoot = storageRoot ? realpathSync(storageRoot) : undefined;
    this.#valueRoot = this.#storageRoot
      ? join(this.#storageRoot, CONTEXT_OFFLOAD_VALUES_DIRECTORY_NAME)
      : undefined;
    const Database = loadDatabaseSync();
    this.#database = new Database(path);
    try {
      configureSqliteContextOffloadDatabase(this.#database);
      migrateSqliteContextOffloadDatabase(this.#database);
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  async put(input: {
    readonly sessionId: string;
    readonly owner: ContextOffloadOwner;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly expectedSha256?: string;
  }): Promise<ContextOffloadPutResult> {
    assertBoundedIdentity(input.sessionId, 'Session id');
    assertOwner(input.owner);
    assertBoundedText(input.mediaType, MAX_MEDIA_TYPE_CODE_POINTS, 'Context media type');
    if (!(input.bytes instanceof Uint8Array)) {
      throw new Error('Context bytes must be a Uint8Array');
    }
    if (input.expectedSha256 !== undefined && !SHA256_PATTERN.test(input.expectedSha256)) {
      throw new Error('Expected context SHA-256 must be canonical lowercase hexadecimal');
    }
    if (input.bytes.byteLength > this.#limits.ownerMaxBytes[input.owner.kind]) {
      return { ok: false, reason: 'too_large' };
    }

    // Snapshot caller-owned bytes before crossing the asynchronous interface.
    const bytes = new Uint8Array(input.bytes);
    const blobId = createHash('sha256').update(bytes).digest('hex');
    if (input.expectedSha256 !== undefined && input.expectedSha256 !== blobId) {
      return { ok: false, reason: 'identity_conflict' };
    }

    const operation = async (): Promise<ContextOffloadPutResult> => {
      let publication: ManagedFilePublication | undefined;
      let deletionIntentLocator: string | undefined;
      try {
        this.#assertOpen();
        const existingStorageKind = this.#readBlobStorageKind(blobId);
        const storageKind =
          preferredStorageKind(input.owner) === 'managed_file' ||
          existingStorageKind === 'managed_file'
            ? 'managed_file'
            : 'inline';
        if (storageKind === 'managed_file') {
          const locator = managedFileLocator(blobId);
          this.#recordManagedFileDeletionIntent(locator, bytes.byteLength);
          deletionIntentLocator = locator;
          publication = await this.#publishManagedFile(locator, blobId, bytes);
          this.#failpoint?.('after_managed_file_publish');
        }
        const result = this.#writeTransaction(() =>
          this.#put({ ...input, bytes, blobId, storageKind, publication }),
        );
        if (!result.ok && publication) {
          await this.#drainFileDeletion(publication.locator).catch(() => undefined);
        }
        return result;
      } catch (error) {
        if (deletionIntentLocator) {
          await this.#drainFileDeletion(deletionIntentLocator).catch(() => undefined);
        }
        this.#onUnavailable?.(error);
        return { ok: false, reason: 'unavailable' };
      }
    };
    return this.#runManagedValueMutation(operation);
  }

  async read(input: {
    readonly sessionId: string;
    readonly refId: string;
    readonly maxBytes: number;
  }): Promise<ContextOffloadReadResult> {
    assertBoundedIdentity(input.sessionId, 'Session id');
    assertBoundedIdentity(input.refId, 'Context reference id');
    assertNonNegativeSafeInteger(input.maxBytes, 'Context read byte limit');
    try {
      this.#assertOpen();
      const prepared = this.#readTransaction(() => this.#prepareRead(input));
      if ('ok' in prepared) return prepared;
      return await this.#readManagedFile(prepared);
    } catch (error) {
      this.#onUnavailable?.(error);
      return { ok: false, reason: 'unavailable' };
    }
  }

  async releaseReference(input: {
    readonly sessionId: string;
    readonly refId: string;
  }): Promise<void> {
    assertBoundedIdentity(input.sessionId, 'Session id');
    assertBoundedIdentity(input.refId, 'Context reference id');
    this.#assertOpen();
    this.#writeTransaction(() => {
      const row = this.#database
        .prepare(
          `SELECT r.session_id, r.blob_id, b.size_bytes
           FROM context_refs r
           JOIN context_blobs b ON b.blob_id = r.blob_id
           WHERE r.ref_id = ?`,
        )
        .get(input.refId) as
        | { session_id?: unknown; blob_id?: unknown; size_bytes?: unknown }
        | undefined;
      if (!row || row.session_id !== input.sessionId) return;
      if (!isNonNegativeSafeInteger(row.size_bytes)) {
        throw new Error('Invalid context reference size');
      }
      const blobId = decodeBlobId(row.blob_id);
      if (!blobId) throw new Error('Invalid context reference blob identity');
      const deleted = this.#database
        .prepare('DELETE FROM context_refs WHERE session_id = ? AND ref_id = ?')
        .run(input.sessionId, input.refId);
      if (deleted.changes !== 1) return;
      this.#database
        .prepare(
          `UPDATE context_session_usage
           SET reference_count = reference_count - 1,
               logical_bytes = logical_bytes - ?
           WHERE session_id = ?`,
        )
        .run(row.size_bytes, input.sessionId);
      this.#database
        .prepare(
          `DELETE FROM context_session_usage
           WHERE session_id = ? AND reference_count = 0 AND logical_bytes = 0`,
        )
        .run(input.sessionId);
      this.#markBlobUnreferencedIfEligible(blobId, this.#readNow());
    });
  }

  async copyReferences(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly references: readonly {
      readonly sourceRefId: string;
      readonly targetOwner: ContextOffloadOwner;
    }[];
  }): Promise<ContextOffloadCopyResult> {
    assertBoundedIdentity(input.sourceSessionId, 'Source Session id');
    assertBoundedIdentity(input.targetSessionId, 'Target Session id');
    const references = input.references.map((reference) => {
      assertBoundedIdentity(reference.sourceRefId, 'Source context reference id');
      assertOwner(reference.targetOwner);
      return Object.freeze({
        sourceRefId: reference.sourceRefId,
        targetOwner: Object.freeze({ ...reference.targetOwner }),
      });
    });
    try {
      this.#assertOpen();
      return this.#writeTransaction(() =>
        this.#copyReferences({
          sourceSessionId: input.sourceSessionId,
          targetSessionId: input.targetSessionId,
          references,
        }),
      );
    } catch (error) {
      this.#onUnavailable?.(error);
      return { ok: false, reason: 'unavailable' };
    }
  }

  async retireSession(sessionId: string): Promise<ContextOffloadRetirementResult> {
    assertBoundedIdentity(sessionId, 'Session id');
    this.#assertOpen();
    return this.#writeTransaction(() => {
      const rows = this.#database
        .prepare(
          `SELECT r.blob_id, b.size_bytes
           FROM context_refs r INDEXED BY context_refs_session
           JOIN context_blobs b ON b.blob_id = r.blob_id
           WHERE r.session_id = ?`,
        )
        .all(sessionId) as unknown as Array<{ blob_id?: unknown; size_bytes?: unknown }>;
      let releasedLogicalBytes = 0;
      const blobIds = new Map<string, Uint8Array>();
      for (const row of rows) {
        const blobId = decodeBlobId(row.blob_id);
        if (!blobId || !isNonNegativeSafeInteger(row.size_bytes)) {
          throw new Error('Invalid retiring context reference');
        }
        releasedLogicalBytes = addSafeInteger(
          releasedLogicalBytes,
          row.size_bytes,
          'Retired context logical bytes',
        );
        blobIds.set(Buffer.from(blobId).toString('hex'), blobId);
      }
      const usage = this.#readSessionUsage(sessionId);
      if (
        readNonNegativeInteger(usage.reference_count, 'Session reference count') !== rows.length ||
        readNonNegativeInteger(usage.logical_bytes, 'Session logical bytes') !==
          releasedLogicalBytes
      ) {
        throw new Error('Context Session usage is inconsistent with retiring references');
      }
      const deleted = this.#database
        .prepare('DELETE FROM context_refs WHERE session_id = ?')
        .run(sessionId);
      if (deleted.changes !== rows.length) {
        throw new Error('Context Session retirement deleted an unexpected reference count');
      }
      this.#database
        .prepare('DELETE FROM context_session_usage WHERE session_id = ?')
        .run(sessionId);
      const unreferencedAt = this.#readNow();
      for (const blobId of blobIds.values()) {
        this.#markBlobUnreferencedIfEligible(blobId, unreferencedAt);
      }
      return {
        releasedReferences: rows.length,
        releasedLogicalBytes,
      };
    });
  }

  async collectGarbage(input: {
    readonly olderThan: number;
    readonly maxBlobs: number;
    readonly maxBytes: number;
  }): Promise<ContextOffloadGarbageCollectionResult> {
    assertNonNegativeSafeInteger(input.olderThan, 'Context garbage watermark');
    assertPositiveSafeInteger(input.maxBlobs, 'Context garbage blob limit');
    assertPositiveSafeInteger(input.maxBytes, 'Context garbage byte limit');
    if (input.maxBlobs === Number.MAX_SAFE_INTEGER) {
      throw new Error('Context garbage blob limit is too large');
    }
    return this.#runManagedValueMutation(async () => {
      this.#assertOpen();
      if (this.#hasPendingFileDeletions()) {
        await this.#drainPendingFileDeletions(input.maxBlobs);
        return {
          deletedBlobs: 0,
          deletedBytes: 0,
          hasMore: this.#hasPendingFileDeletions() || this.#hasEligibleGarbage(input.olderThan),
        };
      }
      const collected = this.#writeTransaction(() => {
        const rows = this.#database
          .prepare(
            `SELECT c.blob_id, b.size_bytes, b.storage_kind, b.payload
           FROM context_gc_candidates c INDEXED BY context_gc_candidates_eligible
           JOIN context_blobs b ON b.blob_id = c.blob_id
           WHERE c.unreferenced_at < ?
           ORDER BY c.unreferenced_at, c.blob_id
           LIMIT ?`,
          )
          .all(input.olderThan, input.maxBlobs + 1) as unknown as GarbageCandidateRow[];
        const selected: Array<{
          readonly blobId: Uint8Array;
          readonly sizeBytes: number;
          readonly managedLocator?: string;
        }> = [];
        let deletedBytes = 0;
        let inlineDeletedBytes = 0;
        for (const row of rows) {
          if (selected.length === input.maxBlobs) break;
          const blobId = decodeBlobId(row.blob_id);
          if (!blobId || !isNonNegativeSafeInteger(row.size_bytes)) {
            throw new Error('Invalid context garbage candidate');
          }
          const value = decodeBlobValue(row, Buffer.from(blobId).toString('hex'));
          if (!value) throw new Error('Invalid context garbage candidate value');
          if (exceedsLimit(deletedBytes, row.size_bytes, input.maxBytes)) {
            if (selected.length === 0) {
              throw new Error(
                `Context garbage byte limit ${input.maxBytes} cannot fit eligible blob of ${row.size_bytes} bytes`,
              );
            }
            break;
          }
          deletedBytes = addSafeInteger(deletedBytes, row.size_bytes, 'Collected context bytes');
          selected.push({
            blobId,
            sizeBytes: row.size_bytes,
            ...(value.kind === 'managed_file' ? { managedLocator: value.locator } : {}),
          });
          if (value.kind === 'inline') {
            inlineDeletedBytes = addSafeInteger(
              inlineDeletedBytes,
              row.size_bytes,
              'Collected inline context bytes',
            );
          }
        }
        const deleteBlob = this.#database.prepare(
          `DELETE FROM context_blobs
         WHERE blob_id = ?
           AND NOT EXISTS (SELECT 1 FROM context_refs WHERE blob_id = ?)`,
        );
        const enqueueFileDeletion = this.#database.prepare(
          `INSERT INTO context_file_deletions(locator, size_bytes, enqueued_at)
         VALUES (?, ?, ?)
         ON CONFLICT(locator) DO NOTHING`,
        );
        for (const selectedBlob of selected) {
          if (selectedBlob.managedLocator) {
            enqueueFileDeletion.run(
              Buffer.from(selectedBlob.managedLocator, 'utf8'),
              selectedBlob.sizeBytes,
              this.#readNow(),
            );
          }
          const deleted = deleteBlob.run(selectedBlob.blobId, selectedBlob.blobId);
          if (deleted.changes !== 1) {
            throw new Error('Context garbage candidate is still referenced or missing');
          }
          this.#failpoint?.('after_gc_blob_delete');
        }
        if (selected.length > 0) {
          const updated = this.#database
            .prepare(
              `UPDATE context_store_usage
             SET blob_count = blob_count - ?, physical_bytes = physical_bytes - ?
             WHERE singleton = 1`,
            )
            .run(selected.length, inlineDeletedBytes);
          if (updated.changes !== 1) throw new Error('Missing context store usage row');
        }
        return {
          deletedBlobs: selected.length,
          deletedBytes,
          hasMore: rows.length > selected.length,
        };
      });
      await this.#drainPendingFileDeletions(input.maxBlobs);
      return {
        ...collected,
        hasMore: collected.hasMore || this.#hasPendingFileDeletions(),
      };
    });
  }

  async usage(sessionId?: string): Promise<ContextOffloadUsage> {
    if (sessionId !== undefined) assertBoundedIdentity(sessionId, 'Session id');
    this.#assertOpen();
    return this.#readTransaction(() => {
      const storeUsage = this.#readStoreUsage();
      if (sessionId === undefined) {
        const row = this.#database
          .prepare(
            `SELECT COALESCE(SUM(reference_count), 0) AS reference_count,
                    COALESCE(SUM(logical_bytes), 0) AS logical_bytes
             FROM context_session_usage`,
          )
          .get() as unknown as SessionUsageRow;
        return usageFromRows(row, storeUsage);
      }
      const row = this.#readSessionUsage(sessionId);
      return usageFromRows(row, storeUsage);
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #readBlobStorageKind(blobId: string): ContextBlobStorageKind | undefined {
    const row = this.#database
      .prepare('SELECT storage_kind FROM context_blobs WHERE blob_id = ?')
      .get(Buffer.from(blobId, 'hex')) as { storage_kind?: unknown } | undefined;
    if (!row) return undefined;
    if (row.storage_kind !== 'inline' && row.storage_kind !== 'managed_file') {
      throw new Error('Invalid context blob storage kind');
    }
    return row.storage_kind;
  }

  #put(input: {
    readonly sessionId: string;
    readonly owner: ContextOffloadOwner;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly blobId: string;
    readonly storageKind: ContextBlobStorageKind;
    readonly publication?: ManagedFilePublication;
  }): ContextOffloadPutResult {
    const existingReference = this.#readReferenceByOwner(input.sessionId, input.owner);
    if (existingReference) {
      if (
        existingReference.blobId !== input.blobId ||
        existingReference.mediaType !== input.mediaType
      ) {
        return { ok: false, reason: 'identity_conflict' };
      }
    }

    const blobIdBytes = Buffer.from(input.blobId, 'hex');
    const existingBlob = this.#database
      .prepare('SELECT storage_kind, payload, size_bytes FROM context_blobs WHERE blob_id = ?')
      .get(blobIdBytes) as ContextBlobRow | undefined;
    if (existingBlob) {
      if (!blobMatchesInput(existingBlob, input.blobId, input.bytes)) {
        throw new Error(`Context blob identity is inconsistent: ${input.blobId}`);
      }
    }

    if (input.storageKind === 'managed_file' && !input.publication) {
      throw new Error('Managed context value was not durably published');
    }
    if (existingReference) {
      this.#cancelPendingFileDeletion(input.publication, input.bytes.byteLength);
      this.#promoteToManagedFile(existingBlob, input, blobIdBytes);
      return { ok: true, record: existingReference };
    }

    const sessionUsage = this.#readSessionUsage(input.sessionId);
    const logicalBytes = readNonNegativeInteger(
      sessionUsage.logical_bytes,
      'Session logical bytes',
    );
    if (exceedsLimit(logicalBytes, input.bytes.byteLength, this.#limits.sessionLogicalBytes)) {
      return { ok: false, reason: 'session_quota_exceeded' };
    }
    if (!existingBlob) {
      const physicalBytes = readNonNegativeInteger(
        this.#readStoreUsage().physical_bytes,
        'Workspace physical bytes',
      );
      const exceedsWorkspaceQuota =
        input.storageKind === 'managed_file'
          ? physicalBytes > this.#limits.workspacePhysicalBytes
          : exceedsLimit(
              physicalBytes,
              input.bytes.byteLength,
              this.#limits.workspacePhysicalBytes,
            );
      if (exceedsWorkspaceQuota) {
        return { ok: false, reason: 'workspace_quota_exceeded' };
      }
    }
    this.#cancelPendingFileDeletion(input.publication, input.bytes.byteLength);
    this.#promoteToManagedFile(existingBlob, input, blobIdBytes);

    const createdAt = this.#readNow();
    const refId = this.#idFactory();
    assertBoundedIdentity(refId, 'Context reference id');
    if (!existingBlob) {
      this.#database
        .prepare(
          `INSERT INTO context_blobs(blob_id, storage_kind, payload, size_bytes, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          blobIdBytes,
          input.storageKind,
          input.storageKind === 'inline'
            ? input.bytes
            : Buffer.from(input.publication?.locator ?? '', 'utf8'),
          input.bytes.byteLength,
          createdAt,
        );
      this.#database
        .prepare(
          `UPDATE context_store_usage
           SET blob_count = blob_count + 1,
               physical_bytes = physical_bytes + ?
           WHERE singleton = 1`,
        )
        .run(input.bytes.byteLength);
      this.#failpoint?.('after_blob_insert');
    }
    this.#database
      .prepare(
        `INSERT INTO context_refs(
           ref_id, session_id, owner_kind, owner_id, blob_id, media_type, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        refId,
        input.sessionId,
        input.owner.kind,
        input.owner.ownerId,
        blobIdBytes,
        input.mediaType,
        createdAt,
      );
    this.#database
      .prepare(
        `INSERT INTO context_session_usage(session_id, reference_count, logical_bytes)
         VALUES (?, 1, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           reference_count = reference_count + 1,
           logical_bytes = logical_bytes + excluded.logical_bytes`,
      )
      .run(input.sessionId, input.bytes.byteLength);
    this.#database.prepare('DELETE FROM context_gc_candidates WHERE blob_id = ?').run(blobIdBytes);
    this.#failpoint?.('after_ref_insert');
    return {
      ok: true,
      record: {
        refId,
        sessionId: input.sessionId,
        owner: { ...input.owner },
        blobId: input.blobId,
        sizeBytes: input.bytes.byteLength,
        mediaType: input.mediaType,
        createdAt,
      },
    };
  }

  #promoteToManagedFile(
    existingBlob: ContextBlobRow | undefined,
    input: {
      readonly storageKind: ContextBlobStorageKind;
      readonly publication?: ManagedFilePublication;
    },
    blobId: Uint8Array,
  ): void {
    if (existingBlob?.storage_kind !== 'inline' || input.storageKind !== 'managed_file') return;
    this.#database
      .prepare(
        `UPDATE context_blobs
         SET storage_kind = 'managed_file', payload = ?
         WHERE blob_id = ? AND storage_kind = 'inline'`,
      )
      .run(Buffer.from(input.publication?.locator ?? '', 'utf8'), blobId);
  }

  #cancelPendingFileDeletion(
    publication: ManagedFilePublication | undefined,
    sizeBytes: number,
  ): void {
    if (!publication) return;
    const locator = Buffer.from(publication.locator, 'utf8');
    const row = this.#database
      .prepare('SELECT size_bytes FROM context_file_deletions WHERE locator = ?')
      .get(locator) as { size_bytes?: unknown } | undefined;
    if (!row) return;
    if (row.size_bytes !== sizeBytes) {
      throw new Error('Pending context file deletion has an inconsistent size');
    }
    const deleted = this.#database
      .prepare('DELETE FROM context_file_deletions WHERE locator = ?')
      .run(locator);
    if (deleted.changes !== 1) throw new Error('Pending context file deletion disappeared');
    this.#releasePendingFileBytes(sizeBytes);
  }

  #copyReferences(input: {
    readonly sourceSessionId: string;
    readonly targetSessionId: string;
    readonly references: readonly {
      readonly sourceRefId: string;
      readonly targetOwner: ContextOffloadOwner;
    }[];
  }): ContextOffloadCopyResult {
    const createdAt = this.#readNow();
    const pendingByOwner = new Map<
      string,
      {
        readonly refId: string;
        readonly owner: ContextOffloadOwner;
        readonly blobId: string;
        readonly sizeBytes: number;
        readonly mediaType: string;
      }
    >();
    const copied: Array<{ sourceRefId: string; targetRefId: string }> = [];
    let addedLogicalBytes = 0;

    for (const reference of input.references) {
      const sourceRow = this.#database
        .prepare(
          `SELECT r.ref_id, r.session_id, r.owner_kind, r.owner_id, r.blob_id,
                  b.size_bytes, r.media_type, r.created_at
           FROM context_refs r
           JOIN context_blobs b ON b.blob_id = r.blob_id
           WHERE r.session_id = ? AND r.ref_id = ?`,
        )
        .get(input.sourceSessionId, reference.sourceRefId) as ContextReferenceRow | undefined;
      if (!sourceRow) return { ok: false, reason: 'not_found' };
      const source = decodeReferenceRow(sourceRow);
      if (!source) throw new Error('Invalid source context reference');

      const ownerKey = `${reference.targetOwner.kind}\0${reference.targetOwner.ownerId}`;
      const pending = pendingByOwner.get(ownerKey);
      if (pending) {
        if (pending.blobId !== source.blobId || pending.mediaType !== source.mediaType) {
          return { ok: false, reason: 'identity_conflict' };
        }
        copied.push({ sourceRefId: reference.sourceRefId, targetRefId: pending.refId });
        continue;
      }

      const existing = this.#readReferenceByOwner(input.targetSessionId, reference.targetOwner);
      if (existing) {
        if (existing.blobId !== source.blobId || existing.mediaType !== source.mediaType) {
          return { ok: false, reason: 'identity_conflict' };
        }
        pendingByOwner.set(ownerKey, {
          refId: existing.refId,
          owner: reference.targetOwner,
          blobId: existing.blobId,
          sizeBytes: existing.sizeBytes,
          mediaType: existing.mediaType,
        });
        copied.push({ sourceRefId: reference.sourceRefId, targetRefId: existing.refId });
        continue;
      }

      const refId = this.#idFactory();
      assertBoundedIdentity(refId, 'Context reference id');
      pendingByOwner.set(ownerKey, {
        refId,
        owner: reference.targetOwner,
        blobId: source.blobId,
        sizeBytes: source.sizeBytes,
        mediaType: source.mediaType,
      });
      addedLogicalBytes = addSafeInteger(
        addedLogicalBytes,
        source.sizeBytes,
        'Copied context logical bytes',
      );
      copied.push({ sourceRefId: reference.sourceRefId, targetRefId: refId });
    }

    const targetUsage = this.#readSessionUsage(input.targetSessionId);
    const currentLogicalBytes = readNonNegativeInteger(
      targetUsage.logical_bytes,
      'Target Session logical bytes',
    );
    if (exceedsLimit(currentLogicalBytes, addedLogicalBytes, this.#limits.sessionLogicalBytes)) {
      return { ok: false, reason: 'session_quota_exceeded' };
    }

    const newReferences = [...pendingByOwner.values()].filter(
      (reference) => !this.#readReferenceByOwner(input.targetSessionId, reference.owner),
    );
    const insertReference = this.#database.prepare(
      `INSERT INTO context_refs(
         ref_id, session_id, owner_kind, owner_id, blob_id, media_type, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const clearCandidate = this.#database.prepare(
      'DELETE FROM context_gc_candidates WHERE blob_id = ?',
    );
    for (const reference of newReferences) {
      const blobId = Buffer.from(reference.blobId, 'hex');
      insertReference.run(
        reference.refId,
        input.targetSessionId,
        reference.owner.kind,
        reference.owner.ownerId,
        blobId,
        reference.mediaType,
        createdAt,
      );
      clearCandidate.run(blobId);
    }
    if (newReferences.length > 0) {
      this.#database
        .prepare(
          `INSERT INTO context_session_usage(session_id, reference_count, logical_bytes)
           VALUES (?, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             reference_count = reference_count + excluded.reference_count,
             logical_bytes = logical_bytes + excluded.logical_bytes`,
        )
        .run(input.targetSessionId, newReferences.length, addedLogicalBytes);
    }
    return { ok: true, copied };
  }

  #prepareRead(input: {
    readonly sessionId: string;
    readonly refId: string;
    readonly maxBytes: number;
  }): PreparedContextRead {
    const row = this.#database
      .prepare(
        `SELECT r.ref_id, r.session_id, r.owner_kind, r.owner_id, r.blob_id,
                b.size_bytes, b.storage_kind, b.payload, r.media_type, r.created_at
         FROM context_refs r
         JOIN context_blobs b ON b.blob_id = r.blob_id
         WHERE r.ref_id = ?`,
      )
      .get(input.refId) as (ContextReferenceRow & ContextBlobRow) | undefined;
    if (!row) return { ok: false, reason: 'not_found' };
    const record = decodeReferenceRow(row);
    if (!record) return { ok: false, reason: 'corrupt' };
    if (record.sessionId !== input.sessionId) return { ok: false, reason: 'session_mismatch' };
    if (
      record.sizeBytes > input.maxBytes ||
      record.sizeBytes > this.#limits.ownerMaxBytes[record.owner.kind]
    ) {
      return { ok: false, reason: 'too_large' };
    }
    const value = decodeBlobValue(row, record.blobId);
    if (!value || row.size_bytes !== record.sizeBytes) {
      return { ok: false, reason: 'corrupt' };
    }
    if (value.kind === 'managed_file') {
      return { kind: 'managed_file', record, locator: value.locator };
    }
    if (createHash('sha256').update(value.bytes).digest('hex') !== record.blobId) {
      return { ok: false, reason: 'corrupt' };
    }
    return { ok: true, record, bytes: value.bytes };
  }

  #readReferenceByOwner(
    sessionId: string,
    owner: ContextOffloadOwner,
  ): ContextOffloadRecord | undefined {
    const row = this.#database
      .prepare(
        `SELECT r.ref_id, r.session_id, r.owner_kind, r.owner_id, r.blob_id,
                b.size_bytes, r.media_type, r.created_at
         FROM context_refs r
         JOIN context_blobs b ON b.blob_id = r.blob_id
         WHERE r.session_id = ? AND r.owner_kind = ? AND r.owner_id = ?`,
      )
      .get(sessionId, owner.kind, owner.ownerId) as ContextReferenceRow | undefined;
    if (!row) return undefined;
    const record = decodeReferenceRow(row);
    if (!record) throw new Error('Invalid context reference row');
    return record;
  }

  async #readManagedFile(input: {
    readonly record: ContextOffloadRecord;
    readonly locator: string;
  }): Promise<ContextOffloadReadResult> {
    let bytes: Uint8Array;
    try {
      const path = this.#managedFilePath(input.locator, input.record.blobId);
      await this.#assertManagedDirectory(dirname(path));
      bytes = await readStableBoundedFile({
        path,
        maxBytes: input.record.sizeBytes,
        invalidFile: () => new InvalidManagedContextFileError(),
      });
    } catch (error) {
      if (error instanceof InvalidManagedContextFileError || isNodeError(error, 'ENOENT')) {
        return { ok: false, reason: 'corrupt' };
      }
      throw error;
    }
    if (
      bytes.byteLength !== input.record.sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== input.record.blobId
    ) {
      return { ok: false, reason: 'corrupt' };
    }
    return { ok: true, record: input.record, bytes: new Uint8Array(bytes) };
  }

  async #publishManagedFile(
    locator: string,
    blobId: string,
    bytes: Uint8Array,
  ): Promise<ManagedFilePublication> {
    const target = this.#managedFilePath(locator, blobId);
    const targetDirectory = dirname(target);
    const storageRoot = this.#storageRoot;
    if (!storageRoot) throw new Error('Managed context files require a durable Storage Root');
    await this.#ensureManagedDirectory(targetDirectory);
    const temporary = managedFileStagingPath(target, blobId);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await unlink(temporary).then(
        () => syncDirectory(targetDirectory),
        (error: unknown) => {
          if (!isNodeError(error, 'ENOENT')) throw error;
        },
      );
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = undefined;
      this.#failpoint?.('after_managed_file_staging');
      try {
        await link(temporary, target);
        await this.#assertManagedDirectory(targetDirectory);
        await syncDirectoryChain(targetDirectory, storageRoot);
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
        await this.#verifyManagedFile(target, blobId, bytes.byteLength);
        await syncFile(target);
        await this.#assertManagedDirectory(targetDirectory);
        await syncDirectoryChain(targetDirectory, storageRoot);
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(temporary).then(
        () => syncDirectory(targetDirectory),
        (error: unknown) => {
          if (!isNodeError(error, 'ENOENT')) throw error;
        },
      );
    }
    return { locator };
  }

  async #verifyManagedFile(path: string, blobId: string, sizeBytes: number): Promise<void> {
    await this.#assertManagedDirectory(dirname(path));
    const bytes = await readStableBoundedFile({
      path,
      maxBytes: sizeBytes,
      invalidFile: () => new InvalidManagedContextFileError(),
    });
    if (
      bytes.byteLength !== sizeBytes ||
      createHash('sha256').update(bytes).digest('hex') !== blobId
    ) {
      throw new InvalidManagedContextFileError();
    }
  }

  #recordManagedFileDeletionIntent(locator: string, sizeBytes: number): void {
    const locatorBytes = Buffer.from(locator, 'utf8');
    this.#writeTransaction(() => {
      const inserted = this.#database
        .prepare(
          `INSERT INTO context_file_deletions(locator, size_bytes, enqueued_at)
           VALUES (?, ?, ?)
           ON CONFLICT(locator) DO NOTHING`,
        )
        .run(locatorBytes, sizeBytes, this.#readNow());
      if (inserted.changes === 1) {
        const updated = this.#database
          .prepare(
            `UPDATE context_store_usage
             SET physical_bytes = physical_bytes + ?
             WHERE singleton = 1`,
          )
          .run(sizeBytes);
        if (updated.changes !== 1) throw new Error('Missing context store usage row');
      }
      const row = this.#database
        .prepare('SELECT size_bytes FROM context_file_deletions WHERE locator = ?')
        .get(locatorBytes) as { size_bytes?: unknown } | undefined;
      if (row?.size_bytes !== sizeBytes) {
        throw new Error('Pending context file deletion has an inconsistent size');
      }
    });
  }

  async #drainPendingFileDeletions(limit: number): Promise<void> {
    const rows = this.#database
      .prepare('SELECT locator FROM context_file_deletions ORDER BY enqueued_at, locator LIMIT ?')
      .all(limit) as Array<{ locator?: unknown }>;
    for (const row of rows) {
      const locator = decodeManagedFileLocator(row.locator);
      if (!locator) throw new Error('Invalid pending context file deletion locator');
      await this.#drainFileDeletion(locator);
    }
  }

  #hasPendingFileDeletions(): boolean {
    return Boolean(
      this.#database.prepare('SELECT 1 AS present FROM context_file_deletions LIMIT 1').get(),
    );
  }

  #hasEligibleGarbage(olderThan: number): boolean {
    return Boolean(
      this.#database
        .prepare(
          `SELECT 1 AS present
           FROM context_gc_candidates INDEXED BY context_gc_candidates_eligible
           WHERE unreferenced_at < ?
           LIMIT 1`,
        )
        .get(olderThan),
    );
  }

  async #drainFileDeletion(locator: string): Promise<void> {
    const locatorBytes = Buffer.from(locator, 'utf8');
    const live = this.#database
      .prepare(
        `SELECT 1 AS present FROM context_blobs
         WHERE storage_kind = 'managed_file' AND payload = ? LIMIT 1`,
      )
      .get(locatorBytes) as { present?: unknown } | undefined;
    await this.#deleteManagedFile(locator, live?.present !== 1);
    this.#writeTransaction(() => {
      const row = this.#database
        .prepare('SELECT size_bytes FROM context_file_deletions WHERE locator = ?')
        .get(locatorBytes) as { size_bytes?: unknown } | undefined;
      if (!row) return;
      const sizeBytes = readNonNegativeInteger(
        row.size_bytes,
        'Pending context file deletion bytes',
      );
      const deleted = this.#database
        .prepare('DELETE FROM context_file_deletions WHERE locator = ?')
        .run(locatorBytes);
      if (deleted.changes !== 1) throw new Error('Pending context file deletion disappeared');
      this.#releasePendingFileBytes(sizeBytes);
    });
  }

  #releasePendingFileBytes(sizeBytes: number): void {
    const updated = this.#database
      .prepare(
        `UPDATE context_store_usage
         SET physical_bytes = physical_bytes - ?
         WHERE singleton = 1 AND physical_bytes >= ?`,
      )
      .run(sizeBytes, sizeBytes);
    if (updated.changes !== 1) throw new Error('Context physical byte accounting underflow');
  }

  async #deleteManagedFile(locator: string, deleteTarget: boolean): Promise<void> {
    const path = this.#managedFilePath(locator);
    const blobId = MANAGED_FILE_LOCATOR_PATTERN.exec(locator)?.[2];
    if (!blobId) throw new InvalidManagedContextFileError();
    const staging = managedFileStagingPath(path, blobId);
    try {
      await this.#assertManagedDirectory(dirname(path));
      let deleted = false;
      for (const candidate of deleteTarget ? [path, staging] : [staging]) {
        await unlink(candidate).then(
          () => {
            deleted = true;
          },
          (error: unknown) => {
            if (!isNodeError(error, 'ENOENT')) throw error;
          },
        );
      }
      if (deleted) await syncDirectory(dirname(path));
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error;
    }
  }

  async #ensureManagedDirectory(directory: string): Promise<void> {
    for (const path of this.#managedDirectoryChain(directory)) {
      try {
        await mkdir(path, { mode: 0o700 });
      } catch (error) {
        if (!isNodeError(error, 'EEXIST')) throw error;
      }
      await this.#assertManagedDirectoryEntry(path);
    }
  }

  async #assertManagedDirectory(directory: string): Promise<void> {
    for (const path of this.#managedDirectoryChain(directory)) {
      await this.#assertManagedDirectoryEntry(path);
    }
  }

  #managedDirectoryChain(directory: string): readonly string[] {
    const valueRoot = this.#valueRoot;
    if (!valueRoot) throw new Error('Managed context files require a durable Storage Root');
    const shaRoot = join(valueRoot, 'sha256');
    const shard = relative(shaRoot, directory);
    if (!/^[0-9a-f]{2}$/u.test(shard) || isAbsolute(shard) || shard.includes(sep)) {
      throw new InvalidManagedContextFileError();
    }
    return [valueRoot, shaRoot, directory];
  }

  async #assertManagedDirectoryEntry(path: string): Promise<void> {
    const storageRoot = this.#storageRoot;
    if (!storageRoot) throw new Error('Managed context files require a durable Storage Root');
    let entry: Awaited<ReturnType<typeof lstat>>;
    let resolved: string;
    try {
      [entry, resolved] = await Promise.all([lstat(path), realpath(path)]);
    } catch (error) {
      if (isNodeError(error, 'ENOTDIR')) {
        throw new InvalidManagedContextFileError();
      }
      throw error;
    }
    const fromRoot = relative(storageRoot, resolved);
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      fromRoot === '..' ||
      fromRoot.startsWith(`..${sep}`) ||
      isAbsolute(fromRoot)
    ) {
      throw new InvalidManagedContextFileError();
    }
  }

  #managedFilePath(locator: string, expectedBlobId?: string): string {
    const valueRoot = this.#valueRoot;
    if (!valueRoot) throw new Error('Managed context files require a durable Storage Root');
    const match = MANAGED_FILE_LOCATOR_PATTERN.exec(locator);
    const blobId = match?.[2];
    if (!match || !blobId || match[1] !== blobId.slice(0, 2)) {
      throw new InvalidManagedContextFileError();
    }
    if (expectedBlobId !== undefined && blobId !== expectedBlobId) {
      throw new InvalidManagedContextFileError();
    }
    return join(valueRoot, 'sha256', match[1], blobId);
  }

  #runManagedValueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#managedValueMutationTail.then(operation, operation);
    this.#managedValueMutationTail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  #markBlobUnreferencedIfEligible(blobId: Uint8Array, unreferencedAt: number): void {
    this.#database
      .prepare(
        `INSERT INTO context_gc_candidates(blob_id, unreferenced_at)
         SELECT ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM context_refs WHERE blob_id = ?)
         ON CONFLICT(blob_id) DO NOTHING`,
      )
      .run(blobId, unreferencedAt, blobId);
  }

  #readNow(): number {
    const now = this.#now();
    assertNonNegativeSafeInteger(now, 'Context timestamp');
    return now;
  }

  #readSessionUsage(sessionId: string): SessionUsageRow {
    return (
      (this.#database
        .prepare(
          `SELECT reference_count, logical_bytes
           FROM context_session_usage WHERE session_id = ?`,
        )
        .get(sessionId) as SessionUsageRow | undefined) ?? {
        reference_count: 0,
        logical_bytes: 0,
      }
    );
  }

  #readStoreUsage(): StoreUsageRow {
    const row = this.#database
      .prepare(
        `SELECT blob_count, physical_bytes
         FROM context_store_usage WHERE singleton = 1`,
      )
      .get() as StoreUsageRow | undefined;
    if (!row) throw new Error('Missing context store usage row');
    readNonNegativeInteger(row.blob_count, 'Workspace blob count');
    readNonNegativeInteger(row.physical_bytes, 'Workspace physical bytes');
    return row;
  }

  #writeTransaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  #readTransaction<T>(operation: () => T): T {
    this.#database.exec('BEGIN');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      rollback(this.#database);
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('SQLite Context Offload Store is closed');
  }
}

function decodeReferenceRow(row: ContextReferenceRow): ContextOffloadRecord | undefined {
  if (
    typeof row.ref_id !== 'string' ||
    typeof row.session_id !== 'string' ||
    !isOwnerKind(row.owner_kind) ||
    typeof row.owner_id !== 'string' ||
    typeof row.media_type !== 'string' ||
    !isNonNegativeSafeInteger(row.size_bytes) ||
    !isNonNegativeSafeInteger(row.created_at)
  ) {
    return undefined;
  }
  const blobIdBytes = decodeBytes(row.blob_id);
  if (!blobIdBytes || blobIdBytes.byteLength !== 32) return undefined;
  return {
    refId: row.ref_id,
    sessionId: row.session_id,
    owner: { kind: row.owner_kind, ownerId: row.owner_id },
    blobId: Buffer.from(blobIdBytes).toString('hex'),
    sizeBytes: row.size_bytes,
    mediaType: row.media_type,
    createdAt: row.created_at,
  };
}

type DecodedBlobValue =
  | { readonly kind: 'inline'; readonly bytes: Uint8Array }
  | { readonly kind: 'managed_file'; readonly locator: string };

function decodeBlobValue(
  row: ContextBlobRow,
  expectedBlobId?: string,
): DecodedBlobValue | undefined {
  if (!isNonNegativeSafeInteger(row.size_bytes)) return undefined;
  if (row.storage_kind === 'inline') {
    const bytes = decodeBytes(row.payload);
    return bytes?.byteLength === row.size_bytes ? { kind: 'inline', bytes } : undefined;
  }
  if (row.storage_kind !== 'managed_file') return undefined;
  const locator = decodeManagedFileLocator(row.payload);
  if (!locator) return undefined;
  const blobId = MANAGED_FILE_LOCATOR_PATTERN.exec(locator)?.[2];
  if (expectedBlobId !== undefined && blobId !== expectedBlobId) return undefined;
  return { kind: 'managed_file', locator };
}

function blobMatchesInput(row: ContextBlobRow, blobId: string, expectedBytes: Uint8Array): boolean {
  if (
    row.size_bytes !== expectedBytes.byteLength ||
    createHash('sha256').update(expectedBytes).digest('hex') !== blobId
  ) {
    return false;
  }
  const value = decodeBlobValue(row, blobId);
  return (
    value !== undefined &&
    (value.kind === 'managed_file' ||
      createHash('sha256').update(value.bytes).digest('hex') === blobId)
  );
}

function decodeBytes(value: unknown): Uint8Array | undefined {
  return value instanceof Uint8Array ? new Uint8Array(value) : undefined;
}

function decodeBlobId(value: unknown): Uint8Array | undefined {
  const bytes = decodeBytes(value);
  return bytes?.byteLength === 32 ? bytes : undefined;
}

function managedFileLocator(blobId: string): string {
  if (!SHA256_PATTERN.test(blobId)) throw new Error('Invalid managed context blob identity');
  return `sha256/${blobId.slice(0, 2)}/${blobId}`;
}

function decodeManagedFileLocator(value: unknown): string | undefined {
  const bytes = decodeBytes(value);
  if (!bytes || bytes.byteLength === 0 || bytes.byteLength > 512) return undefined;
  const locator = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(locator, 'utf8').equals(Buffer.from(bytes))) return undefined;
  const match = MANAGED_FILE_LOCATOR_PATTERN.exec(locator);
  const blobId = match?.[2];
  return match && blobId && match[1] === blobId.slice(0, 2) ? locator : undefined;
}

function usageFromRows(session: SessionUsageRow, store: StoreUsageRow): ContextOffloadUsage {
  return {
    references: readNonNegativeInteger(session.reference_count, 'Context reference count'),
    logicalBytes: readNonNegativeInteger(session.logical_bytes, 'Context logical bytes'),
    physicalBytes: readNonNegativeInteger(store.physical_bytes, 'Context physical bytes'),
  };
}

function validateLimits(limits: ContextOffloadLimits): ContextOffloadLimits {
  const ownerMaxBytes = {
    read_image_snapshot: limits.ownerMaxBytes?.read_image_snapshot,
    tool_result_archive: limits.ownerMaxBytes?.tool_result_archive,
  };
  assertNonNegativeSafeInteger(ownerMaxBytes.read_image_snapshot, 'Read image snapshot byte limit');
  assertNonNegativeSafeInteger(ownerMaxBytes.tool_result_archive, 'Tool Result archive byte limit');
  assertNonNegativeSafeInteger(limits.sessionLogicalBytes, 'Session context quota');
  assertNonNegativeSafeInteger(limits.workspacePhysicalBytes, 'Workspace context quota');
  return Object.freeze({
    ownerMaxBytes: Object.freeze(ownerMaxBytes),
    sessionLogicalBytes: limits.sessionLogicalBytes,
    workspacePhysicalBytes: limits.workspacePhysicalBytes,
  });
}

function assertOwner(owner: ContextOffloadOwner): void {
  if (!isOwnerKind(owner.kind)) throw new Error(`Unsupported context owner: ${String(owner.kind)}`);
  assertBoundedIdentity(owner.ownerId, 'Context owner id');
}

function preferredStorageKind(owner: ContextOffloadOwner): ContextBlobStorageKind {
  return owner.kind === 'read_image_snapshot' ? 'managed_file' : 'inline';
}

function managedFileStagingPath(target: string, blobId: string): string {
  return join(dirname(target), `.${blobId}.publish.tmp`);
}

function isOwnerKind(value: unknown): value is ContextOffloadOwner['kind'] {
  return value === 'read_image_snapshot' || value === 'tool_result_archive';
}

function assertBoundedIdentity(value: string, label: string): void {
  assertBoundedText(value, MAX_ID_CODE_POINTS, label);
}

function assertBoundedText(value: string, maxCodePoints: number, label: string): void {
  if (typeof value !== 'string' || value.length === 0 || [...value].length > maxCodePoints) {
    throw new Error(`${label} must be a non-empty string of at most ${maxCodePoints} code points`);
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!isNonNegativeSafeInteger(value)) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (!isNonNegativeSafeInteger(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function exceedsLimit(current: number, added: number, limit: number): boolean {
  return current > limit - added;
}

function addSafeInteger(left: number, right: number, label: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`Invalid ${label}`);
  return result;
}

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
}

function rollback(database: DatabaseSync): void {
  try {
    database.exec('ROLLBACK');
  } catch {
    // Preserve the operation failure that triggered rollback.
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code;
}

class InvalidManagedContextFileError extends Error {}
