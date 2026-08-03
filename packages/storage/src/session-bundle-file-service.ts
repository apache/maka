import { Buffer } from 'node:buffer';
import { createHash, randomUUID, type Hash } from 'node:crypto';
import { constants as fsConstants, type BigIntStats } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants as zlibConstants, createZstdCompress, createZstdDecompress } from 'node:zlib';
import { unlock, waitForLock } from 'fs-native-extensions';
import {
  compareSessionBundleCanonicalPaths,
  computeSessionBundleCanonicalTreeDigest,
  SessionBundleCanonicalTreeDigestBuilder,
  type SessionBundleCanonicalTreeEntry,
} from './session-bundle-canonical-tree.js';
import {
  assertSessionBundleLimits,
  copyOpaqueStateIdentityDescriptor,
  isNonEmptyUnicodeString,
  isSha256Digest,
  isValidUnicodeString,
  SESSION_BUNDLE_ARCHIVE_FORMAT,
  SESSION_BUNDLE_CANONICALIZATION_VERSION,
  SESSION_BUNDLE_CODEC_NAME,
  SESSION_BUNDLE_CODEC_VERSION,
  SESSION_BUNDLE_COMPRESSION_FORMAT,
  SESSION_BUNDLE_COMPRESSION_LEVEL,
  SESSION_BUNDLE_MANIFEST_PATH,
  SESSION_BUNDLE_SCHEMA_VERSION,
  SESSION_BUNDLE_STATE_IDENTITY_PATH,
  SESSION_BUNDLE_STATE_PATH,
  SESSION_BUNDLE_WORKSPACE_PATH,
  SessionBundleFileError,
  type OpaqueStateIdentityDescriptor,
  type SessionBundleArtifact,
  type SessionBundleFileOperation,
  type SessionBundleFileService,
  type SessionBundleHydrateInput,
  type SessionBundleHydration,
  type SessionBundleInspection,
  type SessionBundleLimits,
  type SessionBundleManifestV1,
  type SessionBundlePackInput,
  type SessionBundleQuotaName,
  type SessionBundleReadInput,
  type Sha256Digest,
} from './session-bundle-contract.js';
import {
  decodeSessionBundleManifestV1,
  encodeSessionBundleManifestV1,
} from './session-bundle-manifest.js';
import {
  decodeSessionBundleUstarHeaderV1,
  encodeSessionBundleUstarHeaderV1,
  isSessionBundleUstarZeroBlock,
  SESSION_BUNDLE_USTAR_BLOCK_BYTES,
  sessionBundleUstarPaddingBytes,
  type SessionBundleUstarHeader,
} from './session-bundle-ustar.js';

const ZERO_BLOCK = Buffer.alloc(SESSION_BUNDLE_USTAR_BLOCK_BYTES);
const ARCHIVE_TERMINATOR = Buffer.alloc(SESSION_BUNDLE_USTAR_BLOCK_BYTES * 2);
const HYDRATION_STAGING_MARKER = '.maka-session-bundle-staging-';
const PACK_TEMP_MARKER = '.maka-session-bundle-pack-';
const PUBLICATION_LOCK_MARKER = '.maka-session-bundle-publish-';
const PACK_FILE_CHUNK_BYTES = 64 * 1024;
const SESSION_BUNDLE_ZSTD_WINDOW_LOG = 21;
const SESSION_BUNDLE_ZSTD_WINDOW_DESCRIPTOR = 0x58;
const NODE_ZSTD_TRAILING_EMPTY_FRAME = Buffer.from('28b52ffd040001000099e9d851', 'hex');
const publicationLockGates = new Map<string, Promise<void>>();

interface FileFingerprint {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

interface PackDirectoryEntry {
  canonical: Extract<SessionBundleCanonicalTreeEntry, { kind: 'directory' }>;
  fingerprint: FileFingerprint;
  sourcePath: string;
}

interface PackDiskFileEntry {
  canonical: Extract<SessionBundleCanonicalTreeEntry, { kind: 'file' }>;
  fingerprint: FileFingerprint;
  sourcePath: string;
}

interface PackMemoryFileEntry {
  canonical: Extract<SessionBundleCanonicalTreeEntry, { kind: 'file' }>;
  bytes: Buffer;
}

type PackEntry = PackDirectoryEntry | PackDiskFileEntry | PackMemoryFileEntry;

interface PackScanBudget {
  payloadBytes: number;
}

interface ReadValidationResult extends SessionBundleInspection {
  decompressedTarBytes: number;
}

interface ParsedTarResult {
  manifest: SessionBundleManifestV1;
  stateIdentity: OpaqueStateIdentityDescriptor;
}

interface ArchiveLayoutState {
  directories: Set<string>;
  logicalPaths: Set<string>;
  previousPath?: string;
}

export function createSessionBundleFileService(): SessionBundleFileService {
  return new NodeSessionBundleFileService();
}

export class NodeSessionBundleFileService implements SessionBundleFileService {
  async pack(input: SessionBundlePackInput): Promise<SessionBundleArtifact> {
    try {
      return await packSessionBundle(input);
    } catch (error) {
      throw normalizeOperationError(error, 'pack');
    }
  }

  async inspect(input: SessionBundleReadInput): Promise<SessionBundleInspection> {
    const validated = validateReadInput(input);
    try {
      const result = await readAndValidateSessionBundle({
        ...validated,
        operation: 'inspect',
      });
      return inspectionFromReadResult(result);
    } catch (error) {
      throw normalizeOperationError(error, 'inspect');
    }
  }

  async hydrate(input: SessionBundleHydrateInput): Promise<SessionBundleHydration> {
    const validated = validateHydrateInput(input);
    const parent = dirname(validated.destinationRoot);
    const prefix = `.${basename(validated.destinationRoot)}${HYDRATION_STAGING_MARKER}`;
    let stagingRoot: string | undefined;
    let stagingFingerprint: FileFingerprint | undefined;
    let published = false;

    try {
      await assertDestinationMissing(validated.destinationRoot, 'hydrate');
      const parentMetadata = await stat(parent, { bigint: true });
      if (!parentMetadata.isDirectory()) throw ioError('hydrate');
      stagingRoot = await mkdtemp(join(parent, prefix));
      await chmod(stagingRoot, 0o700);
      const stagingMetadata = await lstat(stagingRoot, { bigint: true });
      if (!stagingMetadata.isDirectory() || stagingMetadata.dev !== parentMetadata.dev) {
        throw ioError('hydrate');
      }
      stagingFingerprint = fingerprint(stagingMetadata);

      const result = await readAndValidateSessionBundle({
        sourcePath: validated.sourcePath,
        expectedArchiveDigest: validated.expectedArchiveDigest,
        limits: validated.limits,
        operation: 'hydrate',
        expectedSessionId: validated.expectedSessionId,
        stagingRoot,
      });

      const publicationStagingRoot = stagingRoot;
      const publicationStagingFingerprint = stagingFingerprint;
      await withDestinationPublicationLock(validated.destinationRoot, 'hydrate', async () => {
        await assertDestinationMissing(validated.destinationRoot, 'hydrate');
        const currentStaging = await lstat(publicationStagingRoot, { bigint: true });
        if (
          !currentStaging.isDirectory() ||
          !sameFilesystemNode(publicationStagingFingerprint, fingerprint(currentStaging))
        ) {
          throw new SessionBundleFileError(
            'source_changed',
            'Session bundle hydration staging root changed before publication',
          );
        }
        await rename(publicationStagingRoot, validated.destinationRoot);
      });
      published = true;
      return {
        ...inspectionFromReadResult(result),
        destinationRoot: validated.destinationRoot,
        stateRoot: join(validated.destinationRoot, 'state'),
        workspaceRoot: join(validated.destinationRoot, 'workspace'),
      };
    } catch (error) {
      throw normalizeOperationError(error, 'hydrate');
    } finally {
      if (!published && stagingRoot !== undefined) {
        await removeOwnedHydrationStaging(stagingRoot, parent, prefix, stagingFingerprint).catch(
          () => {},
        );
      }
    }
  }
}

async function packSessionBundle(input: SessionBundlePackInput): Promise<SessionBundleArtifact> {
  const validated = validatePackInput(input);
  await assertDestinationMissing(validated.destination, 'pack');
  assertQuota(
    'pack',
    validated.limits,
    'maxPathBytes',
    Buffer.byteLength(SESSION_BUNDLE_MANIFEST_PATH),
  );
  assertQuota('pack', validated.limits, 'maxPathDepth', 1);
  assertPathQuota('pack', validated.limits, SESSION_BUNDLE_STATE_IDENTITY_PATH);

  const identityBytes = Buffer.from(validated.stateIdentity.bytes);
  assertQuota('pack', validated.limits, 'maxStateIdentityBytes', identityBytes.byteLength);
  assertQuota('pack', validated.limits, 'maxFileBytes', identityBytes.byteLength);
  const entries: PackEntry[] = [
    {
      canonical: {
        kind: 'file',
        path: SESSION_BUNDLE_STATE_IDENTITY_PATH,
        mode: 0o644,
        size: identityBytes.byteLength,
        contentDigest: digestBytes(identityBytes),
      },
      bytes: identityBytes,
    },
  ];
  const budget: PackScanBudget = { payloadBytes: identityBytes.byteLength };
  assertQuota('pack', validated.limits, 'maxEntryCount', entries.length);
  assertQuota('pack', validated.limits, 'maxPayloadBytes', budget.payloadBytes);

  await scanPackRoot(
    validated.stateRoot,
    SESSION_BUNDLE_STATE_PATH,
    entries,
    budget,
    validated.limits,
  );
  await scanPackRoot(
    validated.workspaceRoot,
    SESSION_BUNDLE_WORKSPACE_PATH,
    entries,
    budget,
    validated.limits,
  );
  entries.sort((left, right) =>
    compareSessionBundleCanonicalPaths(left.canonical.path, right.canonical.path),
  );
  assertQuota('pack', validated.limits, 'maxEntryCount', entries.length);

  const tree = computeSessionBundleCanonicalTreeDigest(entries.map((entry) => entry.canonical));
  assertQuota('pack', validated.limits, 'maxPayloadBytes', tree.payloadBytes);
  const manifest: SessionBundleManifestV1 = {
    schemaVersion: SESSION_BUNDLE_SCHEMA_VERSION,
    codec: {
      name: SESSION_BUNDLE_CODEC_NAME,
      version: SESSION_BUNDLE_CODEC_VERSION,
      canonicalizationVersion: SESSION_BUNDLE_CANONICALIZATION_VERSION,
      archive: SESSION_BUNDLE_ARCHIVE_FORMAT,
      compression: SESSION_BUNDLE_COMPRESSION_FORMAT,
      compressionLevel: SESSION_BUNDLE_COMPRESSION_LEVEL,
    },
    envelope: validated.envelope,
    stateIdentity: {
      path: SESSION_BUNDLE_STATE_IDENTITY_PATH,
      mediaType: validated.stateIdentity.mediaType,
    },
    payload: {
      statePath: SESSION_BUNDLE_STATE_PATH,
      workspacePath: SESSION_BUNDLE_WORKSPACE_PATH,
      treeDigest: tree.treeDigest,
      payloadBytes: tree.payloadBytes,
      entryCount: tree.entryCount,
    },
  };
  const manifestBytes = Buffer.from(encodeSessionBundleManifestV1(manifest));
  assertQuota('pack', validated.limits, 'maxManifestBytes', manifestBytes.byteLength);
  const decompressedTarBytes = calculateTarBytes(manifestBytes.byteLength, entries);
  assertQuota('pack', validated.limits, 'maxDecompressedTarBytes', decompressedTarBytes);

  const parent = dirname(validated.destination);
  const parentMetadata = await stat(parent, { bigint: true });
  if (!parentMetadata.isDirectory()) throw ioError('pack');
  const temporaryPath = join(
    parent,
    `.${basename(validated.destination)}${PACK_TEMP_MARKER}${randomUUID()}.tmp`,
  );
  let handle: FileHandle | undefined;
  const archiveHash = createHash('sha256');
  const compressedMeter = new HashingQuotaTransform(
    archiveHash,
    validated.limits,
    'maxCompressedBytes',
    'pack',
  );
  let generatedTarBytes = 0;
  let output: ReturnType<FileHandle['createWriteStream']> | undefined;

  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    output = handle.createWriteStream({ autoClose: false, emitClose: false });
    const tar = Readable.from(
      meterGeneratedTar(generateSessionBundleTar(manifestBytes, entries), (bytes) => {
        generatedTarBytes += bytes;
      }),
    );
    await pipeline(
      tar,
      createSessionBundleZstdCompressor(),
      new CanonicalZstdOutputTransform(),
      compressedMeter,
      output,
    );
    if (generatedTarBytes !== decompressedTarBytes) {
      throw new SessionBundleFileError(
        'integrity_mismatch',
        'Session bundle USTAR byte count changed during pack',
      );
    }
    await assertPackDirectoriesUnchanged(entries);
    await handle.sync();
    output.destroy();
    output = undefined;
    await handle.close();
    handle = undefined;
    await publishPackFileNoReplace(temporaryPath, validated.destination);
    return {
      path: validated.destination,
      archiveDigest: `sha256:${archiveHash.digest('hex')}` as Sha256Digest,
      compressedBytes: compressedMeter.bytes,
      decompressedTarBytes,
      payloadBytes: tree.payloadBytes,
      entryCount: tree.entryCount,
    };
  } finally {
    output?.destroy();
    await handle?.close().catch(() => {});
    await removeOwnedPackTemporary(temporaryPath, parent).catch(() => {});
  }
}

async function scanPackRoot(
  sourceRoot: string,
  archiveRoot: 'state/' | 'workspace/',
  entries: PackEntry[],
  budget: PackScanBudget,
  limits: SessionBundleLimits,
): Promise<void> {
  const metadata = await lstat(sourceRoot, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new SessionBundleFileError(
      'unsupported_entry',
      'Session bundle source root must be a real directory',
    );
  }
  const rootFingerprint = fingerprint(metadata);
  validatePackPath(archiveRoot, limits);
  entries.push({
    canonical: { kind: 'directory', path: archiveRoot },
    sourcePath: sourceRoot,
    fingerprint: rootFingerprint,
  });
  assertQuota('pack', limits, 'maxEntryCount', entries.length);
  await scanPackDirectory(sourceRoot, archiveRoot, entries, budget, limits);
  const after = await lstat(sourceRoot, { bigint: true });
  if (!after.isDirectory() || !sameFingerprint(rootFingerprint, fingerprint(after))) {
    throw sourceChanged();
  }
}

async function scanPackDirectory(
  sourceDirectory: string,
  archiveDirectory: string,
  entries: PackEntry[],
  budget: PackScanBudget,
  limits: SessionBundleLimits,
): Promise<void> {
  const children = await readdir(sourceDirectory, { encoding: 'buffer', withFileTypes: true });
  for (const child of children) {
    const childName = decodeFilesystemName(child.name);
    const sourcePath = join(sourceDirectory, childName);
    const metadata = await lstat(sourcePath, { bigint: true });
    if (metadata.isSymbolicLink()) {
      throw new SessionBundleFileError(
        'unsupported_entry',
        'Session bundle source contains a symbolic link',
      );
    }
    if (metadata.isDirectory()) {
      const path = `${archiveDirectory}${childName}/`;
      validatePackPath(path, limits);
      const directoryFingerprint = fingerprint(metadata);
      entries.push({
        canonical: { kind: 'directory', path },
        sourcePath,
        fingerprint: directoryFingerprint,
      });
      assertQuota('pack', limits, 'maxEntryCount', entries.length);
      await scanPackDirectory(sourcePath, path, entries, budget, limits);
      const after = await lstat(sourcePath, { bigint: true });
      if (!after.isDirectory() || !sameFingerprint(directoryFingerprint, fingerprint(after))) {
        throw sourceChanged();
      }
      continue;
    }
    if (!metadata.isFile()) {
      throw new SessionBundleFileError(
        'unsupported_entry',
        'Session bundle source contains an unsupported filesystem entry',
      );
    }

    const path = `${archiveDirectory}${childName}`;
    validatePackPath(path, limits);
    const size = safeBigIntSize(metadata.size);
    budget.payloadBytes = safeAdd(budget.payloadBytes, size, 'quota_exceeded');
    assertQuota('pack', limits, 'maxPayloadBytes', budget.payloadBytes);
    encodeSessionBundleUstarHeaderV1({
      kind: 'file',
      path,
      mode: hasExecutableBit(metadata.mode) ? 0o755 : 0o644,
      size,
    });
    const file = await inspectPackFile(sourcePath, metadata, limits);
    entries.push({
      canonical: {
        kind: 'file',
        path,
        mode: hasExecutableBit(metadata.mode) ? 0o755 : 0o644,
        size: file.size,
        contentDigest: file.contentDigest,
      },
      sourcePath,
      fingerprint: file.fingerprint,
    });
    assertQuota('pack', limits, 'maxEntryCount', entries.length);
  }
}

async function inspectPackFile(
  sourcePath: string,
  scannedMetadata: BigIntStats,
  limits: SessionBundleLimits,
): Promise<{ contentDigest: Sha256Digest; fingerprint: FileFingerprint; size: number }> {
  const scannedFingerprint = fingerprint(scannedMetadata);
  const size = safeBigIntSize(scannedMetadata.size);
  assertQuota('pack', limits, 'maxFileBytes', size);
  const handle = await openPackSourceFile(sourcePath);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFingerprint(scannedFingerprint, fingerprint(before))) {
      throw sourceChanged();
    }
    const hash = createHash('sha256');
    let observed = 0;
    for await (const value of handle.createReadStream({
      autoClose: false,
      emitClose: false,
      highWaterMark: PACK_FILE_CHUNK_BYTES,
    })) {
      const chunk = Buffer.from(value);
      observed = safeAdd(observed, chunk.byteLength, 'source_changed');
      assertQuota('pack', limits, 'maxFileBytes', observed);
      hash.update(chunk);
    }
    const after = await handle.stat({ bigint: true });
    if (
      observed !== size ||
      !after.isFile() ||
      !sameFingerprint(scannedFingerprint, fingerprint(after))
    ) {
      throw sourceChanged();
    }
    return {
      contentDigest: `sha256:${hash.digest('hex')}` as Sha256Digest,
      fingerprint: scannedFingerprint,
      size,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function* generateSessionBundleTar(
  manifestBytes: Buffer,
  entries: readonly PackEntry[],
): AsyncGenerator<Buffer> {
  yield Buffer.from(
    encodeSessionBundleUstarHeaderV1({
      kind: 'file',
      path: SESSION_BUNDLE_MANIFEST_PATH,
      mode: 0o644,
      size: manifestBytes.byteLength,
    }),
  );
  yield manifestBytes;
  yield padding(manifestBytes.byteLength);

  for (const entry of entries) {
    yield Buffer.from(
      encodeSessionBundleUstarHeaderV1({
        kind: entry.canonical.kind,
        path: entry.canonical.path,
        mode: entry.canonical.kind === 'directory' ? 0o755 : entry.canonical.mode,
        size: entry.canonical.kind === 'directory' ? 0 : entry.canonical.size,
      }),
    );
    if (entry.canonical.kind === 'file') {
      if ('bytes' in entry) {
        yield entry.bytes;
      } else if (isPackDiskFileEntry(entry)) {
        yield* readVerifiedPackFile(entry);
      } else {
        throw new SessionBundleFileError(
          'integrity_mismatch',
          'Session bundle pack entry lost its source binding',
        );
      }
      yield padding(entry.canonical.size);
    }
  }
  yield ARCHIVE_TERMINATOR;
}

function isPackDiskFileEntry(entry: PackEntry): entry is PackDiskFileEntry {
  return entry.canonical.kind === 'file' && 'sourcePath' in entry;
}

async function* readVerifiedPackFile(entry: PackDiskFileEntry): AsyncGenerator<Buffer> {
  const handle = await openPackSourceFile(entry.sourcePath);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || !sameFingerprint(entry.fingerprint, fingerprint(before))) {
      throw sourceChanged();
    }
    const hash = createHash('sha256');
    let observed = 0;
    for await (const value of handle.createReadStream({
      autoClose: false,
      emitClose: false,
      highWaterMark: PACK_FILE_CHUNK_BYTES,
    })) {
      const chunk = Buffer.from(value);
      observed = safeAdd(observed, chunk.byteLength, 'source_changed');
      hash.update(chunk);
      yield chunk;
    }
    const after = await handle.stat({ bigint: true });
    const digest = `sha256:${hash.digest('hex')}`;
    if (
      observed !== entry.canonical.size ||
      digest !== entry.canonical.contentDigest ||
      !after.isFile() ||
      !sameFingerprint(entry.fingerprint, fingerprint(after))
    ) {
      throw sourceChanged();
    }
  } finally {
    await handle.close().catch(() => {});
  }
}

async function assertPackDirectoriesUnchanged(entries: readonly PackEntry[]): Promise<void> {
  for (const entry of entries) {
    if (entry.canonical.kind !== 'directory' || !('sourcePath' in entry)) continue;
    const metadata = await lstat(entry.sourcePath, { bigint: true });
    if (!metadata.isDirectory() || !sameFingerprint(entry.fingerprint, fingerprint(metadata))) {
      throw sourceChanged();
    }
  }
}

async function readAndValidateSessionBundle(input: {
  sourcePath: string;
  expectedArchiveDigest?: Sha256Digest;
  limits: SessionBundleLimits;
  operation: 'inspect' | 'hydrate';
  expectedSessionId?: string;
  stagingRoot?: string;
}): Promise<ReadValidationResult> {
  const handle = await open(input.sourcePath, 'r');
  const archiveHash = createHash('sha256');
  const compressedMeter = new HashingQuotaTransform(
    archiveHash,
    input.limits,
    'maxCompressedBytes',
    input.operation,
  );
  const decompressedMeter = new CountingQuotaTransform(
    input.limits,
    'maxDecompressedTarBytes',
    input.operation,
  );
  const output = new PassThrough();
  let pump: Promise<void> | undefined;
  let source: ReturnType<FileHandle['createReadStream']> | undefined;
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw ioError(input.operation);
    const sourceFingerprint = fingerprint(before);
    const sourceBytes = safeBigIntSize(before.size);
    assertQuota(input.operation, input.limits, 'maxCompressedBytes', sourceBytes);

    source = handle.createReadStream({ autoClose: false, emitClose: false });
    const decompressor = createZstdDecompress({
      params: {
        [zlibConstants.ZSTD_d_windowLogMax]: SESSION_BUNDLE_ZSTD_WINDOW_LOG,
      },
    });
    pump = pipeline(
      source,
      compressedMeter,
      new CanonicalZstdFrameTransform(),
      decompressor,
      decompressedMeter,
      output,
    );
    const parsed = await parseAndValidateTar(output, input);
    await pump;
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || !sameFingerprint(sourceFingerprint, fingerprint(after))) {
      throw sourceChanged();
    }
    if (compressedMeter.bytes !== sourceBytes) throw sourceChanged();

    const archiveDigest = `sha256:${archiveHash.digest('hex')}` as Sha256Digest;
    if (
      input.expectedArchiveDigest !== undefined &&
      input.expectedArchiveDigest !== archiveDigest
    ) {
      throw new SessionBundleFileError(
        'integrity_mismatch',
        'Session bundle archive digest does not match the expected digest',
      );
    }
    return {
      manifest: parsed.manifest,
      stateIdentity: parsed.stateIdentity,
      archiveDigest,
      verified: true,
      decompressedTarBytes: decompressedMeter.bytes,
    };
  } catch (error) {
    output.destroy();
    await pump?.catch(() => {});
    throw normalizeReadError(error, input.operation);
  } finally {
    source?.destroy();
    await handle.close().catch(() => {});
  }
}

async function parseAndValidateTar(
  source: AsyncIterable<Uint8Array>,
  input: {
    limits: SessionBundleLimits;
    operation: 'inspect' | 'hydrate';
    expectedSessionId?: string;
    stagingRoot?: string;
  },
): Promise<ParsedTarResult> {
  const reader = new AsyncByteReader(source);
  const manifestHeaderBytes = await reader.readExactly(SESSION_BUNDLE_USTAR_BLOCK_BYTES);
  if (isSessionBundleUstarZeroBlock(manifestHeaderBytes)) {
    throw new SessionBundleFileError('invalid_manifest', 'Session bundle manifest is missing');
  }
  const manifestHeader = decodeSessionBundleUstarHeaderV1(manifestHeaderBytes);
  if (
    manifestHeader.kind !== 'file' ||
    manifestHeader.path !== SESSION_BUNDLE_MANIFEST_PATH ||
    manifestHeader.mode !== 0o644
  ) {
    throw new SessionBundleFileError(
      'invalid_manifest',
      'Session bundle manifest is not the first canonical USTAR entry',
    );
  }
  assertPathQuota(input.operation, input.limits, manifestHeader.path);
  assertQuota(input.operation, input.limits, 'maxManifestBytes', manifestHeader.size);
  const manifestBytes = await reader.readExactly(manifestHeader.size);
  await reader.readZeroPadding(sessionBundleUstarPaddingBytes(manifestHeader.size));
  const manifest = decodeSessionBundleManifestV1(manifestBytes);
  assertQuota(input.operation, input.limits, 'maxEntryCount', manifest.payload.entryCount);
  assertQuota(input.operation, input.limits, 'maxPayloadBytes', manifest.payload.payloadBytes);
  if (
    input.expectedSessionId !== undefined &&
    manifest.envelope.sessionId !== input.expectedSessionId
  ) {
    throw new SessionBundleFileError(
      'identity_mismatch',
      'Session bundle Cloud Session identity does not match the expected identity',
    );
  }

  const builder = new SessionBundleCanonicalTreeDigestBuilder(manifest.payload.entryCount);
  const layout: ArchiveLayoutState = {
    directories: new Set(),
    logicalPaths: new Set(),
  };
  let declaredPayloadBytes = 0;
  let identityBytes: Buffer | undefined;

  for (let entryIndex = 0; entryIndex < manifest.payload.entryCount; entryIndex += 1) {
    const headerBytes = await reader.readExactly(SESSION_BUNDLE_USTAR_BLOCK_BYTES);
    if (isSessionBundleUstarZeroBlock(headerBytes)) {
      throw new SessionBundleFileError(
        'integrity_mismatch',
        'Session bundle ended before every declared payload entry',
        { details: { operation: input.operation, entryIndex } },
      );
    }
    const header = decodeSessionBundleUstarHeaderV1(headerBytes);
    validateArchiveEntryBeforeContent(header, layout, input, entryIndex);
    if (header.kind === 'file') {
      assertQuota(input.operation, input.limits, 'maxFileBytes', header.size, entryIndex);
      if (header.path === SESSION_BUNDLE_STATE_IDENTITY_PATH) {
        assertQuota(
          input.operation,
          input.limits,
          'maxStateIdentityBytes',
          header.size,
          entryIndex,
        );
      }
      declaredPayloadBytes = safeAdd(declaredPayloadBytes, header.size, 'integrity_mismatch');
      assertQuota(
        input.operation,
        input.limits,
        'maxPayloadBytes',
        declaredPayloadBytes,
        entryIndex,
      );
      if (declaredPayloadBytes > manifest.payload.payloadBytes) {
        throw new SessionBundleFileError(
          'integrity_mismatch',
          'Session bundle payload exceeds its manifest declaration',
        );
      }
    }

    const result = await consumeArchiveEntry(reader, header, input);
    builder.add(
      header.kind === 'directory'
        ? { kind: 'directory', path: header.path }
        : {
            kind: 'file',
            path: header.path,
            mode: header.mode,
            size: header.size,
            contentDigest: result.contentDigest,
          },
    );
    if (result.identityBytes !== undefined) identityBytes = result.identityBytes;
  }

  const firstTerminator = await reader.readExactly(SESSION_BUNDLE_USTAR_BLOCK_BYTES);
  const secondTerminator = await reader.readExactly(SESSION_BUNDLE_USTAR_BLOCK_BYTES);
  if (
    !isSessionBundleUstarZeroBlock(firstTerminator) ||
    !isSessionBundleUstarZeroBlock(secondTerminator)
  ) {
    throw new SessionBundleFileError(
      'integrity_mismatch',
      'Session bundle does not end with exactly two canonical zero blocks',
    );
  }
  await reader.assertEof();

  if (
    !layout.directories.has(SESSION_BUNDLE_STATE_PATH) ||
    !layout.directories.has(SESSION_BUNDLE_WORKSPACE_PATH)
  ) {
    throw new SessionBundleFileError(
      'integrity_mismatch',
      'Session bundle is missing a required payload root',
    );
  }

  const tree = builder.finish();
  if (
    tree.treeDigest !== manifest.payload.treeDigest ||
    tree.payloadBytes !== manifest.payload.payloadBytes ||
    tree.entryCount !== manifest.payload.entryCount
  ) {
    throw new SessionBundleFileError(
      'integrity_mismatch',
      'Session bundle payload tree does not match its manifest',
    );
  }
  if (identityBytes === undefined) {
    throw new SessionBundleFileError(
      'integrity_mismatch',
      'Session bundle state identity descriptor is missing',
    );
  }
  return {
    manifest,
    stateIdentity: {
      mediaType: manifest.stateIdentity.mediaType,
      bytes: Uint8Array.from(identityBytes),
    },
  };
}

function validateArchiveEntryBeforeContent(
  header: SessionBundleUstarHeader,
  layout: ArchiveLayoutState,
  input: { limits: SessionBundleLimits; operation: 'inspect' | 'hydrate' },
  entryIndex: number,
): void {
  const { path } = header;
  if (
    !isValidUnicodeString(path) ||
    path.length === 0 ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw unsafePath(input.operation, entryIndex);
  }
  const isDirectory = header.kind === 'directory';
  if (isDirectory !== path.endsWith('/')) throw unsafePath(input.operation, entryIndex);
  const logicalPath = isDirectory ? path.slice(0, -1) : path;
  const segments = logicalPath.split('/');
  if (
    logicalPath.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw unsafePath(input.operation, entryIndex);
  }
  assertPathQuota(input.operation, input.limits, path, entryIndex);
  if (
    layout.previousPath !== undefined &&
    compareSessionBundleCanonicalPaths(layout.previousPath, path) >= 0
  ) {
    throw unsafePath(input.operation, entryIndex);
  }
  if (layout.logicalPaths.has(logicalPath)) throw unsafePath(input.operation, entryIndex);
  const parent = segments.length === 1 ? undefined : `${segments.slice(0, -1).join('/')}/`;
  if (parent !== undefined && !layout.directories.has(parent)) {
    throw unsafePath(input.operation, entryIndex);
  }
  if (path === SESSION_BUNDLE_STATE_IDENTITY_PATH) {
    if (header.kind !== 'file' || header.mode !== 0o644) {
      throw unsupportedEntry(input.operation, entryIndex);
    }
  } else if (path === SESSION_BUNDLE_STATE_PATH || path === SESSION_BUNDLE_WORKSPACE_PATH) {
    if (header.kind !== 'directory') throw unsupportedEntry(input.operation, entryIndex);
  } else if (
    !path.startsWith(SESSION_BUNDLE_STATE_PATH) &&
    !path.startsWith(SESSION_BUNDLE_WORKSPACE_PATH)
  ) {
    throw unsafePath(input.operation, entryIndex);
  }

  layout.logicalPaths.add(logicalPath);
  if (isDirectory) layout.directories.add(path);
  layout.previousPath = path;
}

async function consumeArchiveEntry(
  reader: AsyncByteReader,
  header: SessionBundleUstarHeader,
  input: {
    operation: 'inspect' | 'hydrate';
    stagingRoot?: string;
  },
): Promise<{ contentDigest: Sha256Digest; identityBytes?: Buffer }> {
  if (header.kind === 'directory') {
    if (input.stagingRoot !== undefined) {
      const path = hydrationPath(input.stagingRoot, header.path);
      await mkdir(path, { mode: 0o755 });
      await chmod(path, 0o755);
    }
    return { contentDigest: digestBytes(Buffer.alloc(0)) };
  }

  const hash = createHash('sha256');
  const identityChunks: Buffer[] | undefined =
    header.path === SESSION_BUNDLE_STATE_IDENTITY_PATH ? [] : undefined;
  let output: FileHandle | undefined;
  try {
    if (input.stagingRoot !== undefined) {
      output = await open(hydrationPath(input.stagingRoot, header.path), 'wx', header.mode);
    }
    await reader.consumeExactly(header.size, async (chunk) => {
      hash.update(chunk);
      if (identityChunks !== undefined) identityChunks.push(Buffer.from(chunk));
      if (output !== undefined) await writeAll(output, chunk);
    });
    await reader.readZeroPadding(sessionBundleUstarPaddingBytes(header.size));
    if (output !== undefined) {
      await output.sync();
      await output.chmod(header.mode);
    }
  } finally {
    await output?.close().catch(() => {});
  }
  return {
    contentDigest: `sha256:${hash.digest('hex')}` as Sha256Digest,
    ...(identityChunks === undefined ? {} : { identityBytes: Buffer.concat(identityChunks) }),
  };
}

class AsyncByteReader {
  readonly #iterator: AsyncIterator<Uint8Array>;
  #chunk = Buffer.alloc(0);
  #offset = 0;
  #ended = false;

  constructor(source: AsyncIterable<Uint8Array>) {
    this.#iterator = source[Symbol.asyncIterator]();
  }

  async readExactly(size: number): Promise<Buffer> {
    if (!Number.isSafeInteger(size) || size < 0) throw integrityError();
    const output = Buffer.alloc(size);
    let written = 0;
    await this.consumeExactly(size, (chunk) => {
      chunk.copy(output, written);
      written += chunk.byteLength;
    });
    return output;
  }

  async consumeExactly(
    size: number,
    consume: (chunk: Buffer) => void | Promise<void>,
  ): Promise<void> {
    let remaining = size;
    while (remaining > 0) {
      if (!(await this.#ensureChunk())) throw integrityError();
      const available = this.#chunk.byteLength - this.#offset;
      const length = Math.min(remaining, available);
      const slice = this.#chunk.subarray(this.#offset, this.#offset + length);
      await consume(slice);
      this.#offset += length;
      remaining -= length;
    }
  }

  async readZeroPadding(size: number): Promise<void> {
    await this.consumeExactly(size, (chunk) => {
      if (chunk.some((byte) => byte !== 0)) {
        throw new SessionBundleFileError(
          'integrity_mismatch',
          'Session bundle USTAR padding is not canonical',
        );
      }
    });
  }

  async assertEof(): Promise<void> {
    if (await this.#ensureChunk()) {
      throw new SessionBundleFileError(
        'integrity_mismatch',
        'Session bundle contains bytes after its canonical terminator',
      );
    }
  }

  async #ensureChunk(): Promise<boolean> {
    while (this.#offset >= this.#chunk.byteLength && !this.#ended) {
      const next = await this.#iterator.next();
      if (next.done) {
        this.#ended = true;
        this.#chunk = Buffer.alloc(0);
        this.#offset = 0;
        break;
      }
      this.#chunk = Buffer.from(next.value);
      this.#offset = 0;
    }
    return this.#offset < this.#chunk.byteLength;
  }
}

class CountingQuotaTransform extends Transform {
  bytes = 0;

  constructor(
    private readonly limits: SessionBundleLimits,
    private readonly quota: SessionBundleQuotaName,
    private readonly operation: SessionBundleFileOperation,
  ) {
    super();
  }

  override _transform(
    value: Buffer | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    const chunk = Buffer.from(value);
    try {
      this.bytes = safeAdd(this.bytes, chunk.byteLength, 'quota_exceeded');
      assertQuota(this.operation, this.limits, this.quota, this.bytes);
      callback(null, chunk);
    } catch (error) {
      callback(error as Error);
    }
  }
}

class HashingQuotaTransform extends CountingQuotaTransform {
  constructor(
    private readonly hash: Hash,
    limits: SessionBundleLimits,
    quota: SessionBundleQuotaName,
    operation: SessionBundleFileOperation,
  ) {
    super(limits, quota, operation);
  }

  override _transform(
    value: Buffer | Uint8Array,
    encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    const chunk = Buffer.from(value);
    super._transform(chunk, encoding, (error, data) => {
      if (error !== undefined && error !== null) {
        callback(error);
        return;
      }
      this.hash.update(chunk);
      callback(null, data);
    });
  }
}

/** Remove the empty frame Node's streaming compressor appends after multi-chunk input. */
class CanonicalZstdOutputTransform extends Transform {
  #tail = Buffer.alloc(0);

  override _transform(
    value: Buffer | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    const combined = Buffer.concat([this.#tail, Buffer.from(value)]);
    if (combined.byteLength <= NODE_ZSTD_TRAILING_EMPTY_FRAME.byteLength) {
      this.#tail = combined;
      callback();
      return;
    }
    const retainedBytes = NODE_ZSTD_TRAILING_EMPTY_FRAME.byteLength;
    const emittedBytes = combined.byteLength - retainedBytes;
    this.#tail = combined.subarray(emittedBytes);
    callback(null, combined.subarray(0, emittedBytes));
  }

  override _flush(callback: (error?: Error | null) => void): void {
    if (!this.#tail.equals(NODE_ZSTD_TRAILING_EMPTY_FRAME)) this.push(this.#tail);
    this.#tail = Buffer.alloc(0);
    callback();
  }
}

type ZstdFramePhase = 'block-header' | 'block-payload' | 'checksum' | 'frame-header';

/**
 * Node's native decoder accepts arbitrary bytes after its last complete frame.
 * Validate the framing independently while passing the same bytes downstream.
 */
class CanonicalZstdFrameTransform extends Transform {
  #buffer = Buffer.alloc(0);
  #frameCount = 0;
  #lastBlock = false;
  #payloadBytes = 0;
  #phase: ZstdFramePhase = 'frame-header';

  override _transform(
    value: Buffer | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null, data?: Buffer) => void,
  ): void {
    const chunk = Buffer.from(value);
    try {
      this.#buffer = this.#buffer.byteLength === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
      this.#consumeAvailableBytes();
      callback(null, chunk);
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    if (this.#phase !== 'frame-header' || this.#buffer.byteLength !== 0 || this.#frameCount !== 1) {
      callback(
        new SessionBundleFileError(
          'integrity_mismatch',
          'Session bundle Zstandard framing is truncated or contains trailing bytes',
        ),
      );
      return;
    }
    callback();
  }

  #consumeAvailableBytes(): void {
    while (true) {
      if (this.#phase === 'frame-header') {
        if (this.#frameCount !== 0 && this.#buffer.byteLength !== 0) {
          throw new SessionBundleFileError(
            'integrity_mismatch',
            'Session bundle must contain exactly one canonical Zstandard frame',
          );
        }
        if (this.#buffer.byteLength < 6) return;
        if (
          this.#buffer.readUInt32LE(0) !== 0xfd2fb528 ||
          this.#buffer[4] !== 0x04 ||
          this.#buffer[5] !== SESSION_BUNDLE_ZSTD_WINDOW_DESCRIPTOR
        ) {
          throw new SessionBundleFileError(
            'integrity_mismatch',
            'Session bundle Zstandard frame settings are not canonical',
          );
        }
        this.#discard(6);
        this.#phase = 'block-header';
        continue;
      }

      if (this.#phase === 'block-header') {
        if (this.#buffer.byteLength < 3) return;
        const header = this.#buffer[0] | (this.#buffer[1] << 8) | (this.#buffer[2] << 16);
        this.#lastBlock = (header & 1) === 1;
        const blockType = (header >>> 1) & 0x03;
        const blockSize = header >>> 3;
        if (blockType === 0x03 || blockSize > 128 * 1024) {
          throw new SessionBundleFileError(
            'integrity_mismatch',
            'Session bundle Zstandard block is malformed',
          );
        }
        this.#payloadBytes = blockType === 0x01 ? 1 : blockSize;
        this.#discard(3);
        this.#phase = 'block-payload';
        continue;
      }

      if (this.#phase === 'block-payload') {
        if (this.#buffer.byteLength < this.#payloadBytes) {
          this.#payloadBytes -= this.#buffer.byteLength;
          this.#buffer = Buffer.alloc(0);
          return;
        }
        this.#discard(this.#payloadBytes);
        this.#payloadBytes = 0;
        this.#phase = this.#lastBlock ? 'checksum' : 'block-header';
        continue;
      }

      if (this.#buffer.byteLength < 4) return;
      this.#discard(4);
      this.#frameCount += 1;
      this.#phase = 'frame-header';
    }
  }

  #discard(bytes: number): void {
    this.#buffer = this.#buffer.subarray(bytes);
  }
}

function createSessionBundleZstdCompressor(): Transform {
  return createZstdCompress({
    params: {
      [zlibConstants.ZSTD_c_compressionLevel]: SESSION_BUNDLE_COMPRESSION_LEVEL,
      [zlibConstants.ZSTD_c_checksumFlag]: 1,
      [zlibConstants.ZSTD_c_contentSizeFlag]: 0,
      [zlibConstants.ZSTD_c_dictIDFlag]: 0,
      [zlibConstants.ZSTD_c_nbWorkers]: 0,
      [zlibConstants.ZSTD_c_windowLog]: SESSION_BUNDLE_ZSTD_WINDOW_LOG,
    },
  });
}

async function* meterGeneratedTar(
  source: AsyncIterable<Buffer>,
  observe: (bytes: number) => void,
): AsyncGenerator<Buffer> {
  for await (const chunk of source) {
    observe(chunk.byteLength);
    if (chunk.byteLength > 0) yield chunk;
  }
}

function calculateTarBytes(manifestBytes: number, entries: readonly PackEntry[]): number {
  let total = tarEntryBytes(manifestBytes);
  for (const entry of entries) {
    total = safeAdd(
      total,
      tarEntryBytes(entry.canonical.kind === 'directory' ? 0 : entry.canonical.size),
      'unsupported_entry',
    );
  }
  return safeAdd(total, ARCHIVE_TERMINATOR.byteLength, 'unsupported_entry');
}

function tarEntryBytes(size: number): number {
  return safeAdd(
    SESSION_BUNDLE_USTAR_BLOCK_BYTES,
    safeAdd(size, sessionBundleUstarPaddingBytes(size), 'unsupported_entry'),
    'unsupported_entry',
  );
}

function padding(size: number): Buffer {
  const bytes = sessionBundleUstarPaddingBytes(size);
  return bytes === 0 ? Buffer.alloc(0) : Buffer.alloc(bytes);
}

function validatePackPath(path: string, limits: SessionBundleLimits): void {
  assertPathQuota('pack', limits, path);
  if (
    !isValidUnicodeString(path) ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path)
  ) {
    throw new SessionBundleFileError('unsafe_path', 'Session bundle source path is unsafe');
  }
  const logicalPath = path.endsWith('/') ? path.slice(0, -1) : path;
  if (
    logicalPath.length === 0 ||
    logicalPath
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    throw new SessionBundleFileError('unsafe_path', 'Session bundle source path is unsafe');
  }
  encodeSessionBundleUstarHeaderV1({
    kind: path.endsWith('/') ? 'directory' : 'file',
    path,
    mode: path.endsWith('/') ? 0o755 : 0o644,
    size: 0,
  });
}

function assertPathQuota(
  operation: SessionBundleFileOperation,
  limits: SessionBundleLimits,
  path: string,
  entryIndex?: number,
): void {
  const pathBytes = Buffer.byteLength(path, 'utf8');
  const logicalPath = path.endsWith('/') ? path.slice(0, -1) : path;
  const depth = logicalPath.length === 0 ? 0 : logicalPath.split('/').length;
  assertQuota(operation, limits, 'maxPathBytes', pathBytes, entryIndex);
  assertQuota(operation, limits, 'maxPathDepth', depth, entryIndex, depth);
}

function assertQuota(
  operation: SessionBundleFileOperation,
  limits: SessionBundleLimits,
  quota: SessionBundleQuotaName,
  observed: number,
  entryIndex?: number,
  pathDepth?: number,
): void {
  const limit = limits[quota];
  if (observed <= limit) return;
  throw new SessionBundleFileError('quota_exceeded', 'Session bundle quota was exceeded', {
    details: {
      operation,
      quota,
      limit,
      observed,
      ...(entryIndex === undefined ? {} : { entryIndex }),
      ...(pathDepth === undefined ? {} : { pathDepth }),
    },
  });
}

function validatePackInput(input: SessionBundlePackInput): {
  stateRoot: string;
  workspaceRoot: string;
  stateIdentity: OpaqueStateIdentityDescriptor;
  envelope: SessionBundleManifestV1['envelope'];
  destination: string;
  limits: SessionBundleLimits;
} {
  if (!isRecord(input) || !isRecord(input.snapshot) || !isRecord(input.envelope)) {
    throw new TypeError('Session bundle pack input must be an object');
  }
  assertSessionBundleLimits(input.limits);
  const stateRoot = requiredFilesystemPath(input.snapshot.stateRoot, 'stateRoot');
  const workspaceRoot = requiredFilesystemPath(input.snapshot.workspaceRoot, 'workspaceRoot');
  const destination = requiredFilesystemPath(input.destination, 'destination');
  const stateIdentity = copyOpaqueStateIdentityDescriptor(input.snapshot.stateIdentity);
  if (!isNonEmptyUnicodeString(input.envelope.sessionId)) {
    throw new TypeError('Session bundle sessionId must be a non-empty Unicode string');
  }
  let lastCommittedActivationId: string | undefined;
  if (Object.hasOwn(input.envelope, 'lastCommittedActivationId')) {
    if (!isNonEmptyUnicodeString(input.envelope.lastCommittedActivationId)) {
      throw new TypeError(
        'Session bundle lastCommittedActivationId must be a non-empty Unicode string',
      );
    }
    lastCommittedActivationId = input.envelope.lastCommittedActivationId;
  }
  return {
    stateRoot,
    workspaceRoot,
    stateIdentity,
    envelope: {
      sessionId: input.envelope.sessionId,
      ...(lastCommittedActivationId === undefined ? {} : { lastCommittedActivationId }),
    },
    destination,
    limits: input.limits,
  };
}

function validateReadInput(input: SessionBundleReadInput): {
  sourcePath: string;
  expectedArchiveDigest?: Sha256Digest;
  limits: SessionBundleLimits;
} {
  if (!isRecord(input) || !isRecord(input.source)) {
    throw new TypeError('Session bundle read input must be an object');
  }
  assertSessionBundleLimits(input.limits);
  const sourcePath = requiredFilesystemPath(input.source.path, 'source.path');
  let expectedArchiveDigest: Sha256Digest | undefined;
  if (Object.hasOwn(input.source, 'expectedArchiveDigest')) {
    if (!isSha256Digest(input.source.expectedArchiveDigest)) {
      throw new TypeError('Session bundle expected archive digest must be lowercase SHA-256');
    }
    expectedArchiveDigest = input.source.expectedArchiveDigest;
  }
  return {
    sourcePath,
    ...(expectedArchiveDigest === undefined ? {} : { expectedArchiveDigest }),
    limits: input.limits,
  };
}

function validateHydrateInput(input: SessionBundleHydrateInput): {
  sourcePath: string;
  expectedArchiveDigest?: Sha256Digest;
  limits: SessionBundleLimits;
  expectedSessionId: string;
  destinationRoot: string;
} {
  const read = validateReadInput(input);
  if (!isNonEmptyUnicodeString(input.expectedSessionId)) {
    throw new TypeError('Session bundle expectedSessionId must be a non-empty Unicode string');
  }
  return {
    ...read,
    expectedSessionId: input.expectedSessionId,
    destinationRoot: requiredFilesystemPath(input.destinationRoot, 'destinationRoot'),
  };
}

function requiredFilesystemPath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new TypeError(`Session bundle ${label} must be a non-empty filesystem path`);
  }
  return resolve(value);
}

function decodeFilesystemName(value: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    throw new SessionBundleFileError(
      'unsafe_path',
      'Session bundle source name is not valid UTF-8',
    );
  }
}

async function assertDestinationMissing(
  path: string,
  operation: 'pack' | 'hydrate',
): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
  throw destinationExists(operation);
}

async function publishPackFileNoReplace(temporaryPath: string, destination: string): Promise<void> {
  try {
    // Both paths are siblings, so a hard link is an atomic no-replace publication.
    await link(temporaryPath, destination);
  } catch (error) {
    if (isErrno(error, 'EEXIST')) throw destinationExists('pack');
    throw error;
  }
}

async function withDestinationPublicationLock<T>(
  destination: string,
  operation: 'hydrate',
  action: () => Promise<T>,
): Promise<T> {
  const lockPath = join(
    dirname(destination),
    `${PUBLICATION_LOCK_MARKER}${createHash('sha256')
      .update(basename(destination).normalize('NFC').toLocaleLowerCase('en-US'))
      .digest('hex')}.lock`,
  );
  return runWithPublicationLockGate(lockPath, async () => {
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    const handle = await open(lockPath, fsConstants.O_CREAT | fsConstants.O_RDWR | noFollow, 0o600);
    let acquired = false;
    try {
      if (process.platform !== 'win32') await handle.chmod(0o600);
      await assertStablePublicationLock(handle, lockPath, operation);
      await waitForLock(handle.fd);
      acquired = true;
      await assertStablePublicationLock(handle, lockPath, operation);
      return await action();
    } finally {
      if (acquired) {
        try {
          unlock(handle.fd);
        } catch {
          // Closing the handle is the final OS-level release path.
        }
      }
      await handle.close().catch(() => {});
    }
  });
}

async function runWithPublicationLockGate<T>(
  lockPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = publicationLockGates.get(lockPath);
  let release!: () => void;
  const current = new Promise<void>((resolveGate) => {
    release = resolveGate;
  });
  publicationLockGates.set(lockPath, current);
  await previous?.catch(() => {});
  try {
    return await action();
  } finally {
    release();
    if (publicationLockGates.get(lockPath) === current) publicationLockGates.delete(lockPath);
  }
}

async function assertStablePublicationLock(
  handle: FileHandle,
  lockPath: string,
  operation: 'hydrate',
): Promise<void> {
  const [handleMetadata, pathMetadata] = await Promise.all([
    handle.stat({ bigint: true }),
    lstat(lockPath, { bigint: true }),
  ]);
  if (
    !handleMetadata.isFile() ||
    !pathMetadata.isFile() ||
    handleMetadata.dev !== pathMetadata.dev ||
    handleMetadata.ino !== pathMetadata.ino
  ) {
    throw ioError(operation);
  }
}

async function openPackSourceFile(path: string): Promise<FileHandle> {
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  try {
    return await open(path, fsConstants.O_RDONLY | noFollow);
  } catch (error) {
    if (isErrno(error, 'ELOOP')) {
      throw new SessionBundleFileError(
        'unsupported_entry',
        'Session bundle source changed to a symbolic link',
      );
    }
    throw error;
  }
}

function hydrationPath(stagingRoot: string, archivePath: string): string {
  const logical = archivePath.endsWith('/') ? archivePath.slice(0, -1) : archivePath;
  return join(stagingRoot, ...logical.split('/'));
}

async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const result = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (result.bytesWritten <= 0) throw ioError('hydrate');
    offset += result.bytesWritten;
  }
}

async function removeOwnedHydrationStaging(
  stagingRoot: string,
  parent: string,
  prefix: string,
  expectedFingerprint: FileFingerprint | undefined,
): Promise<void> {
  if (
    expectedFingerprint === undefined ||
    dirname(stagingRoot) !== parent ||
    !basename(stagingRoot).startsWith(prefix)
  ) {
    return;
  }
  const metadata = await lstat(stagingRoot, { bigint: true }).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (
    metadata === undefined ||
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !sameFilesystemNode(expectedFingerprint, fingerprint(metadata))
  ) {
    return;
  }
  await rm(stagingRoot, { recursive: true });
}

async function removeOwnedPackTemporary(path: string, parent: string): Promise<void> {
  if (dirname(path) !== parent || !basename(path).includes(PACK_TEMP_MARKER)) return;
  const metadata = await lstat(path).catch((error: unknown) => {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (metadata === undefined || !metadata.isFile() || metadata.isSymbolicLink()) return;
  await rm(path);
}

function inspectionFromReadResult(result: ReadValidationResult): SessionBundleInspection {
  return {
    manifest: result.manifest,
    stateIdentity: copyOpaqueStateIdentityDescriptor(result.stateIdentity),
    archiveDigest: result.archiveDigest,
    verified: true,
  };
}

function fingerprint(metadata: BigIntStats): FileFingerprint {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameFilesystemNode(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function safeBigIntSize(value: bigint): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new SessionBundleFileError(
      'unsupported_entry',
      'Session bundle filesystem entry size is outside the safe integer range',
    );
  }
  return Number(value);
}

function safeAdd(
  left: number,
  right: number,
  code: 'integrity_mismatch' | 'quota_exceeded' | 'source_changed' | 'unsupported_entry',
): number {
  const value = left + right;
  if (!Number.isSafeInteger(value)) {
    throw new SessionBundleFileError(code, 'Session bundle byte count exceeds safe integers');
  }
  return value;
}

function hasExecutableBit(mode: bigint): boolean {
  return (mode & 0o111n) !== 0n;
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(value).digest('hex')}` as Sha256Digest;
}

function sourceChanged(): SessionBundleFileError {
  return new SessionBundleFileError(
    'source_changed',
    'Session bundle source changed while it was being consumed',
  );
}

function destinationExists(operation: 'pack' | 'hydrate'): SessionBundleFileError {
  return new SessionBundleFileError(
    'destination_exists',
    'Session bundle destination already exists',
    { details: { operation } },
  );
}

function unsafePath(
  operation: SessionBundleFileOperation,
  entryIndex: number,
): SessionBundleFileError {
  return new SessionBundleFileError('unsafe_path', 'Session bundle contains an unsafe path', {
    details: { operation, entryIndex },
  });
}

function unsupportedEntry(
  operation: SessionBundleFileOperation,
  entryIndex: number,
): SessionBundleFileError {
  return new SessionBundleFileError(
    'unsupported_entry',
    'Session bundle contains unsupported entry metadata',
    { details: { operation, entryIndex } },
  );
}

function integrityError(): SessionBundleFileError {
  return new SessionBundleFileError(
    'integrity_mismatch',
    'Session bundle archive is truncated or malformed',
  );
}

function ioError(operation: SessionBundleFileOperation): SessionBundleFileError {
  return new SessionBundleFileError('io_failure', 'Session bundle filesystem operation failed', {
    details: { operation },
  });
}

function normalizeReadError(
  error: unknown,
  operation: 'inspect' | 'hydrate',
): SessionBundleFileError {
  if (error instanceof SessionBundleFileError) return error;
  if (isFilesystemError(error)) return ioError(operation);
  return new SessionBundleFileError(
    'integrity_mismatch',
    'Session bundle compressed stream is invalid or truncated',
  );
}

function normalizeOperationError(error: unknown, operation: SessionBundleFileOperation): Error {
  if (
    error instanceof SessionBundleFileError ||
    error instanceof TypeError ||
    error instanceof RangeError
  ) {
    return error;
  }
  return ioError(operation);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

function isFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  return isErrnoException(error) && typeof error.syscall === 'string';
}

function isErrno(error: unknown, code: string): boolean {
  return isErrnoException(error) && error.code === code;
}
