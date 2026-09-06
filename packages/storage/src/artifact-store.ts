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
import { type BigIntStats, constants as fsConstants } from 'node:fs';
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
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
import { sniffAttachmentMimeType } from '@maka/core/attachments';
import {
  isSafeRelativeArtifactPath,
  validateRelativeArtifactPath,
} from './artifact-metadata-codec.js';
import {
  withArtifactWriterLock,
  withLeaseBoundArtifactWriterLock,
} from './artifact-writer-lock.js';
import type { ArtifactWriterLockAuthority } from './root-authority.js';
import { syncDirectory, syncDirectoryChain, syncFile } from './stable-storage.js';
import {
  createSqliteArtifactMetadataRepository,
  type ArtifactMetadataChanges,
} from './sqlite-artifact-metadata.js';

export { isSafeRelativeArtifactPath } from './artifact-metadata-codec.js';

export const ARTIFACT_TEXT_PREVIEW_LIMIT_BYTES = 10 * 1024 * 1024;
export const ARTIFACT_BINARY_PREVIEW_LIMIT_BYTES = 50 * 1024 * 1024;

const ARTIFACT_PURGE_RESOLVE_CONCURRENCY = 8;
interface ArtifactSessionSnapshot {
  readonly records: readonly ArtifactRecord[];
  readonly revision: ArtifactListRevision;
}

type ArtifactReadFailure = {
  readonly ok: false;
  readonly reason: 'not_found' | 'too_large' | 'read_failed' | 'not_allowed';
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

export interface CreateArtifactInput {
  sessionId: string;
  turnId: string;
  name: string;
  kind: ArtifactKind;
  content: string | Uint8Array;
  mimeType?: string;
  source: ArtifactSource;
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
  readonly excludeArtifactIds?: readonly string[];
  /**
   * Source-Session artifact ids to copy in addition to the turn-scoped
   * selection, regardless of their `turnId`. Used to carry user-uploaded
   * attachments (whose `turnId` is the upload id sentinel, not a conversation
   * turn) that the copied transcript still references. Lenient: an id with no
   * matching source record is a no-op.
   */
  readonly includeArtifactIds?: readonly string[];
  readonly linkedArtifacts?: readonly {
    readonly sessionId: string;
    readonly artifactIds: readonly string[];
  }[];
}

export interface ConversationArtifactCopyResult {
  readonly artifactIds: ReadonlyMap<string, string>;
  readonly relativePaths: ReadonlyMap<string, string>;
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

export type ArtifactUserDeleteResult =
  | { readonly kind: 'deleted' }
  | { readonly kind: 'protected' }
  | { readonly kind: 'not_found' };

export interface ArtifactAuthorityStore extends DurableArtifactAttachmentReader {
  create(input: CreateArtifactInput): Promise<ArtifactRecord>;
  close(): void;
  copyConversationArtifacts(
    input: ConversationArtifactCopyInput,
  ): Promise<ConversationArtifactCopyResult>;
  purgeSessionArtifacts(sessionId: string): Promise<void>;
  reclaimUpgradeResidue(): Promise<void>;
  deleteOwnedArtifactInSession(
    sessionId: string,
    artifactId: string,
    source: ArtifactSource,
  ): Promise<void>;
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
  close(): void;
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
    createSqliteArtifactMetadataRepository(workspaceRoot),
    options.assertAuthority,
    options.leaseBoundWriterLockAuthority,
  );
  return Object.freeze({
    store,
    close: () => store.close(),
  });
}

class SqliteArtifactStore implements ArtifactAuthorityStore {
  private artifactRoot: string;
  private records: ArtifactRecord[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private workspaceRoot: string,
    private readonly metadataRepository: ReturnType<typeof createSqliteArtifactMetadataRepository>,
    private readonly assertAuthority?: () => Promise<void>,
    private readonly leaseBoundWriterLockAuthority?: ArtifactWriterLockAuthority,
  ) {
    this.artifactRoot = join(workspaceRoot, 'artifacts');
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
    if (!ARTIFACT_SOURCE_SET.has(acceptedInput.source)) {
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
    return this.enqueueMutation(async () => {
      await this.prepareMutationUnlocked();
      const existing = this.records.find((record) => record.id === id);
      if (existing) {
        return this.replayExistingArtifactUnlocked(existing, acceptedInput, {
          id,
          name,
          relativePath,
        });
      }
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
          source: acceptedInput.source,
          ...(acceptedInput.summary ? { summary: acceptedInput.summary } : {}),
          ...(acceptedInput.deepResearchRole
            ? { deepResearchRole: acceptedInput.deepResearchRole }
            : {}),
        },
        (targetPath) => writeFile(targetPath, acceptedInput.content, { flag: 'wx' }),
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
    const excludedArtifactIds = new Set(input.excludeArtifactIds ?? []);
    const includedArtifactIds = new Set(input.includeArtifactIds ?? []);
    for (const turnId of turnIds) assertArtifactTurnKey(turnId);
    const linkedArtifacts = input.linkedArtifacts ?? [];
    const requestedLinkedArtifactIds = new Map<string, Set<string>>();
    for (const linked of linkedArtifacts) {
      assertCanonicalArtifactEntityId(linked.sessionId, 'sessionId');
      if (linked.sessionId === input.targetSessionId) {
        throw new Error('Linked Artifact copy requires a distinct source Session');
      }
      const artifactIds = requestedLinkedArtifactIds.get(linked.sessionId) ?? new Set<string>();
      for (const artifactId of linked.artifactIds) {
        assertCanonicalArtifactEntityId(artifactId, 'id');
        artifactIds.add(artifactId);
      }
      requestedLinkedArtifactIds.set(linked.sessionId, artifactIds);
    }
    const records = await this.enqueue(async () => {
      await this.load();
      const selected = this.records
        .filter(
          (record) =>
            record.sessionId === input.sourceSessionId &&
            turnIds.has(record.turnId) &&
            !excludedArtifactIds.has(record.id),
        )
        .map((record) => ({ ...record }));
      for (const [sessionId, artifactIds] of requestedLinkedArtifactIds) {
        for (const artifactId of artifactIds) {
          const record = this.records.find(
            (candidate) => candidate.sessionId === sessionId && candidate.id === artifactId,
          );
          // A linked child result names every Artifact its turn held, and the
          // ledger naming them cannot be rewritten. One that is no longer
          // there is copied as nothing rather than failing the copy -- the
          // caller is asking for what a past turn had, not asserting that all
          // of it survived.
          if (record) selected.push({ ...record });
        }
      }
      const selectedIds = new Set(selected.map((record) => record.id));
      for (const record of this.records) {
        if (
          record.sessionId === input.sourceSessionId &&
          includedArtifactIds.has(record.id) &&
          !excludedArtifactIds.has(record.id) &&
          !selectedIds.has(record.id)
        ) {
          selected.push({ ...record });
          selectedIds.add(record.id);
        }
      }
      return selected;
    });

    const artifactIds = new Map<string, string>();
    const relativePaths = new Map<string, string>();
    for (const record of records) {
      const targetId = conversationCopyArtifactId(
        record.sessionId,
        input.targetSessionId,
        record.id,
      );
      const prepared = await this.enqueue(() => this.prepareRecordRead(record, record.sizeBytes));
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
    assertCanonicalArtifactEntityId(targetId, 'id');
    validateRelativeArtifactPath(relativePath);
    return this.enqueueMutation(async () => {
      await this.prepareMutationUnlocked();
      if (this.records.some((record) => record.id === targetId)) {
        throw new Error(`Artifact target already exists: ${targetId}`);
      }
      return this.publishNewArtifactUnlocked(
        {
          ...source,
          id: targetId,
          sessionId: targetSessionId,
          name,
          relativePath,
        },
        (targetPath) => copyFile(prepared.path, targetPath, fsConstants.COPYFILE_EXCL),
        source.sizeBytes,
      );
    });
  }

  private async publishNewArtifactUnlocked(
    draft: ArtifactRecordDraft,
    writeTarget: (targetPath: string) => Promise<void>,
    expectedSize?: number,
  ): Promise<ArtifactRecord> {
    const target = join(this.artifactRoot, draft.relativePath);
    const targetDirectory = dirname(target);
    const createdDirectory = await mkdir(targetDirectory, { recursive: true });
    if (createdDirectory !== undefined) {
      await syncDirectoryChain(targetDirectory, this.workspaceRoot);
    }
    await assertArtifactDirectory(this.artifactRoot, targetDirectory);
    await rm(target, { force: true });
    try {
      await writeTarget(target);
      await syncFile(target);
      await syncDirectory(targetDirectory);
      const size = await stat(target);
      if (expectedSize !== undefined && size.size !== expectedSize) {
        throw new Error(`Artifact source changed while copying: ${draft.id}`);
      }
      const record: ArtifactRecord = { ...draft, sizeBytes: size.size };
      const nextRecords = [...this.records, record];
      await this.writeMetadataUnlocked({ upserts: [record] });
      this.records = nextRecords;
      return { ...record };
    } catch (error) {
      await removeFileDurably(target, targetDirectory).catch(() => undefined);
      throw error;
    }
  }

  async purgeSessionArtifacts(sessionId: string): Promise<void> {
    assertCanonicalArtifactEntityId(sessionId, 'sessionId');
    await this.enqueueMutation(async () => {
      await this.prepareMutationUnlocked();
      await this.purgeRecordsUnlocked(
        this.records.filter((record) => record.sessionId === sessionId),
      );
    });
  }

  /**
   * Deletes the files the v1 upgrade recorded as no longer named by any record.
   *
   * A path some record has since claimed keeps its bytes. A note is discharged
   * once its file is gone, and a file that will not go keeps only its own note
   * rather than holding up the ones behind it.
   */
  async reclaimUpgradeResidue(): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.prepareMutationUnlocked();
      const recorded = this.metadataRepository.readUpgradeOrphanPaths();
      if (recorded.length === 0) return;
      const claimed = new Set(this.records.map((record) => record.relativePath));
      const directories = new Set<string>();
      const discharged: string[] = [];
      try {
        for (const relativePath of recorded) {
          if (claimed.has(relativePath) || !isSafeRelativeArtifactPath(relativePath)) {
            discharged.push(relativePath);
            continue;
          }
          const target = join(this.artifactRoot, relativePath);
          try {
            await unlink(target);
            directories.add(dirname(target));
          } catch (error) {
            if (!isNotFound(error)) continue;
          }
          discharged.push(relativePath);
        }
      } finally {
        for (const directory of directories) await syncDirectory(directory);
      }
      if (discharged.length > 0) this.metadataRepository.forgetUpgradeOrphanPaths(discharged);
    });
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

    return { ...existing };
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
      const snapshot = this.sessionSnapshot(sessionId);
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
      const snapshot = this.sessionSnapshot(sessionId);
      return snapshot.records
        .filter((record) => record.turnId === turnId)
        .map((record) => ({ ...record }));
    });
  }

  async getInSession(sessionId: string, artifactId: string): Promise<ArtifactSessionEntry> {
    return this.enqueue(async () => {
      await this.load();
      const snapshot = this.sessionSnapshot(sessionId);
      const record = snapshot.records.find((candidate) => candidate.id === artifactId);
      return {
        revision: snapshot.revision,
        record: record ? { ...record } : null,
      };
    });
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

  deleteOwnedArtifactInSession(
    sessionId: string,
    artifactId: string,
    source: ArtifactSource,
  ): Promise<void> {
    return this.enqueueMutation(async () => {
      await this.prepareMutationUnlocked();
      const snapshot = this.sessionSnapshot(sessionId);
      const existing = snapshot.records.find((record) => record.id === artifactId);
      if (!existing || existing.source !== source) {
        throw new Error('Artifact does not belong to the expected Session authority');
      }
      await this.purgeRecordsUnlocked([existing]);
    });
  }

  deleteUserArtifactInSession(
    sessionId: string,
    artifactId: string,
  ): Promise<ArtifactUserDeleteResult> {
    return this.enqueueMutation(async () => {
      await this.prepareMutationUnlocked();
      const snapshot = this.sessionSnapshot(sessionId);
      const existing = snapshot.records.find((record) => record.id === artifactId);
      if (!existing) return { kind: 'not_found' };
      if (!canUserDeleteArtifact(existing)) return { kind: 'protected' };
      await this.purgeRecordsUnlocked([existing]);
      return { kind: 'deleted' };
    });
  }

  private async purgeRecordsUnlocked(records: readonly ArtifactRecord[]): Promise<void> {
    if (records.length === 0) return;
    const ids = new Set(records.map((record) => record.id));
    const paths = await this.preparePurgePathsUnlocked(records);
    await this.completePurgeUnlocked(ids, paths);
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
    }
    const purgeEntries = await this.resolveRemovalEntriesUnlocked(records);
    for (const [index, record] of records.entries()) {
      const entry = purgeEntries[index];
      if (!entry) continue;
      if (!isInsideOrSamePath(root, dirname(entry.unlinkPath))) {
        throw new Error(`Artifact ${record.id} resolves outside the artifact root`);
      }
      entries.set(entry.comparisonIdentity, { unlinkPath: entry.unlinkPath, record });
    }
    const guardRecords = this.records.filter((record) => !ids.has(record.id));
    for (const record of guardRecords) {
      const exactTarget = relativePaths.get(record.relativePath);
      if (exactTarget) {
        throw new Error(
          `Artifact ${exactTarget.id} path is still referenced by artifact ${record.id}`,
        );
      }
    }
    const guardEntries = await this.resolveRemovalEntriesUnlocked(guardRecords);
    for (const [index, record] of guardRecords.entries()) {
      const entry = guardEntries[index];
      const target = entry ? entries.get(entry.comparisonIdentity)?.record : undefined;
      if (target) {
        throw new Error(`Artifact ${target.id} path is still referenced by artifact ${record.id}`);
      }
    }
    return [...entries.values()].map((entry) => entry.unlinkPath);
  }

  // Resolves removal entries with bounded concurrency: each resolution issues
  // realpath/lstat syscalls, so a serial loop over the full record set turned
  // session-cleanup purges into a syscall storm on large artifact stores.
  // Workers capture per-record results and always drain the queue, so all
  // filesystem work settles before this mutation releases the writer lock,
  // and resolver failures surface in record order rather than completion
  // order.
  private async resolveRemovalEntriesUnlocked(
    records: readonly ArtifactRecord[],
  ): Promise<readonly (ArtifactRemovalEntry | undefined)[]> {
    type Resolution =
      | { readonly ok: true; readonly entry: ArtifactRemovalEntry | undefined }
      | { readonly ok: false; readonly error: unknown };
    const results: (Resolution | undefined)[] = new Array(records.length);
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < records.length) {
        const index = nextIndex++;
        try {
          const entry = await resolveArtifactRemovalEntry(
            this.artifactRoot,
            records[index]!.relativePath,
          );
          results[index] = { ok: true, entry };
        } catch (error) {
          results[index] = { ok: false, error };
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(ARTIFACT_PURGE_RESOLVE_CONCURRENCY, records.length) }, worker),
    );
    const resolved: (ArtifactRemovalEntry | undefined)[] = new Array(records.length);
    for (const [index, result] of results.entries()) {
      if (result === undefined) throw new Error('Artifact removal resolution did not settle');
      if (!result.ok) throw result.error;
      resolved[index] = result.entry;
    }
    return resolved;
  }

  private async completePurgeUnlocked(
    ids: ReadonlySet<string>,
    paths: readonly string[],
  ): Promise<void> {
    const nextRecords = this.records.filter((record) => !ids.has(record.id));
    const changedDirectories = new Set<string>();
    try {
      for (const path of paths) {
        await rm(path, { force: true });
        changedDirectories.add(dirname(path));
      }
    } finally {
      for (const directory of changedDirectories) await syncDirectory(directory);
    }
    // Keep the paths discoverable until physical cleanup is durable. Session
    // retirement already owns the pending cleanup intent and retries on reopen.
    await this.writeMetadataUnlocked({ deleteIds: [...ids] });
    this.records = nextRecords;
  }

  private async prepareReadInSessionUnlocked(
    sessionId: string,
    artifactId: string,
    maxBytes: number,
  ): Promise<PreparedArtifactRead | ArtifactReadFailure> {
    await this.load();
    const snapshot = this.sessionSnapshot(sessionId);
    const record = snapshot.records.find((candidate) => candidate.id === artifactId);
    if (!record) return { ok: false, reason: 'not_found' };
    return this.prepareRecordRead(record, maxBytes);
  }

  private async prepareRecordRead(
    record: ArtifactRecord,
    maxBytes: number,
  ): Promise<PreparedArtifactRead | ArtifactReadFailure> {
    const resolved = await resolveArtifactPath({
      artifactRoot: this.artifactRoot,
      relativePath: record.relativePath,
    });
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    return { ok: true, path: resolved.path, record, maxBytes };
  }

  private async load(): Promise<void> {
    this.records = this.metadataRepository.readAll();
  }

  private async writeMetadataUnlocked(changes: ArtifactMetadataChanges): Promise<void> {
    this.metadataRepository.applyChanges(changes);
  }

  private async prepareMutationUnlocked(): Promise<void> {
    await this.reloadForMutationUnlocked();
  }

  private async reloadForMutationUnlocked(): Promise<void> {
    this.records = this.metadataRepository.readAll();
  }

  private bindMutationRoot(canonicalRoot: string): void {
    if (this.workspaceRoot === canonicalRoot) return;
    this.workspaceRoot = canonicalRoot;
    this.artifactRoot = join(canonicalRoot, 'artifacts');
    this.records = [];
  }

  /**
   * Orders one session's records and stamps the revision readers compare on.
   *
   * Sealed on the way out rather than kept in a map. A revision hashes every
   * record in its session, and every reader reloads the whole store from the
   * database before it reads one, so a kept snapshot never survived to be read
   * -- sealing all of them on load only charged each reader for the sessions it
   * did not ask about.
   */
  private sessionSnapshot(sessionId: string): ArtifactSessionSnapshot {
    const records = this.records
      .filter((record) => record.sessionId === sessionId)
      .sort(compareArtifactRecords);
    return { records, revision: artifactListRevision(records) };
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
    a.deepResearchRole === b.deepResearchRole
  );
}

function assertPageBound(value: number, allowZero: boolean, label: string): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new Error(`Artifact page ${label} is invalid`);
  }
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

const ARTIFACT_KIND_SET = new Set<ArtifactKind>(ARTIFACT_KINDS);
const ARTIFACT_SOURCE_SET = new Set<ArtifactSource>(ARTIFACT_SOURCES);

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
    const entryStat = await lstat(entry, { bigint: true }).catch((error) => {
      if (isNotFound(error)) return undefined;
      throw error;
    });
    // A previous attempt may have unlinked the file but failed to sync its
    // parent. Retain that parent in the next purge's durability barrier.
    if (!entryStat) return { unlinkPath: entry, comparisonIdentity: `path:${entry}` };
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

function sniffAllowedBinaryMime(bytes: Uint8Array): string | null {
  // Core owns the binary signatures, shared with the attachment and image-read
  // paths so the three cannot drift. SVG needs a wider text scan than a fixed
  // prefix, so it stays local to this reader.
  const sniffed = sniffAttachmentMimeType(bytes);
  if (sniffed) return sniffed;
  const leading = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.slice(0, Math.min(bytes.length, 512)))
    .trimStart();
  if (/^<svg[\s>]/i.test(leading) || /^<\?xml[\s\S]*<svg[\s>]/i.test(leading))
    return 'image/svg+xml';
  return null;
}
