import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, createReadStream, type Dirent } from 'node:fs';
import {
  access,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
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
  isCanonicalArtifactEntityId,
} from '@maka/core/artifacts';
import {
  isDeepResearchArtifactRole,
  type DeepResearchArtifactRole,
} from '@maka/core/deep-research-run';
import { publishMarkerFile, readBoundedMarkerFile } from './marker-file.js';
import {
  ARTIFACT_METADATA_TEMP_PATTERN,
  ARTIFACT_PUBLICATION_STAGING_PATTERN,
  ARTIFACT_PURGE_INTENT_FILE,
} from './artifact-storage-layout.js';
import {
  decodeArtifactMetadata,
  isSafeRelativeArtifactPath,
  validateCanonicalArtifactTargetName,
  validateRelativeArtifactPath,
} from './artifact-metadata-codec.js';
import { withArtifactWriterLock } from './artifact-writer-lock.js';
import { syncDirectory, syncDirectoryChain, syncFile } from './stable-storage.js';

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
}

export type ArtifactSessionDeleteResult =
  | { readonly kind: 'deleted'; readonly record: ArtifactRecord }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'record_changed' };

export interface ArtifactAuthorityStore extends ArtifactStore {
  listPage(
    sessionId: string,
    options: { offset: number; limit: number },
  ): Promise<ArtifactListPage>;
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
  deleteInSession(input: {
    sessionId: string;
    expected: ArtifactRecord;
  }): Promise<ArtifactSessionDeleteResult>;
}

export interface ArtifactStoreWriteAuthority {
  readonly store: ArtifactAuthorityStore;
  recover(): Promise<void>;
}

export function createArtifactStore(workspaceRoot: string): ArtifactStore {
  return new FileArtifactStore(workspaceRoot, 'legacy');
}

export function createArtifactStoreWriteAuthority(
  workspaceRoot: string,
): ArtifactStoreWriteAuthority {
  const store = new FileArtifactStore(workspaceRoot, 'authority');
  return Object.freeze({
    store,
    recover: () => store.recoverForWriteWithAuthority(),
  });
}

class FileArtifactStore implements ArtifactAuthorityStore {
  private readonly artifactRoot: string;
  private readonly metadataPath: string;
  private readonly purgeIntentPath: string;
  private records: ArtifactRecord[] = [];
  private sessionSnapshots = new Map<string, ArtifactSessionSnapshot>();
  private loaded = false;
  private recoveryRequired: boolean;
  private recoverableOrphans = new Map<string, RecoverableOrphan>();
  private loadPromise: Promise<void> | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly workspaceRoot: string,
    private readonly recoveryMode: 'legacy' | 'authority',
  ) {
    this.artifactRoot = join(workspaceRoot, 'artifacts');
    this.metadataPath = join(this.artifactRoot, 'metadata.jsonl');
    this.purgeIntentPath = join(this.artifactRoot, ARTIFACT_PURGE_INTENT_FILE);
    this.recoveryRequired = recoveryMode === 'authority';
  }

  async create(input: CreateArtifactInput): Promise<ArtifactRecord> {
    const id = input.id ?? randomUUID();
    if (!ARTIFACT_KIND_SET.has(input.kind)) throw new Error('Invalid Artifact kind');
    if (input.source !== undefined && !ARTIFACT_SOURCE_SET.has(input.source)) {
      throw new Error('Invalid Artifact source');
    }
    if (
      input.deepResearchRole !== undefined &&
      !isDeepResearchArtifactRole(input.deepResearchRole)
    ) {
      throw new Error('Invalid Artifact deep-research role');
    }
    if (input.now !== undefined && (!Number.isSafeInteger(input.now) || input.now < 0)) {
      throw new Error('Invalid Artifact creation time');
    }
    assertCanonicalArtifactEntityId(id, 'id');
    assertCanonicalArtifactEntityId(input.sessionId, 'sessionId');
    assertCanonicalArtifactEntityId(input.turnId, 'turnId');
    const name = sanitizeArtifactName(input.name);
    const relativePath = `${input.sessionId}/${id}-${name}`;
    validateRelativeArtifactPath(relativePath);
    validateCanonicalArtifactTargetName(basename(relativePath));
    return this.enqueueMutation(async () => {
      await this.prepareMutationUnlocked();
      const existing = this.records.find((record) => record.id === id);
      if (existing) {
        return this.replayExistingArtifactUnlocked(existing, input, {
          id,
          name,
          relativePath,
        });
      }
      await this.assertNoCompatiblePublicationStagingUnlocked(input, {
        id,
        canonicalName: name,
      });
      const adopted = await this.adoptRecoverableOrphanUnlocked(input, {
        id,
        canonicalName: name,
      });
      if (adopted) return adopted;
      await this.assertNoCompatiblePayloadExistsUnlocked(input, { id, canonicalName: name });
      const target = join(this.artifactRoot, relativePath);
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
        await writeFile(tempPath, input.content, { flag: 'wx' });
        await syncFile(tempPath);
        await syncDirectory(targetDirectory);
        const size = await stat(tempPath);
        const record: ArtifactRecord = {
          id,
          sessionId: input.sessionId,
          turnId: input.turnId,
          createdAt: input.now ?? Date.now(),
          name,
          kind: input.kind,
          relativePath,
          sizeBytes: size.size,
          ...(input.mimeType ? { mimeType: input.mimeType } : {}),
          ...(input.source ? { source: input.source } : {}),
          ...(input.summary ? { summary: input.summary } : {}),
          ...(input.deepResearchRole ? { deepResearchRole: input.deepResearchRole } : {}),
          status: 'live',
        };
        const nextRecords = [...this.records, record];
        try {
          try {
            await link(tempPath, target);
            targetLinked = true;
          } catch (error) {
            if (isAlreadyExists(error)) throw new Error(`Artifact target already exists: ${id}`);
            throw error;
          }
          await syncDirectory(targetDirectory);
          await this.writeMetadataUnlocked(nextRecords);
        } catch (error) {
          if (targetLinked && isPublishedMetadataError(error)) {
            preserveStaging = true;
            this.invalidateWriterState();
          } else if (targetLinked) {
            try {
              await removeFileDurably(target, targetDirectory);
            } catch (cleanupError) {
              preserveStaging = true;
              this.invalidateWriterState();
              throw new AggregateError(
                [error, cleanupError],
                `Artifact ${id} metadata publication and payload cleanup both failed`,
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
    });
  }

  private async replayExistingArtifactUnlocked(
    existing: ArtifactRecord,
    input: CreateArtifactInput,
    canonical: { id: string; name: string; relativePath: string },
  ): Promise<ArtifactRecord> {
    const expectedBytes = Buffer.from(input.content);
    const compatibleNames = compatibleArtifactNames(input.name, canonical.name);
    if (
      existing.id !== canonical.id ||
      existing.sessionId !== input.sessionId ||
      existing.turnId !== input.turnId ||
      !compatibleNames.has(existing.name) ||
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
    await this.load();
    return (
      this.records
        .filter((record) => record.sessionId === sessionId)
        .filter((record) => opts.includeDeleted || record.status !== 'deleted')
        // Secondary `id` sort for determinism when fixture artifacts share
        // a frozen createdAt (PR108k-yj e2e-fixture determinism).
        .sort(compareArtifactRecords)
        .map((record) => ({ ...record }))
    );
  }

  async get(artifactId: string): Promise<ArtifactRecord | null> {
    await this.load();
    const record = this.records.find((item) => item.id === artifactId);
    return record ? { ...record } : null;
  }

  async listPage(
    sessionId: string,
    options: { offset: number; limit: number },
  ): Promise<ArtifactListPage> {
    assertPageBound(options.offset, true, 'offset');
    assertPageBound(options.limit, false, 'limit');
    await this.load();
    const snapshot = this.sessionSnapshots.get(sessionId) ?? EMPTY_SESSION_SNAPSHOT;
    return {
      revision: snapshot.revision,
      records: snapshot.records
        .slice(options.offset, options.offset + options.limit)
        .map((record) => ({ ...record })),
      total: snapshot.records.length,
    };
  }

  async getInSession(sessionId: string, artifactId: string): Promise<ArtifactSessionEntry> {
    await this.load();
    const snapshot = this.sessionSnapshots.get(sessionId) ?? EMPTY_SESSION_SNAPSHOT;
    const record = snapshot.records.find((candidate) => candidate.id === artifactId);
    return {
      revision: snapshot.revision,
      record: record ? { ...record } : null,
    };
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
    prepared:
      | { ok: true; path: string; record: ArtifactRecord }
      | {
          ok: false;
          reason: 'not_found' | 'too_large' | 'read_failed' | 'not_allowed' | 'deleted';
        },
  ): Promise<ArtifactTextReadResult> {
    if (!prepared.ok) return prepared;
    try {
      return { ok: true, text: await readFile(prepared.path, 'utf8') };
    } catch {
      return { ok: false, reason: 'read_failed' };
    }
  }

  private async readPreparedBinary(
    prepared:
      | { ok: true; path: string; record: ArtifactRecord }
      | {
          ok: false;
          reason: 'not_found' | 'too_large' | 'read_failed' | 'not_allowed' | 'deleted';
        },
  ): Promise<ArtifactBinaryReadResult> {
    if (!prepared.ok) return prepared;
    try {
      const bytes = await readFile(prepared.path);
      const mimeType = sniffAllowedBinaryMime(bytes);
      if (!mimeType) return { ok: false, reason: 'unsupported_mime' };
      return { ok: true, base64: bytes.toString('base64'), mimeType };
    } catch {
      return { ok: false, reason: 'read_failed' };
    }
  }

  async delete(artifactId: string): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.prepareMutationUnlocked();
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

  deleteInSession(input: {
    sessionId: string;
    expected: ArtifactRecord;
  }): Promise<ArtifactSessionDeleteResult> {
    return this.enqueueMutation(async () => {
      await this.prepareMutationUnlocked();
      const snapshot = this.sessionSnapshots.get(input.sessionId) ?? EMPTY_SESSION_SNAPSHOT;
      const existing = snapshot.records.find((record) => record.id === input.expected.id);
      if (!existing) return { kind: 'not_found' };
      if (!sameArtifactRecord(existing, input.expected)) {
        if (
          existing.status === 'deleted' &&
          input.expected.status === 'live' &&
          sameArtifactRecord(existing, { ...input.expected, status: 'deleted' })
        ) {
          return { kind: 'deleted', record: { ...existing } };
        }
        return { kind: 'record_changed' };
      }
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
    await this.enqueueMutation(async () => {
      await this.prepareMutationUnlocked();
      const ids = new Set(artifactIds);
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
    const paths = new Map<string, ArtifactRecord>();
    const relativePaths = new Map(records.map((record) => [record.relativePath, record] as const));
    for (const record of records) {
      validateRelativeArtifactPath(record.relativePath);
      const path = await resolveArtifactRemovalEntry(this.artifactRoot, record.relativePath);
      if (!path) continue;
      if (!isInsideOrSamePath(root, dirname(path))) {
        throw new Error(`Artifact ${record.id} resolves outside the artifact root`);
      }
      paths.set(path, record);
    }
    for (const record of this.records) {
      if (ids.has(record.id)) continue;
      const exactTarget = relativePaths.get(record.relativePath);
      if (exactTarget) {
        throw new Error(
          `Artifact ${exactTarget.id} path is still referenced by artifact ${record.id}`,
        );
      }
      const path = await resolveArtifactRemovalEntry(this.artifactRoot, record.relativePath);
      const target = path ? paths.get(path) : undefined;
      if (target) {
        throw new Error(`Artifact ${target.id} path is still referenced by artifact ${record.id}`);
      }
    }
    return [...paths.keys()];
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
  ): Promise<
    | { ok: true; path: string; record: ArtifactRecord }
    | { ok: false; reason: 'not_found' | 'too_large' | 'read_failed' | 'not_allowed' | 'deleted' }
  > {
    const record = await this.get(artifactId);
    if (!record) return { ok: false, reason: 'not_found' };
    return this.prepareRecordRead(record, maxBytes, includeDeleted);
  }

  private async prepareReadInSessionUnlocked(
    sessionId: string,
    artifactId: string,
    maxBytes: number,
  ): Promise<
    | { ok: true; path: string; record: ArtifactRecord }
    | { ok: false; reason: 'not_found' | 'too_large' | 'read_failed' | 'not_allowed' | 'deleted' }
  > {
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
  ): Promise<
    | { ok: true; path: string; record: ArtifactRecord }
    | { ok: false; reason: 'not_found' | 'too_large' | 'read_failed' | 'not_allowed' | 'deleted' }
  > {
    if (record.status === 'deleted' && !includeDeleted) return { ok: false, reason: 'deleted' };
    const resolved = await resolveArtifactPath({
      artifactRoot: this.artifactRoot,
      relativePath: record.relativePath,
    });
    if (!resolved.ok) return { ok: false, reason: resolved.reason };
    const size = await stat(resolved.path).catch(() => null);
    if (!size || !size.isFile()) return { ok: false, reason: 'not_found' };
    if (size.size > maxBytes) return { ok: false, reason: 'too_large' };
    return { ok: true, path: resolved.path, record };
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    if (this.loadPromise) {
      await this.loadPromise;
      return;
    }
    this.loadPromise = (async () => {
      try {
        const text = await readFile(this.metadataPath, 'utf8');
        this.replaceRecords(decodeArtifactMetadata(text));
      } catch (error) {
        if (!isNotFound(error)) throw error;
        this.replaceRecords([]);
      }
      this.loaded = true;
    })();
    try {
      await this.loadPromise;
    } finally {
      this.loadPromise = null;
    }
  }

  private async writeMetadataUnlocked(records: readonly ArtifactRecord[]): Promise<void> {
    const metadataDirectory = dirname(this.metadataPath);
    const createdDirectory = await mkdir(metadataDirectory, { recursive: true });
    if (createdDirectory !== undefined) {
      await syncDirectoryChain(metadataDirectory, this.workspaceRoot);
    }
    const tempPath = `${this.metadataPath}.${process.pid}.${randomUUID()}.tmp`;
    const payload = records.map((record) => JSON.stringify(record)).join('\n');
    let published = false;
    let publicationError: MetadataPublicationError | undefined;
    try {
      await writeFile(tempPath, payload ? `${payload}\n` : '', {
        encoding: 'utf8',
        flag: 'wx',
      });
      await syncFile(tempPath);
      await rename(tempPath, this.metadataPath);
      published = true;
      await syncDirectory(metadataDirectory);
    } catch (error) {
      this.invalidateWriterState();
      publicationError = new MetadataPublicationError(error, published);
    }
    try {
      await removeFileDurably(tempPath, metadataDirectory);
    } catch (cleanupError) {
      this.invalidateWriterState();
      if (publicationError) {
        throw new AggregateError(
          [publicationError, cleanupError],
          'Artifact metadata publication and temp cleanup both failed',
        );
      }
      throw cleanupError;
    }
    if (publicationError) throw publicationError;
  }

  private async prepareMutationUnlocked(): Promise<void> {
    if (this.recoveryMode === 'legacy') {
      this.recoverableOrphans.clear();
      await this.prepareRecoveryUnlocked();
      this.recoverableOrphans = await this.findRecoverableOrphansUnlocked();
      return;
    }
    await this.reloadForMutationUnlocked();
    if (this.recoveryRequired) throw artifactWriteRecoveryRequired();
    if (!(await this.hasCanonicalRecoveryResidueUnlocked())) return;
    this.recoveryRequired = true;
    throw artifactWriteRecoveryRequired();
  }

  private async reloadForMutationUnlocked(): Promise<void> {
    if (this.loadPromise) await this.loadPromise;
    try {
      const text = await readFile(this.metadataPath, 'utf8');
      this.replaceRecords(decodeArtifactMetadata(text));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      this.replaceRecords([]);
    }
    this.loaded = true;
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
    if (sessionEntries.some((entry) => ARTIFACT_METADATA_TEMP_PATTERN.test(entry.name))) {
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
    const names = [...compatibleArtifactNames(input.name, identity.canonicalName)];
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

  private async assertNoCompatiblePayloadExistsUnlocked(
    input: CreateArtifactInput,
    identity: { id: string; canonicalName: string },
  ): Promise<void> {
    const names = compatibleArtifactNames(input.name, identity.canonicalName);
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
    input: CreateArtifactInput,
    identity: { id: string; canonicalName: string },
  ): Promise<void> {
    const targetHashes = new Set(
      [...compatibleArtifactNames(input.name, identity.canonicalName)].map((name) =>
        artifactTargetHash(`${identity.id}-${name}`),
      ),
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
      if (!entry.isFile() || !ARTIFACT_METADATA_TEMP_PATTERN.test(entry.name)) continue;
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

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    return this.enqueue(() => withArtifactWriterLock(this.workspaceRoot, operation));
  }
}

function publicationStagingName(targetBasename: string): string {
  return `.artifact-publish.${artifactTargetHash(targetBasename)}.${randomUUID()}.tmp`;
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

function sanitizeLegacyArtifactName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|\0]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .replace(/^-+/, '')
    .trim();
  return (cleaned || 'artifact').slice(0, 120);
}

function compatibleArtifactNames(inputName: string, canonicalName: string): ReadonlySet<string> {
  return new Set([canonicalName, sanitizeLegacyArtifactName(inputName)]);
}

function filesystemPathKey(path: string): string {
  return Buffer.from(path, 'utf8').toString('utf8');
}

function truncateWithoutSplittingSurrogate(value: string, maxCodeUnits: number): string {
  const truncated = value.slice(0, maxCodeUnits);
  const last = truncated.charCodeAt(truncated.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? truncated.slice(0, -1) : truncated;
}

class MetadataPublicationError extends Error {
  constructor(
    cause: unknown,
    readonly published: boolean,
  ) {
    super('Artifact metadata publication failed', { cause });
  }
}

function isPublishedMetadataError(error: unknown): boolean {
  return error instanceof MetadataPublicationError && error.published;
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
  field: 'id' | 'sessionId' | 'turnId',
): asserts value is string {
  if (!isCanonicalArtifactEntityId(value)) {
    throw new Error(
      `Artifact ${field} must be a canonical entity ID of 1-${ARTIFACT_ENTITY_ID_MAX_CHARS} ASCII letters, digits, "_" or "-"`,
    );
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
): Promise<string | undefined> {
  const target = join(artifactRoot, relativePath);
  try {
    const parent = await realpath(dirname(target));
    return join(parent, basename(target));
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
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
