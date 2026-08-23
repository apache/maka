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
import { type BigIntStats, constants as fsConstants, createReadStream, type Dirent } from 'node:fs';
import {
  access,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import {
  ARTIFACT_ENTITY_ID_MAX_CHARS,
  ARTIFACT_KINDS,
  ARTIFACT_SOURCES,
  ArtifactBinaryReadResult,
  ArtifactKind,
  ArtifactRecord,
  ArtifactSource,
  ArtifactTextReadResult,
  canUserDeleteArtifact,
  isArtifactTurnKey,
  isCanonicalArtifactEntityId,
} from '@maka/core/artifacts';
import {
  isDeepResearchArtifactRole,
  type DeepResearchArtifactRole,
} from '@maka/core/deep-research-run';
import { publishMarkerFile, readBoundedMarkerFile } from './marker-file.js';
import {
  ARTIFACT_PUBLICATION_STAGING_PATTERN,
  ARTIFACT_PURGE_INTENT_FILE,
  isArtifactPurgeRecoveryTempName,
} from './artifact-storage-layout.js';
import {
  isSafeRelativeArtifactPath,
  validateCanonicalArtifactTargetName,
  validateRelativeArtifactPath,
} from './artifact-metadata-codec.js';
import {
  withArtifactWriterLock,
  withLeaseBoundArtifactWriterLock,
} from './artifact-writer-lock.js';
import type { ArtifactWriterLockAuthority } from './root-authority.js';
import { syncDirectory, syncDirectoryChain, syncFile } from './stable-storage.js';
import type { ArtifactMetadataRepository } from './artifact-metadata-repository.js';
import { createSqliteArtifactMetadataRepository } from './sqlite-artifact-metadata.js';

export { isSafeRelativeArtifactPath } from './artifact-metadata-codec.js';

export const ARTIFACT_TEXT_PREVIEW_LIMIT_BYTES = 10 * 1024 * 1024;
export const ARTIFACT_BINARY_PREVIEW_LIMIT_BYTES = 50 * 1024 * 1024;

const PURGE_INTENT_SCHEMA_VERSION = 1 as const;
const MAX_PURGE_INTENT_BYTES = 64 * 1024 * 1024;
const EMPTY_SESSION_SNAPSHOT: ArtifactSessionSnapshot = {
  records: [],
  revision: artifactListRevision([]),
};

interface ArtifactSessionSnapshot {
  readonly records: readonly ArtifactRecord[];
  readonly revision: ArtifactListRevision;
}

type ArtifactReadFailure = {
  readonly ok: false;
  readonly reason: 'not_found' | 'too_large' | 'read_failed' | 'not_allowed' | 'deleted';
};

interface PreparedArtifactRead {
  readonly ok: true;
  readonly path: string;
  readonly record: ArtifactRecord;
  readonly maxBytes: number;
}

interface ArtifactRemovalEntry {
  readonly unlinkPath: string;
  readonly comparisonIdentity: string;
}

type ArtifactRecordDraft = Omit<ArtifactRecord, 'sizeBytes'>;

interface RecoverableOrphan {
  readonly canonicalPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly digest: string;
}

export interface CreateArtifactInput {
  sessionId: string;
  turnId: string;
  name: string;
  kind: ArtifactKind;
  content: string | Uint8Array;
  mimeType?: string;
  source?: ArtifactSource;
  summary?: string;
  deepResearchRole?: DeepResearchArtifactRole;
  now?: number;
  id?: string;
}

export type ArtifactListRevision = `sha256:${string}`;

export interface ArtifactListPage {
  readonly revision: ArtifactListRevision;
  readonly records: readonly ArtifactRecord[];
  readonly total: number;
}

export interface ArtifactSessionEntry {
  readonly revision: ArtifactListRevision;
  readonly record: ArtifactRecord | null;
}

export type ArtifactChunkReadResult =
  | {
      readonly ok: true;
      readonly bytes: Uint8Array;
      readonly offset: number;
      readonly totalBytes: number;
      readonly nextOffset: number | null;
    }
  | ArtifactReadFailure
  | { readonly ok: false; readonly reason: 'out_of_range' };

export interface ConversationArtifactCopyInput {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly turnIds: readonly string[];
}

export interface ConversationArtifactCopyResult {
  readonly artifactIds: ReadonlyMap<string, string>;
  readonly relativePaths: ReadonlyMap<string, string>;
}

export interface ArtifactStoreReader {
  list(sessionId: string, opts?: { includeDeleted?: boolean }): Promise<ArtifactRecord[]>;
  get(artifactId: string): Promise<ArtifactRecord | null>;
  readText(
    artifactId: string,
    opts?: { maxBytes?: number; includeDeleted?: boolean },
  ): Promise<ArtifactTextReadResult>;
  readBinary(artifactId: string, opts?: { maxBytes?: number }): Promise<ArtifactBinaryReadResult>;
}

export type DurableArtifactBinaryReadResult =
  | ArtifactBinaryReadResult
  | { ok: false; reason: 'session_mismatch' };

export interface DurableArtifactAttachmentReader {
  readDurableAttachmentBinary(input: {
    artifactId: string;
    sessionId: string;
    maxBytes?: number;
  }): Promise<DurableArtifactBinaryReadResult>;
}

export interface ArtifactStore extends ArtifactStoreReader, DurableArtifactAttachmentReader {
  create(input: CreateArtifactInput): Promise<ArtifactRecord>;
  delete(artifactId: string): Promise<void>;
  purge(artifactIds: readonly string[]): Promise<void>;
  close?(): void;
}

export type ArtifactUserDeleteResult =
  | { readonly kind: 'deleted'; readonly record: ArtifactRecord }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'protected' };

export interface ArtifactAuthorityStore extends ArtifactStore {
  copyConversationArtifacts(
    input: ConversationArtifactCopyInput,
  ): Promise<ConversationArtifactCopyResult>;
  purgeSessionArtifacts(sessionId: string): Promise<void>;
  deleteUserArtifactInSession(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactUserDeleteResult>;
  listPage(
    sessionId: string,
    options: { offset: number; limit: number },
  ): Promise<ArtifactListPage>;
  listTurnArtifacts(sessionId: string, turnId: string): Promise<ArtifactRecord[]>;
  getInSession(sessionId: string, artifactId: string): Promise<ArtifactSessionEntry>;
  readTextInSession(
    sessionId: string,
    artifactId: string,
    opts?: { maxBytes?: number },
  ): Promise<ArtifactTextReadResult>;
  readBinaryInSession(
    sessionId: string,
    artifactId: string,
    opts?: { maxBytes?: number },
  ): Promise<ArtifactBinaryReadResult>;
  readChunkInSession(
    sessionId: string,
    artifactId: string,
    options: { offset: number; maxBytes: number },
  ): Promise<ArtifactChunkReadResult>;
}

export interface ArtifactStoreWriteAuthority {
  readonly store: ArtifactAuthorityStore;
  recover(): Promise<void>;
  close(): void;
}

export function createSqliteArtifactStore(workspaceRoot: string): ArtifactStore {
  return new SqliteArtifactStore(
    workspaceRoot,
    'self_managed',
    createSqliteArtifactMetadataRepository(workspaceRoot),
    undefined,
    undefined,
  );
}

export function createSqliteArtifactStoreWriteAuthority(
  workspaceRoot: string,
  options: {
    assertAuthority?: () => Promise<void>;
    leaseBoundWriterLockAuthority?: ArtifactWriterLockAuthority;
  } = {},
): ArtifactStoreWriteAuthority {
  const store = new SqliteArtifactStore(
    workspaceRoot,
    'authority',
    createSqliteArtifactMetadataRepository(workspaceRoot),
    options.assertAuthority,
    options.leaseBoundWriterLockAuthority,
  );
  return Object.freeze({
    store,
    recover: () => store.recoverForWriteWithAuthority(),
    close: () => store.close(),
  });
}

class SqliteArtifactStore implements ArtifactAuthorityStore {
  private artifactRoot: string;
  private purgeIntentPath: string;
  private records: ArtifactRecord[] = [];
  private sessionSnapshots = new Map<string, ArtifactSessionSnapshot>();
  private metadataReady = false;
  private recoveryRequired: boolean;
  private selfManagedRecoveryRequired: boolean;
  private recoverableOrphans = new Map<string, RecoverableOrphan>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private workspaceRoot: string,
    private readonly recoveryMode: 'self_managed' | 'authority',
    private readonly metadataRepository: ArtifactMetadataRepository,
    private readonly assertAuthority?: () => Promise<void>,
    private readonly leaseBoundWriterLockAuthority?: ArtifactWriterLockAuthority,
  ) {
    this.artifactRoot = join(workspaceRoot, 'artifacts');
    this.purgeIntentPath = join(this.artifactRoot, ARTIFACT_PURGE_INTENT_FILE);
    this.recoveryRequired = recoveryMode === 'authority';
    this.selfManagedRecoveryRequired = recoveryMode === 'self_managed';
  }

  close(): void {
    this.metadataRepository.close();
  }

  async create(input: CreateArtifactInput): Promise<ArtifactRecord> {
    const acceptedInput: CreateArtifactInput = Object.freeze({
      ...input,
      content: typeof input.content === 'string' ? input.content : new Uint8Array(input.content),
    });
    const id = acceptedInput.id ?? randomUUID();
    if (!ARTIFACT_KIND_SET.has(acceptedInput.kind)) throw new Error('Invalid Artifact kind');
    if (acceptedInput.source !== undefined && !ARTIFACT_SOURCE_SET.has(acceptedInput.source)) {
      throw new Error('Invalid Artifact source');
    }
    if (
      acceptedInput.deepResearchRole !== undefined &&
      !isDeepResearchArtifactRole(acceptedInput.deepResearchRole)
    ) {
      throw new Error('Invalid Artifact deep-research role');
    }
    if (
      acceptedInput.now !== undefined &&
      (!Number.isSafeInteger(acceptedInput.now) || acceptedInput.now < 0)
    ) {
      throw new Error('Invalid Artifact creation time');
    }
    assertCanonicalArtifactEntityId(id, 'id');
    assertCanonicalArtifactEntityId(acceptedInput.sessionId, 'sessionId');
    assertArtifactTurnKey(acceptedInput.turnId);
    const name = sanitizeArtifactName(acceptedInput.name);
    const relativePath = `${acceptedInput.sessionId}/${id}-${name}`;
    validateRelativeArtifactPath(relativePath);
    validateCanonicalArtifactTargetName(basename(relativePath));
    return this.enqueueMutation(async () => {
      await this.prepareMutationUnlocked({
        kind: 'create',
        input: acceptedInput,
        identity: { id, canonicalName: name },
      });
      const existing = this.records.find((record) => record.id === id);
      if (existing) {
        return this.replayExistingArtifactUnlocked(existing, acceptedInput, {
          id,
          name,
          relativePath,
        });
      }
      await this.assertNoCompatiblePublicationStagingUnlocked(acceptedInput, {
        id,
        canonicalName: name,
      });
      const adopted = await this.adoptRecoverableOrphanUnlocked(acceptedInput, {
        id,
        canonicalName: name,
      });
      if (adopted) return adopted;
      await this.assertNoCompatiblePayloadExistsUnlocked(acceptedInput, {
        id,
        canonicalName: name,
      });
      return this.publishNewArtifactUnlocked(
        {
          id,
          sessionId: acceptedInput.sessionId,
          turnId: acceptedInput.turnId,
          createdAt: acceptedInput.now ?? Date.now(),
          name,
          kind: acceptedInput.kind,
          relativePath,
          ...(acceptedInput.mimeType ? { mimeType: acceptedInput.mimeType } : {}),
          ...(acceptedInput.source ? { source: acceptedInput.source } : {}),
          ...(acceptedInput.summary ? { summary: acceptedInput.summary } : {}),
          ...(acceptedInput.deepResearchRole
            ? { deepResearchRole: acceptedInput.deepResearchRole }
            : {}),
          status: 'live',
        },
        (tempPath) => writeFile(tempPath, acceptedInput.content, { flag: 'wx' }),
      );
    });
  }

  async copyConversationArtifacts(
    input: ConversationArtifactCopyInput,
  ): Promise<ConversationArtifactCopyResult> {
    assertCanonicalArtifactEntityId(input.sourceSessionId, 'sessionId');
    assertCanonicalArtifactEntityId(input.targetSessionId, 'sessionId');
    if (input.sourceSessionId === input.targetSessionId) {
      throw new Error('Artifact conversation copy requires distinct Sessions');
    }
    const turnIds = new Set(input.turnIds);
    for (const turnId of turnIds) assertArtifactTurnKey(turnId);
    const records = await this.enqueue(async () => {
      await this.load();
      return this.records
        .filter(
          (record) => record.sessionId === input.sourceSessionId && turnIds.has(record.turnId),
        )
        .map((record) => ({ ...record }));
    });

    const artifactIds = new Map<string, string>();
    const relativePaths = new Map<string, string>();
    for (const record of records) {
      const targetId = conversationCopyArtifactId(
        input.sourceSessionId,
        input.targetSessionId,
        record.id,
      );
      const prepared = await this.enqueue(() =>
        this.prepareRecordRead(record, record.sizeBytes, true),
      );
      if (!prepared.ok) {
        throw new Error(`Artifact ${record.id} could not be copied: ${prepared.reason}`);
      }
      const created = await this.copyConversationArtifact(
        prepared,
        input.targetSessionId,
        targetId,
      );
      artifactIds.set(record.id, created.id);
      relativePaths.set(record.relativePath, created.relativePath);
    }
    return { artifactIds, relativePaths };
  }

  private copyConversationArtifact(
    prepared: PreparedArtifactRead,
    targetSessionId: string,
    targetId: string,
  ): Promise<ArtifactRecord> {
    const source = prepared.record;
    const name = sanitizeArtifactName(source.name);
    const relativePath = `${targetSessionId}/${targetId}-${name}`;
    const publicationInput = { sessionId: targetSessionId, name };
    assertCanonicalArtifactEntityId(targetId, 'id');
    validateRelativeArtifactPath(relativePath);
    validateCanonicalArtifactTargetName(basename(relativePath));
    return this.enqueueMutation(async () => {
      await this.prepareMutationUnlocked({
        kind: 'copy',
        input: publicationInput,
        identity: { id: targetId, canonicalName: name },
      });
      if (this.records.some((record) => record.id === targetId)) {
        throw new Error(`Artifact target already exists: ${targetId}`);
      }
      await this.assertNoCompatiblePublicationStagingUnlocked(publicationInput, {
        id: targetId,
        canonicalName: name,
      });
      await this.assertNoCompatiblePayloadExistsUnlocked(publicationInput, {
        id: targetId,
        canonicalName: name,
      });
      return this.publishNewArtifactUnlocked(
        {
          ...source,
          id: targetId,
          sessionId: targetSessionId,
          name,
          relativePath,
        },
        (tempPath) => copyFile(prepared.path, tempPath, fsConstants.COPYFILE_EXCL),
        source.sizeBytes,
      );
    });
  }

  private async publishNewArtifactUnlocked(
    draft: ArtifactRecordDraft,
    writeStaging: (tempPath: string) => Promise<void>,
    expectedSize?: number,
  ): Promise<ArtifactRecord> {
    const target = join(this.artifactRoot, draft.relativePath);
    const targetDirectory = dirname(target);
    const createdDirectory = await mkdir(targetDirectory, { recursive: true });
    if (createdDirectory !== undefined) {
      await syncDirectoryChain(targetDirectory, this.workspaceRoot);
    }
    await assertArtifactDirectory(this.artifactRoot, targetDirectory);
    const tempPath = join(targetDirectory, publicationStagingName(basename(target)));
    let preserveStaging = false;
    let targetLinked = false;
    try {
      await writeStaging(tempPath);
      await syncFile(tempPath);
      await syncDirectory(targetDirectory);
      const size = await stat(tempPath);
      if (expectedSize !== undefined && size.size !== expectedSize) {
        throw new Error(`Artifact source changed while copying: ${draft.id}`);
      }
      const record: ArtifactRecord = { ...draft, sizeBytes: size.size };
      const nextRecords = [...this.records, record];
      try {
        try {
          await link(tempPath, target);
          targetLinked = true;
        } catch (error) {
          if (isAlreadyExists(error)) {
            throw new Error(`Artifact target already exists: ${draft.id}`);
          }
          throw error;
        }
        await syncDirectory(targetDirectory);
        await this.writeMetadataUnlocked(nextRecords);
      } catch (error) {
        if (targetLinked) {
          try {
            await removeFileDurably(target, targetDirectory);
          } catch (cleanupError) {
            preserveStaging = true;
            this.invalidateWriterState();
            throw new AggregateError(
              [error, cleanupError],
              `Artifact ${draft.id} metadata publication and payload cleanup both failed`,
            );
          }
        }
        throw error;
      }
      this.replaceRecords(nextRecords);
      return { ...record };
    } finally {
      if (!preserveStaging) {
        try {
          await removeFileDurably(tempPath, targetDirectory);
        } catch (error) {
          this.invalidateWriterState();
          throw error;
        }
      }
    }
  }

  async purgeSessionArtifacts(sessionId: string): Promise<void> {
    assertCanonicalArtifactEntityId(sessionId, 'sessionId');
    const records = await this.list(sessionId, { includeDeleted: true });
    if (records.length > 0) await this.purge(records.map((record) => record.id));
  }

  private async replayExistingArtifactUnlocked(
    existing: ArtifactRecord,
    input: CreateArtifactInput,
    canonical: { id: string; name: string; relativePath: string },
  ): Promise<ArtifactRecord> {
    const expectedBytes = Buffer.from(input.content);
    if (
      existing.id !== canonical.id ||
      existing.sessionId !== input.sessionId ||
      existing.turnId !== input.turnId ||
      existing.name !== canonical.name ||
      existing.kind !== input.kind ||
      existing.relativePath !== `${input.sessionId}/${canonical.id}-${existing.name}` ||
      existing.sizeBytes !== expectedBytes.byteLength ||
      existing.mimeType !== optionalCanonicalText(input.mimeType) ||
      existing.source !== input.source ||
      existing.summary !== optionalCanonicalText(input.summary) ||
      existing.deepResearchRole !== input.deepResearchRole ||
      (input.now !== undefined && existing.createdAt !== input.now)
    ) {
      throw artifactReplayConflict(canonical.id);
    }

    const resolved = await resolveArtifactPath({
      artifactRoot: this.artifactRoot,
      relativePath: existing.relativePath,
    });
    if (!resolved.ok) throw artifactReplayConflict(canonical.id);
    const payloadStat = await stat(resolved.path).catch(() => null);
    if (
      !payloadStat?.isFile() ||
      payloadStat.size !== existing.sizeBytes ||
      payloadStat.size !== expectedBytes.byteLength
    ) {
      throw artifactReplayConflict(canonical.id);
    }
    const actualBytes = await readFile(resolved.path).catch(() => null);
    if (!actualBytes || sha256(actualBytes) !== sha256(expectedBytes)) {
      throw artifactReplayConflict(canonical.id);
    }

    if (existing.status === 'live') return { ...existing };
    const revived: ArtifactRecord = { ...existing, status: 'live' };
    const nextRecords = this.records.map((record) =>
      record.id === canonical.id ? revived : record,
    );
    await this.writeMetadataUnlocked(nextRecords);
    this.replaceRecords(nextRecords);
    return { ...revived };
  }

  recoverForWriteWithAuthority(): Promise<void> {
    return this.enqueueMutation(async () => {
      this.recoveryRequired = true;
      this.recoverableOrphans.clear();
      await this.prepareRecoveryUnlocked();
      this.recoverableOrphans = await this.findRecoverableOrphansUnlocked();
      this.recoveryRequired = false;
    });
  }

  async list(
    sessionId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<ArtifactRecord[]> {
    const includeDeleted = opts.includeDeleted ?? false;
    return this.enqueue(async () => {
      await this.load();
      return (
        this.records
          .filter((record) => record.sessionId === sessionId)
          .filter((record) => includeDeleted || record.status !== 'deleted')
          // Secondary `id` sort for determinism when fixture artifacts share
          // a frozen createdAt (PR108k-yj e2e-fixture determinism).
          .sort(compareArtifactRecords)
          .map((record) => ({ ...record }))
      );
    });
  }

  async get(artifactId: string): Promise<ArtifactRecord | null> {
    return this.enqueue(async () => {
      await this.load();
      const record = this.records.find((item) => item.id === artifactId);
      return record ? { ...record } : null;
    });
  }

  async listPage(
    sessionId: string,
    options: { offset: number; limit: number },
  ): Promise<ArtifactListPage> {
    assertPageBound(options.offset, true, 'offset');
    assertPageBound(options.limit, false, 'limit');
    const { offset, limit } = options;
    return this.enqueue(async () => {
      await this.load();
      const snapshot = this.sessionSnapshots.get(sessionId) ?? EMPTY_SESSION_SNAPSHOT;
      return {
        revision: snapshot.revision,
        records: snapshot.records.slice(offset, offset + limit).map((record) => ({ ...record })),
        total: snapshot.records.length,
      };
    });
  }

  async listTurnArtifacts(sessionId: string, turnId: string): Promise<ArtifactRecord[]> {
    assertCanonicalArtifactEntityId(sessionId, 'sessionId');
    assertArtifactTurnKey(turnId);
    return this.enqueue(async () => {
      await this.load();
      const snapshot = this.sessionSnapshots.get(sessionId) ?? EMPTY_SESSION_SNAPSHOT;
      return snapshot.records
        .filter((record) => record.turnId === turnId && record.status !== 'deleted')
        .map((record) => ({ ...record }));
    });
  }

  async getInSession(sessionId: string, artifactId: string): Promise<ArtifactSessionEntry> {
    return this.enqueue(async () => {
      await this.load();
      const snapshot = this.sessionSnapshots.get(sessionId) ?? EMPTY_SESSION_SNAPSHOT;
      const record = snapshot.records.find((candidate) => candidate.id === artifactId);
      return {
        revision: snapshot.revision,
        record: record ? { ...record } : null,
      };
    });
  }

  async readText(
    artifactId: string,
    opts: { maxBytes?: number; includeDeleted?: boolean } = {},
  ): Promise<ArtifactTextReadResult> {
    const prepared = await this.prepareRead(
      artifactId,
      opts.maxBytes ?? ARTIFACT_TEXT_PREVIEW_LIMIT_BYTES,
      opts.includeDeleted ?? false,
    );
    return this.readPreparedText(prepared);
  }

  async readBinary(
    artifactId: string,
    opts: { maxBytes?: number } = {},
  ): Promise<ArtifactBinaryReadResult> {
    const prepared = await this.prepareRead(
      artifactId,
      opts.maxBytes ?? ARTIFACT_BINARY_PREVIEW_LIMIT_BYTES,
      false,
    );
    return this.readPreparedBinary(prepared);
  }

  readTextInSession(
    sessionId: string,
    artifactId: string,
    opts: { maxBytes?: number } = {},
  ): Promise<ArtifactTextReadResult> {
    return this.enqueue(async () => {
      const prepared = await this.prepareReadInSessionUnlocked(
        sessionId,
        artifactId,
        opts.maxBytes ?? ARTIFACT_TEXT_PREVIEW_LIMIT_BYTES,
      );
      return this.readPreparedText(prepared);
    });
  }

  readBinaryInSession(
    sessionId: string,
    artifactId: string,
    opts: { maxBytes?: number } = {},
  ): Promise<ArtifactBinaryReadResult> {
    return this.enqueue(async () => {
      const prepared = await this.prepareReadInSessionUnlocked(
        sessionId,
        artifactId,
        opts.maxBytes ?? ARTIFACT_BINARY_PREVIEW_LIMIT_BYTES,
      );
      return this.readPreparedBinary(prepared);
    });
  }

  readChunkInSession(
    sessionId: string,
    artifactId: string,
    options: { offset: number; maxBytes: number },
  ): Promise<ArtifactChunkReadResult> {
    return this.enqueue(async () => {
      if (
        !Number.isSafeInteger(options.offset) ||
        options.offset < 0 ||
        !Number.isSafeInteger(options.maxBytes) ||
        options.maxBytes < 1
      ) {
        return { ok: false, reason: 'out_of_range' };
      }
      const prepared = await this.prepareReadInSessionUnlocked(
        sessionId,
        artifactId,
        Number.MAX_SAFE_INTEGER,
      );
      return prepared.ok ? readPreparedChunk(prepared, options.offset, options.maxBytes) : prepared;
    });
  }

  async readDurableAttachmentBinary(input: {
    artifactId: string;
    sessionId: string;
    maxBytes?: number;
  }): Promise<DurableArtifactBinaryReadResult> {
    return this.enqueue(async () => {
      await this.load();
      const record = this.records.find((item) => item.id === input.artifactId);
      if (!record) return { ok: false, reason: 'not_found' };
      if (record.sessionId !== input.sessionId) {
        return { ok: false, reason: 'session_mismatch' };
      }
      const prepared = await this.prepareRecordRead(
        record,
        input.maxBytes ?? ARTIFACT_BINARY_PREVIEW_LIMIT_BYTES,
        false,
      );
      return this.readPreparedBinary(prepared);
    });
  }

  private async readPreparedText(
    prepared: PreparedArtifactRead | ArtifactReadFailure,
  ): Promise<ArtifactTextReadResult> {
    if (!prepared.ok) return prepared;
    const bytes = await readPreparedBytes(prepared);
    return bytes.ok ? { ok: true, text: bytes.bytes.toString('utf8') } : bytes;
  }

  private async readPreparedBinary(
    prepared: PreparedArtifactRead | ArtifactReadFailure,
  ): Promise<ArtifactBinaryReadResult> {
    if (!prepared.ok) return prepared;
    const read = await readPreparedBytes(prepared);
    if (!read.ok) return read;
    const mimeType = sniffAllowedBinaryMime(read.bytes);
    if (!mimeType) return { ok: false, reason: 'unsupported_mime' };
    return { ok: true, base64: read.bytes.toString('base64'), mimeType };
  }

  async delete(artifactId: string): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.prepareMutationUnlocked({ kind: 'delete' });
      const nextRecords: ArtifactRecord[] = this.records.map((record) =>
        record.id === artifactId && record.status !== 'deleted'
          ? { ...record, status: 'deleted' }
          : record,
      );
      if (nextRecords.every((record, index) => record === this.records[index])) return;
      await this.writeMetadataUnlocked(nextRecords);
      this.replaceRecords(nextRecords);
    });
  }

  deleteUserArtifactInSession(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactUserDeleteResult> {
    return this.enqueueMutation(async () => {
      await this.prepareMutationUnlocked({ kind: 'delete' });
      const snapshot = this.sessionSnapshots.get(sessionId) ?? EMPTY_SESSION_SNAPSHOT;
      const existing = snapshot.records.find((record) => record.id === artifactId);
      if (!existing) return { kind: 'not_found' };
      if (!canUserDeleteArtifact(existing)) return { kind: 'protected' };
      if (existing.status === 'deleted') {
        return { kind: 'deleted', record: { ...existing } };
      }
      const tombstone: ArtifactRecord = { ...existing, status: 'deleted' };
      const nextRecords = this.records.map((record) =>
        record.id === existing.id ? tombstone : record,
      );
      await this.writeMetadataUnlocked(nextRecords);
      this.replaceRecords(nextRecords);
      return { kind: 'deleted', record: { ...tombstone } };
    });
  }

  async purge(artifactIds: readonly string[]): Promise<void> {
    const acceptedArtifactIds = Object.freeze([...artifactIds]);
    await this.enqueueMutation(async () => {
      await this.prepareMutationUnlocked({ kind: 'purge' });
      const ids = new Set(acceptedArtifactIds);
      const records = this.records.filter((record) => ids.has(record.id));
      if (records.length === 0) return;
      const paths = await this.preparePurgePathsUnlocked(records);
      try {
        await this.publishPurgeIntentUnlocked(records.map((record) => record.id));
        await this.completePurgeUnlocked(ids, paths);
      } catch (error) {
        this.invalidateWriterState();
        throw error;
      }
    });
  }

  private async preparePurgePathsUnlocked(
    records: readonly ArtifactRecord[],
  ): Promise<readonly string[]> {
    const root = await ensureRealDirectory(this.artifactRoot);
    const ids = new Set(records.map((record) => record.id));
    const entries = new Map<
      string,
      { readonly unlinkPath: string; readonly record: ArtifactRecord }
    >();
    const relativePaths = new Map(records.map((record) => [record.relativePath, record] as const));
    for (const record of records) {
      validateRelativeArtifactPath(record.relativePath);
      const entry = await resolveArtifactRemovalEntry(this.artifactRoot, record.relativePath);
      if (!entry) continue;
      if (!isInsideOrSamePath(root, dirname(entry.unlinkPath))) {
        throw new Error(`Artifact ${record.id} resolves outside the artifact root`);
      }
      entries.set(entry.comparisonIdentity, { unlinkPath: entry.unlinkPath, record });
    }
    for (const record of this.records) {
      if (ids.has(record.id)) continue;
      const exactTarget = relativePaths.get(record.relativePath);
      if (exactTarget) {
        throw new Error(
          `Artifact ${exactTarget.id} path is still referenced by artifact ${record.id}`,
        );
      }
      const entry = await resolveArtifactRemovalEntry(this.artifactRoot, record.relativePath);
      const target = entry ? entries.get(entry.comparisonIdentity)?.record : undefined;
      if (target) {
        throw new Error(`Artifact ${target.id} path is still referenced by artifact ${record.id}`);
      }
    }
    return [...entries.values()].map((entry) => entry.unlinkPath);
  }

  private async completePurgeUnlocked(
    ids: ReadonlySet<string>,
    paths: readonly string[],
  ): Promise<void> {
    const changedDirectories = new Set<string>();
    try {
      for (const path of paths) {
        await rm(path, { force: true });
        changedDirectories.add(dirname(path));
      }
    } finally {
      for (const directory of changedDirectories) await syncDirectory(directory);
    }
    const nextRecords = this.records.filter((record) => !ids.has(record.id));
    await this.writeMetadataUnlocked(nextRecords);
    this.replaceRecords(nextRecords);
    await this.removePurgeIntentUnlocked();
  }

  private async prepareRead(
    artifactId: string,
    maxBytes: number,
    includeDeleted = false,
  ): Promise<PreparedArtifactRead | ArtifactReadFailure> {
    const record = await this.get(artifactId);
    if (!record) return { ok: false, reason: 'not_found' };
    return this.prepareRecordRead(record, maxBytes, includeDeleted);
  }

  private async prepareReadInSessionUnlocked(
    sessionId: string,
    artifactId: string,
    maxBytes: number,
  ): Promise<PreparedArtifactRead | ArtifactReadFailure> {
    await this.load();
    const snapshot = this.sessionSnapshots.get(sessionId) ?? EMPTY_SESSION_SNAPSHOT;
    const record = snapshot.records.find((candidate) => candidate.id === artifactId);
    if (!record) return { ok: false, reason: 'not_found' };
    return this.prepareRecordRead(record, maxBytes, false);
  }

  private async prepareRecordRead(
    record: ArtifactRecord,
    maxBytes: number,
    includeDeleted: boolean,
  ): Promise<PreparedArtifactRead | ArtifactReadFailure> {
    if (record.status === 'deleted' && !includeDeleted) return { ok: false, reason: 'deleted' };
    const resolved = await resolveArtifactPath({
      artifactRoot: this.artifactRoot,
      relativePath: record.relativePath,
    });
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    return { ok: true, path: resolved.path, record, maxBytes };
  }

  private async load(): Promise<void> {
    await this.metadataRepository.ready();
    this.metadataReady = true;
    this.replaceRecords(this.metadataRepository.readAll());
  }

  private async writeMetadataUnlocked(records: readonly ArtifactRecord[]): Promise<void> {
    await this.metadataRepository.ready();
    this.metadataReady = true;
    this.metadataRepository.replaceAll(records);
  }

  private async prepareMutationUnlocked(
    purpose:
      | {
          readonly kind: 'create';
          readonly input: CreateArtifactInput;
          readonly identity: { readonly id: string; readonly canonicalName: string };
        }
      | {
          readonly kind: 'copy';
          readonly input: Pick<CreateArtifactInput, 'sessionId' | 'name'>;
          readonly identity: { readonly id: string; readonly canonicalName: string };
        }
      | { readonly kind: 'delete' | 'purge' },
  ): Promise<void> {
    if (this.recoveryMode === 'self_managed') {
      this.recoverableOrphans.clear();
      if (this.selfManagedRecoveryRequired) {
        await this.prepareRecoveryUnlocked();
        this.selfManagedRecoveryRequired = false;
      } else {
        await this.reloadForMutationUnlocked();
        await this.recoverPurgeIntentUnlocked();
      }
      if (purpose.kind === 'create' || purpose.kind === 'copy') {
        await this.recoverCompatiblePublicationsUnlocked(purpose.input, purpose.identity);
      }
      if (purpose.kind === 'create') {
        this.recoverableOrphans = await this.findCompatibleRecoverableOrphansUnlocked(
          purpose.input,
          purpose.identity,
        );
      }
      return;
    }
    await this.reloadForMutationUnlocked();
    if (this.recoveryRequired) throw artifactWriteRecoveryRequired();
    if (!(await this.hasCanonicalRecoveryResidueUnlocked())) return;
    this.recoveryRequired = true;
    throw artifactWriteRecoveryRequired();
  }

  private async reloadForMutationUnlocked(): Promise<void> {
    await this.metadataRepository.ready();
    this.metadataReady = true;
    this.replaceRecords(this.metadataRepository.readAll());
  }

  private async hasCanonicalRecoveryResidueUnlocked(): Promise<boolean> {
    try {
      await lstat(this.purgeIntentPath);
      return true;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }

    let sessionEntries: Dirent[];
    try {
      sessionEntries = await readdir(this.artifactRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    if (sessionEntries.some((entry) => isArtifactPurgeRecoveryTempName(entry.name))) {
      return true;
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const entries = await readdir(join(this.artifactRoot, sessionEntry.name), {
        withFileTypes: true,
      });
      if (entries.some((entry) => ARTIFACT_PUBLICATION_STAGING_PATTERN.test(entry.name))) {
        return true;
      }
    }
    return false;
  }

  private async prepareRecoveryUnlocked(): Promise<void> {
    await this.reloadForMutationUnlocked();
    try {
      await syncDirectory(this.artifactRoot);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    await this.recoverMetadataTempsUnlocked();
    await this.recoverPublicationsUnlocked();
    await this.recoverPurgeIntentUnlocked();
  }

  private async adoptRecoverableOrphanUnlocked(
    input: CreateArtifactInput,
    identity: { id: string; canonicalName: string },
  ): Promise<ArtifactRecord | null> {
    const names = [identity.canonicalName];
    const candidates = names
      .map((name) => ({
        name,
        relativePath: `${input.sessionId}/${identity.id}-${name}`,
      }))
      .map((candidate) => ({
        ...candidate,
        fingerprint: this.recoverableOrphans.get(filesystemPathKey(candidate.relativePath)),
      }))
      .filter(
        (
          candidate,
        ): candidate is typeof candidate & {
          readonly fingerprint: RecoverableOrphan;
        } => candidate.fingerprint !== undefined,
      );
    if (candidates.length === 0) return null;
    if (candidates.length !== 1) throw artifactReplayConflict(identity.id);

    const candidate = candidates[0]!;
    const resolved = await resolveArtifactPath({
      artifactRoot: this.artifactRoot,
      relativePath: candidate.relativePath,
    });
    if (!resolved.ok) throw artifactReplayConflict(identity.id);
    const expectedBytes = Buffer.from(input.content);
    const payloadStat = await lstat(resolved.path).catch(() => null);
    const expectedDigest = sha256(expectedBytes);
    if (
      !payloadStat?.isFile() ||
      payloadStat.isSymbolicLink() ||
      payloadStat.size !== expectedBytes.byteLength ||
      candidate.fingerprint.canonicalPath !== resolved.path ||
      candidate.fingerprint.dev !== payloadStat.dev ||
      candidate.fingerprint.ino !== payloadStat.ino ||
      candidate.fingerprint.size !== payloadStat.size ||
      candidate.fingerprint.digest !== expectedDigest ||
      (await digestFile(resolved.path)) !== expectedDigest
    ) {
      throw artifactReplayConflict(identity.id);
    }

    const record: ArtifactRecord = {
      id: identity.id,
      sessionId: input.sessionId,
      turnId: input.turnId,
      createdAt: input.now ?? Date.now(),
      name: candidate.name,
      kind: input.kind,
      relativePath: candidate.relativePath,
      sizeBytes: payloadStat.size,
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.deepResearchRole ? { deepResearchRole: input.deepResearchRole } : {}),
      status: 'live',
    };
    const nextRecords = [...this.records, record];
    await this.writeMetadataUnlocked(nextRecords);
    this.replaceRecords(nextRecords);
    this.recoverableOrphans.delete(filesystemPathKey(candidate.relativePath));
    return { ...record };
  }

  private async findRecoverableOrphansUnlocked(): Promise<Map<string, RecoverableOrphan>> {
    const orphans = new Map<string, RecoverableOrphan>();
    const referencedPaths = new Set(
      this.records.map((record) => filesystemPathKey(record.relativePath)),
    );
    let sessionEntries: Dirent[];
    try {
      sessionEntries = await readdir(this.artifactRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return orphans;
      throw error;
    }
    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory() || !isCanonicalArtifactEntityId(sessionEntry.name)) continue;
      const sessionDirectory = join(this.artifactRoot, sessionEntry.name);
      await assertArtifactDirectory(this.artifactRoot, sessionDirectory);
      for (const entry of await readdir(sessionDirectory, { withFileTypes: true })) {
        if (!entry.isFile() || ARTIFACT_PUBLICATION_STAGING_PATTERN.test(entry.name)) continue;
        const relativePath = `${sessionEntry.name}/${entry.name}`;
        if (referencedPaths.has(filesystemPathKey(relativePath))) continue;
        const path = join(sessionDirectory, entry.name);
        const [canonicalPath, pathStat] = await Promise.all([realpath(path), lstat(path)]);
        if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
          throw new Error(
            `Artifact orphan changed while recovery was inspecting it: ${relativePath}`,
          );
        }
        orphans.set(filesystemPathKey(relativePath), {
          canonicalPath,
          dev: pathStat.dev,
          ino: pathStat.ino,
          size: pathStat.size,
          digest: await digestFile(path),
        });
      }
    }
    return orphans;
  }

  private async findCompatibleRecoverableOrphansUnlocked(
    input: CreateArtifactInput,
    identity: { id: string; canonicalName: string },
  ): Promise<Map<string, RecoverableOrphan>> {
    const orphans = new Map<string, RecoverableOrphan>();
    const sessionDirectory = join(this.artifactRoot, input.sessionId);
    try {
      await assertArtifactDirectory(this.artifactRoot, sessionDirectory);
    } catch (error) {
      if (isNotFound(error)) return orphans;
      throw error;
    }
    const referencedPaths = new Set(
      this.records.map((record) => filesystemPathKey(record.relativePath)),
    );
    for (const name of [identity.canonicalName]) {
      const relativePath = `${input.sessionId}/${identity.id}-${name}`;
      if (referencedPaths.has(filesystemPathKey(relativePath))) continue;
      const path = join(this.artifactRoot, relativePath);
      let pathStat;
      try {
        pathStat = await lstat(path);
      } catch (error) {
        if (isNotFound(error)) continue;
        throw error;
      }
      if (!pathStat.isFile() || pathStat.isSymbolicLink()) continue;
      orphans.set(filesystemPathKey(relativePath), {
        canonicalPath: await realpath(path),
        dev: pathStat.dev,
        ino: pathStat.ino,
        size: pathStat.size,
        digest: await digestFile(path),
      });
    }
    return orphans;
  }

  private async recoverCompatiblePublicationsUnlocked(
    input: Pick<CreateArtifactInput, 'sessionId' | 'name'>,
    identity: { id: string; canonicalName: string },
  ): Promise<void> {
    const sessionDirectory = join(this.artifactRoot, input.sessionId);
    const targetHashes = new Set(
      [identity.canonicalName].map((name) => artifactTargetHash(`${identity.id}-${name}`)),
    );
    let entries: Dirent[];
    try {
      entries = await readdir(sessionDirectory, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const match = ARTIFACT_PUBLICATION_STAGING_PATTERN.exec(entry.name);
      if (!match || !targetHashes.has(match[1]!)) continue;
      await this.recoverPublicationUnlocked({
        sessionId: input.sessionId,
        sessionDirectory,
        stagingName: entry.name,
        targetHash: match[1]!,
      });
    }
  }

  private async assertNoCompatiblePayloadExistsUnlocked(
    input: Pick<CreateArtifactInput, 'sessionId' | 'name'>,
    identity: { id: string; canonicalName: string },
  ): Promise<void> {
    const names = new Set([identity.canonicalName]);
    for (const name of names) {
      const path = join(this.artifactRoot, input.sessionId, `${identity.id}-${name}`);
      try {
        await lstat(path);
        throw new Error(`Artifact target already exists: ${identity.id}`);
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
    }
  }

  private async assertNoCompatiblePublicationStagingUnlocked(
    input: Pick<CreateArtifactInput, 'sessionId' | 'name'>,
    identity: { id: string; canonicalName: string },
  ): Promise<void> {
    const targetHashes = new Set(
      [identity.canonicalName].map((name) => artifactTargetHash(`${identity.id}-${name}`)),
    );
    let entries: Dirent[];
    try {
      entries = await readdir(join(this.artifactRoot, input.sessionId), { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const match = ARTIFACT_PUBLICATION_STAGING_PATTERN.exec(entry.name);
      if (match && targetHashes.has(match[1]!)) {
        throw new Error(`Artifact target already exists: ${identity.id}`);
      }
    }
  }

  private invalidateWriterState(): void {
    if (this.recoveryMode === 'authority') this.recoveryRequired = true;
    else this.selfManagedRecoveryRequired = true;
  }

  private bindMutationRoot(canonicalRoot: string): void {
    if (this.workspaceRoot === canonicalRoot) return;
    this.workspaceRoot = canonicalRoot;
    this.artifactRoot = join(canonicalRoot, 'artifacts');
    this.purgeIntentPath = join(this.artifactRoot, ARTIFACT_PURGE_INTENT_FILE);
    this.replaceRecords([]);
    this.recoverableOrphans.clear();
    if (this.recoveryMode === 'self_managed') this.selfManagedRecoveryRequired = true;
  }

  private replaceRecords(records: ArtifactRecord[]): void {
    const bySession = new Map<string, ArtifactRecord[]>();
    for (const record of records) {
      const sessionRecords = bySession.get(record.sessionId);
      if (sessionRecords) sessionRecords.push(record);
      else bySession.set(record.sessionId, [record]);
    }
    const snapshots = new Map<string, ArtifactSessionSnapshot>();
    for (const [sessionId, sessionRecords] of bySession) {
      sessionRecords.sort(compareArtifactRecords);
      snapshots.set(sessionId, {
        records: sessionRecords,
        revision: artifactListRevision(sessionRecords),
      });
    }
    this.records = records;
    this.sessionSnapshots = snapshots;
  }

  private async publishPurgeIntentUnlocked(artifactIds: readonly string[]): Promise<void> {
    const contents = JSON.stringify({
      schemaVersion: PURGE_INTENT_SCHEMA_VERSION,
      artifactIds,
    });
    const result = await publishMarkerFile({
      root: this.artifactRoot,
      markerFile: ARTIFACT_PURGE_INTENT_FILE,
      contents,
      maxBytes: MAX_PURGE_INTENT_BYTES,
      publication: 'create',
      invalidFile: invalidPurgeIntent,
    });
    if (result === 'already_exists') {
      throw new Error('Artifact purge intent already exists');
    }
  }

  private async recoverPurgeIntentUnlocked(): Promise<void> {
    let contents: string;
    try {
      contents = await readBoundedMarkerFile({
        path: this.purgeIntentPath,
        maxBytes: MAX_PURGE_INTENT_BYTES,
        invalidFile: invalidPurgeIntent,
      });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    const intent = parsePurgeIntent(contents);
    const ids = new Set(intent.artifactIds);
    const records = this.records.filter((record) => ids.has(record.id));
    if (records.length === 0) {
      await this.removePurgeIntentUnlocked();
      return;
    }
    if (records.length !== intent.artifactIds.length) {
      throw invalidPurgeIntent();
    }
    const paths = await this.preparePurgePathsUnlocked(records);
    await this.completePurgeUnlocked(ids, paths);
  }

  private async removePurgeIntentUnlocked(): Promise<void> {
    try {
      await unlink(this.purgeIntentPath);
      await syncDirectory(this.artifactRoot);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }

  private async recoverMetadataTempsUnlocked(): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.artifactRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }
    for (const entry of entries) {
      if (!isArtifactPurgeRecoveryTempName(entry.name)) continue;
      if (!entry.isFile()) {
        throw new Error(`Artifact recovery temp is not a regular file: ${entry.name}`);
      }
      await removeFileDurably(join(this.artifactRoot, entry.name), this.artifactRoot);
    }
  }

  private async recoverPublicationsUnlocked(): Promise<void> {
    let sessionEntries: Dirent[];
    try {
      sessionEntries = await readdir(this.artifactRoot, { withFileTypes: true });
    } catch (error) {
      if (isNotFound(error)) return;
      throw error;
    }

    for (const sessionEntry of sessionEntries) {
      if (!sessionEntry.isDirectory()) continue;
      const sessionDirectory = join(this.artifactRoot, sessionEntry.name);
      const entries = await readdir(sessionDirectory, { withFileTypes: true });
      for (const entry of entries) {
        const match = ARTIFACT_PUBLICATION_STAGING_PATTERN.exec(entry.name);
        if (!match) continue;
        await this.recoverPublicationUnlocked({
          sessionId: sessionEntry.name,
          sessionDirectory,
          stagingName: entry.name,
          targetHash: match[1]!,
        });
      }
    }
  }

  private async recoverPublicationUnlocked(input: {
    sessionId: string;
    sessionDirectory: string;
    stagingName: string;
    targetHash: string;
  }): Promise<void> {
    const stagingPath = join(input.sessionDirectory, input.stagingName);
    const stagingStat = await lstat(stagingPath);
    if (!stagingStat.isFile() || stagingStat.isSymbolicLink()) {
      throw invalidPublicationResidue(input.stagingName);
    }

    const metadataMatches = this.records.filter(
      (record) =>
        record.sessionId === input.sessionId &&
        artifactTargetHash(basename(record.relativePath)) === input.targetHash,
    );
    if (metadataMatches.length > 1) throw invalidPublicationResidue(input.stagingName);

    const directoryEntries = await readdir(input.sessionDirectory, { withFileTypes: true });
    const matchingTargets: Array<{ name: string; path: string; size: number }> = [];
    for (const entry of directoryEntries) {
      if (entry.name === input.stagingName || ARTIFACT_PUBLICATION_STAGING_PATTERN.test(entry.name))
        continue;
      if (artifactTargetHash(entry.name) !== input.targetHash) continue;
      const candidatePath = join(input.sessionDirectory, entry.name);
      const candidateStat = await lstat(candidatePath);
      if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
        throw invalidPublicationResidue(input.stagingName);
      }
      matchingTargets.push({
        name: entry.name,
        path: candidatePath,
        size: candidateStat.size,
      });
    }

    const metadataRecord = metadataMatches[0];
    if (matchingTargets.length === 0 && !metadataRecord) {
      await removeFileDurably(stagingPath, input.sessionDirectory);
      return;
    }
    if (matchingTargets.length !== 1) {
      throw invalidPublicationResidue(input.stagingName);
    }

    const [linkedTarget] = matchingTargets;
    if (
      !linkedTarget ||
      linkedTarget.size !== stagingStat.size ||
      (await digestFile(linkedTarget.path)) !== (await digestFile(stagingPath))
    ) {
      throw invalidPublicationResidue(input.stagingName);
    }
    const relativePath = `${input.sessionId}/${linkedTarget.name}`;
    validateRelativeArtifactPath(relativePath);

    if (metadataRecord) {
      if (
        metadataRecord.relativePath !== relativePath ||
        metadataRecord.sizeBytes !== linkedTarget.size
      ) {
        throw invalidPublicationResidue(input.stagingName);
      }
      await removeFileDurably(stagingPath, input.sessionDirectory);
      return;
    }

    await removeFileDurably(
      join(input.sessionDirectory, linkedTarget.name),
      input.sessionDirectory,
    );
    await removeFileDurably(stagingPath, input.sessionDirectory);
  }

  private enqueueSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueueSerialized(async () => {
      if (!this.metadataReady) {
        return this.runWithWriterLock(async () => {
          await this.assertAuthority?.();
          await this.metadataRepository.ready();
          this.metadataReady = true;
          return operation();
        });
      }
      await this.assertAuthority?.();
      return operation();
    });
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueueSerialized(() =>
      this.runWithWriterLock(async () => {
        await this.assertAuthority?.();
        return operation();
      }),
    );
  }

  private runWithWriterLock<T>(operation: () => Promise<T>): Promise<T> {
    const leaseBoundWriterLockAuthority = this.leaseBoundWriterLockAuthority;
    if (leaseBoundWriterLockAuthority) {
      return withLeaseBoundArtifactWriterLock(leaseBoundWriterLockAuthority, operation);
    }
    return withArtifactWriterLock(this.workspaceRoot, async (canonicalRoot) => {
      this.bindMutationRoot(canonicalRoot);
      return operation();
    });
  }
}

function publicationStagingName(targetBasename: string): string {
  return `.artifact-publish.${artifactTargetHash(targetBasename)}.${randomUUID()}.tmp`;
}

async function openRealTarget(path: string) {
  const noFollowFlags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW;
  try {
    return await open(path, noFollowFlags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== 'win32' || (code !== 'EINVAL' && code !== 'ENOTSUP')) throw error;
    return open(path, fsConstants.O_RDONLY);
  }
}

async function readPreparedBytes(
  prepared: PreparedArtifactRead,
): Promise<{ readonly ok: true; readonly bytes: Buffer } | ArtifactReadFailure> {
  let handle;
  try {
    handle = await openRealTarget(prepared.path);
    const payloadStat = await handle.stat();
    if (!payloadStat.isFile()) return { ok: false, reason: 'not_found' };
    if (payloadStat.size > prepared.maxBytes) return { ok: false, reason: 'too_large' };

    const bytes = Buffer.alloc(payloadStat.size + 1);
    let total = 0;
    while (total < bytes.byteLength) {
      const read = await handle.read(bytes, total, bytes.byteLength - total, total);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
    }
    if (total !== payloadStat.size || total > prepared.maxBytes) {
      return { ok: false, reason: total > prepared.maxBytes ? 'too_large' : 'read_failed' };
    }
    return { ok: true, bytes: bytes.subarray(0, total) };
  } catch {
    return { ok: false, reason: 'read_failed' };
  } finally {
    await handle?.close();
  }
}

async function readPreparedChunk(
  prepared: PreparedArtifactRead,
  offset: number,
  maxBytes: number,
): Promise<ArtifactChunkReadResult> {
  let handle;
  try {
    handle = await openRealTarget(prepared.path);
    const payloadStat = await handle.stat();
    if (!payloadStat.isFile()) return { ok: false, reason: 'not_found' };
    if (offset > payloadStat.size) return { ok: false, reason: 'out_of_range' };
    const expected = Math.min(maxBytes, payloadStat.size - offset);
    const bytes = Buffer.alloc(expected);
    let total = 0;
    while (total < expected) {
      const read = await handle.read(bytes, total, expected - total, offset + total);
      if (read.bytesRead === 0) break;
      total += read.bytesRead;
    }
    if (total !== expected) return { ok: false, reason: 'read_failed' };
    const nextOffset = offset + total;
    return {
      ok: true,
      bytes,
      offset,
      totalBytes: payloadStat.size,
      nextOffset: nextOffset < payloadStat.size ? nextOffset : null,
    };
  } catch {
    return { ok: false, reason: 'read_failed' };
  } finally {
    await handle?.close();
  }
}

function artifactTargetHash(targetBasename: string): string {
  return createHash('sha256').update(targetBasename).digest('hex');
}

function invalidPublicationResidue(stagingName: string): Error {
  return new Error(`Artifact publication residue does not match canonical state: ${stagingName}`);
}

function artifactReplayConflict(artifactId: string): Error {
  return new Error(`Artifact ${artifactId} already exists with different metadata or content`);
}

function conversationCopyArtifactId(
  sourceSessionId: string,
  targetSessionId: string,
  sourceArtifactId: string,
): string {
  return `copy_${createHash('sha256')
    .update(JSON.stringify([sourceSessionId, targetSessionId, sourceArtifactId]))
    .digest('hex')}`;
}

function artifactWriteRecoveryRequired(): Error {
  return new Error('Artifact write recovery is required before another mutation');
}

function optionalCanonicalText(value: string | undefined): string | undefined {
  return value ? value : undefined;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function artifactListRevision(records: readonly ArtifactRecord[]): ArtifactListRevision {
  return `sha256:${createHash('sha256').update(JSON.stringify(records)).digest('hex')}`;
}

function compareArtifactRecords(a: ArtifactRecord, b: ArtifactRecord): number {
  const timestampDelta = b.createdAt - a.createdAt;
  return timestampDelta !== 0 ? timestampDelta : a.id.localeCompare(b.id);
}

function sameArtifactRecord(a: ArtifactRecord, b: ArtifactRecord): boolean {
  return (
    a.id === b.id &&
    a.sessionId === b.sessionId &&
    a.turnId === b.turnId &&
    a.createdAt === b.createdAt &&
    a.name === b.name &&
    a.kind === b.kind &&
    a.relativePath === b.relativePath &&
    a.sizeBytes === b.sizeBytes &&
    a.mimeType === b.mimeType &&
    a.source === b.source &&
    a.summary === b.summary &&
    a.deepResearchRole === b.deepResearchRole &&
    a.status === b.status
  );
}

function assertPageBound(value: number, allowZero: boolean, label: string): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`Artifact page ${label} is invalid`);
  }
}

async function digestFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function resolveArtifactPath(input: {
  artifactRoot: string;
  relativePath: string;
}): Promise<
  { ok: true; path: string } | { ok: false; reason: 'not_found' | 'not_allowed' | 'read_failed' }
> {
  if (!isSafeRelativeArtifactPath(input.relativePath)) return { ok: false, reason: 'not_allowed' };
  const target = join(input.artifactRoot, input.relativePath);
  let root: string;
  let resolvedTarget: string;
  try {
    root = await ensureRealDirectory(input.artifactRoot);
    resolvedTarget = await realpath(target);
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  if (!isInsideOrSamePath(root, resolvedTarget)) return { ok: false, reason: 'not_allowed' };
  return { ok: true, path: resolvedTarget };
}

export function sanitizeArtifactName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|\0]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[ .-]+/, '')
    .replace(/[ .-]+$/, '');
  const truncated = truncateWithoutSplittingSurrogate(cleaned, 120).replace(/[ .-]+$/, '');
  return truncated || 'artifact';
}

function filesystemPathKey(path: string): string {
  return Buffer.from(path, 'utf8').toString('utf8');
}

function truncateWithoutSplittingSurrogate(value: string, maxCodeUnits: number): string {
  const truncated = value.slice(0, maxCodeUnits);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

async function removeFileDurably(path: string, directory: string): Promise<boolean> {
  try {
    await unlink(path);
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
  await syncDirectory(directory);
  return true;
}

function assertCanonicalArtifactEntityId(
  value: unknown,
  field: 'id' | 'sessionId',
): asserts value is string {
  if (!isCanonicalArtifactEntityId(value)) {
    throw new Error(
      `Artifact ${field} must be a canonical entity ID of 1-${ARTIFACT_ENTITY_ID_MAX_CHARS} ASCII letters, digits, "_" or "-"`,
    );
  }
}

function assertArtifactTurnKey(value: unknown): asserts value is string {
  if (!isArtifactTurnKey(value)) {
    throw new Error('Artifact turnId must be a bounded opaque turn key without control characters');
  }
}

interface ArtifactPurgeIntent {
  schemaVersion: typeof PURGE_INTENT_SCHEMA_VERSION;
  artifactIds: string[];
}

function parsePurgeIntent(contents: string): ArtifactPurgeIntent {
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw invalidPurgeIntent();
  }
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => key !== 'schemaVersion' && key !== 'artifactIds') ||
    value.schemaVersion !== PURGE_INTENT_SCHEMA_VERSION ||
    !Array.isArray(value.artifactIds) ||
    value.artifactIds.length === 0 ||
    !value.artifactIds.every(isCanonicalArtifactEntityId) ||
    new Set(value.artifactIds).size !== value.artifactIds.length
  ) {
    throw invalidPurgeIntent();
  }
  return {
    schemaVersion: PURGE_INTENT_SCHEMA_VERSION,
    artifactIds: value.artifactIds,
  };
}

function invalidPurgeIntent(): Error {
  return new Error('Invalid artifact purge intent');
}

const ARTIFACT_KIND_SET = new Set<ArtifactKind>(ARTIFACT_KINDS);
const ARTIFACT_SOURCE_SET = new Set<ArtifactSource>(ARTIFACT_SOURCES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function assertArtifactDirectory(artifactRoot: string, directory: string): Promise<void> {
  const root = await ensureRealDirectory(artifactRoot);
  const resolvedDirectory = await realpath(directory);
  if (!isInsideOrSamePath(root, resolvedDirectory)) {
    throw new Error('Artifact target directory resolves outside the artifact root');
  }
}

async function ensureRealDirectory(path: string): Promise<string> {
  await access(path, fsConstants.R_OK);
  return realpath(path);
}

async function resolveArtifactRemovalEntry(
  artifactRoot: string,
  relativePath: string,
): Promise<ArtifactRemovalEntry | undefined> {
  const target = join(artifactRoot, relativePath);
  try {
    const parent = await realpath(dirname(target));
    const entry = join(parent, basename(target));
    const entryStat = await lstat(entry, { bigint: true });
    if (entryStat.isSymbolicLink()) {
      return {
        unlinkPath: entry,
        comparisonIdentity: symlinkEntryIdentity(entryStat),
      };
    }
    const resolvedEntry = await realpath(entry);
    return {
      unlinkPath: resolvedEntry,
      comparisonIdentity: `path:${resolvedEntry}`,
    };
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function symlinkEntryIdentity(entryStat: BigIntStats): string {
  if (entryStat.dev !== 0n || entryStat.ino !== 0n) {
    return `symlink:${entryStat.dev}:${entryStat.ino}`;
  }
  return [
    'symlink-stat',
    entryStat.mode,
    entryStat.size,
    entryStat.birthtimeNs,
    entryStat.ctimeNs,
    entryStat.mtimeNs,
  ].join(':');
}

function isInsideOrSamePath(root: string, target: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  return (
    rel !== '' &&
    !rel.startsWith('..') &&
    rel !== '..' &&
    !rel.includes(`..${sep}`) &&
    !rel.startsWith(sep)
  );
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function sniffAllowedBinaryMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (asciiStartsWith(bytes, 'GIF87a') || asciiStartsWith(bytes, 'GIF89a')) return 'image/gif';
  if (
    asciiStartsWith(bytes, 'RIFF') &&
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP'
  ) {
    return 'image/webp';
  }
  if (asciiStartsWith(bytes, '%PDF-')) return 'application/pdf';
  const leading = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(0, Math.min(bytes.length, 512)))
    .trimStart();
  if (/^<svg[\s>]/i.test(leading) || /^<\?xml[\s\S]*<svg[\s>]/i.test(leading))
    return 'image/svg+xml';
  return null;
}

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

function asciiStartsWith(bytes: Uint8Array, prefix: string): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.split('').every((char, index) => bytes[index] === char.charCodeAt(0));
}
