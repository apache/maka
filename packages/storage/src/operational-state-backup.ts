import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ArtifactRecord } from '@maka/core/artifacts';
import { decodeLegacyAutomationFile, LEGACY_AUTOMATION_FILE } from './automation-authority.js';
import { decodeArtifactMetadata } from './artifact-metadata-codec.js';
import {
  ARTIFACT_PUBLICATION_STAGING_PATTERN,
  ARTIFACT_PURGE_INTENT_FILE,
  isCanonicalArtifactRecoveryTempName,
} from './artifact-storage-layout.js';
import { withArtifactWriterLock } from './artifact-writer-lock.js';
import { decodeStoredMessageForRecovery } from './execution-record-codec.js';
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
  OPERATIONAL_STATE_SCHEMA_VERSION,
} from './operational-state-store.js';
import { SQLITE_ARTIFACT_SCHEMA_VERSION } from './sqlite-artifact-schema.js';
import { SQLITE_AUTOMATION_SCHEMA_VERSION } from './sqlite-automation-schema.js';
import { createSqliteArtifactMetadataRepository } from './sqlite-artifact-metadata.js';
import { SQLITE_CORE_EXECUTION_SCHEMA_VERSION } from './sqlite-core-execution-schema.js';
import { SQLITE_RUNTIME_SCHEMA_VERSION } from './sqlite-runtime-schema.js';
import { decodeSessionHeader } from './session-store.js';
import { SQLITE_SESSION_METADATA_SCHEMA_VERSION } from './sqlite-session-metadata-schema.js';
import { decodeSessionTranscriptMarker, isSessionTranscriptMarker } from './session-transcript.js';
import { SQLITE_USAGE_SCHEMA_VERSION } from './sqlite-usage-schema.js';
import { SQLITE_WORKFLOW_SCHEMA_VERSION } from './sqlite-workflow-schema.js';
import { syncDirectory, syncDirectoryChain, syncFile } from './stable-storage.js';

export const OPERATIONAL_BACKUP_FORMAT = 'maka-operational-backup';
export const OPERATIONAL_BACKUP_SCHEMA_VERSION = 2 as const;
export const OPERATIONAL_BACKUP_MANIFEST_FILE = 'operational-backup.json';

const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const LEGACY_OPERATIONAL_BACKUP_SCHEMA_VERSION = 1 as const;
const require = createRequire(import.meta.url);
const supportedSchemaVersions = new Map<string, number>([
  ['runtime', SQLITE_RUNTIME_SCHEMA_VERSION],
  ['session_metadata', SQLITE_SESSION_METADATA_SCHEMA_VERSION],
  ['core_execution', SQLITE_CORE_EXECUTION_SCHEMA_VERSION],
  ['workflow', SQLITE_WORKFLOW_SCHEMA_VERSION],
  ['usage', SQLITE_USAGE_SCHEMA_VERSION],
  ['artifact', SQLITE_ARTIFACT_SCHEMA_VERSION],
  ['automation', SQLITE_AUTOMATION_SCHEMA_VERSION],
  ['operational', OPERATIONAL_STATE_SCHEMA_VERSION],
]);

export type OperationalBackupErrorCode =
  | 'invalid_root'
  | 'overlapping_roots'
  | 'destination_exists'
  | 'source_changed'
  | 'invalid_manifest'
  | 'corrupt_backup'
  | 'unsupported_schema';

export class OperationalBackupError extends Error {
  constructor(
    readonly code: OperationalBackupErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OperationalBackupError';
  }
}

export type OperationalBackupFailpoint =
  | 'after_database_snapshot'
  | 'after_payload_copy'
  | 'after_manifest_write'
  | 'after_restore_copy';

export interface OperationalBackupFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: `sha256:${string}`;
}

export interface OperationalBackupTranscript extends OperationalBackupFile {
  readonly sessionId: string;
}

export interface OperationalBackupArtifact extends OperationalBackupFile {
  readonly record: ArtifactRecord;
}

interface OperationalBackupManifestBase {
  readonly format: typeof OPERATIONAL_BACKUP_FORMAT;
  readonly createdAt: number;
  readonly database: OperationalBackupFile;
  readonly transcripts: readonly OperationalBackupTranscript[];
  readonly artifacts: readonly OperationalBackupArtifact[];
}

export interface LegacyOperationalBackupManifest extends OperationalBackupManifestBase {
  readonly schemaVersion: typeof LEGACY_OPERATIONAL_BACKUP_SCHEMA_VERSION;
}

export interface CurrentOperationalBackupManifest extends OperationalBackupManifestBase {
  readonly schemaVersion: typeof OPERATIONAL_BACKUP_SCHEMA_VERSION;
  readonly legacyAutomation: OperationalBackupFile | null;
}

export type OperationalBackupManifest =
  | LegacyOperationalBackupManifest
  | CurrentOperationalBackupManifest;

export interface CreateOperationalBackupInput {
  readonly stateRoot: string;
  readonly destinationRoot: string;
  readonly now?: () => number;
  readonly failpoint?: (point: OperationalBackupFailpoint) => void | Promise<void>;
}

export interface RestoreOperationalBackupInput {
  readonly backupRoot: string;
  readonly destinationRoot: string;
  readonly failpoint?: (point: OperationalBackupFailpoint) => void | Promise<void>;
}

interface SourceFileSnapshot extends OperationalBackupFile {
  readonly sourcePath: string;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface SourceTranscriptSnapshot extends SourceFileSnapshot {
  readonly sessionId: string;
}

type OptionalSourceFileSnapshot =
  | { readonly kind: 'present'; readonly snapshot: SourceFileSnapshot }
  | { readonly kind: 'absent'; readonly sourcePath: string; readonly path: string };

interface ValidatedDatabaseSnapshot {
  readonly artifacts: ArtifactRecord[];
  readonly sessionIds: string[];
}

export async function createOperationalStateBackup(
  input: CreateOperationalBackupInput,
): Promise<OperationalBackupManifest> {
  const stateRoot = await canonicalizeExistingDirectory(input.stateRoot, 'state');
  const destinationRoot = await canonicalizeMissingPath(input.destinationRoot, 'destination');
  assertRootsDoNotOverlap(stateRoot, destinationRoot);
  await assertPathMissing(destinationRoot, 'Operational backup destination');

  return withArtifactWriterLock(stateRoot, async (lockedRoot) => {
    if (lockedRoot !== stateRoot) {
      throw new OperationalBackupError('invalid_root', 'Operational backup state root changed');
    }
    const stagingRoot = `${destinationRoot}.staging-${randomUUID()}`;
    const metadata = createSqliteArtifactMetadataRepository(stateRoot);
    const database = acquireOperationalStateDatabase(stateRoot);
    try {
      await assertPathMissing(stagingRoot, 'Operational backup staging destination');
      await metadata.ready();
      const artifactRecords = metadata.readAll();
      const transcriptSnapshots = await snapshotSessionTranscripts(stateRoot);
      const artifactSnapshots = await snapshotArtifactPayloads(stateRoot, artifactRecords);
      const legacyAutomationSnapshot = await snapshotOptionalSourceFile(
        stateRoot,
        LEGACY_AUTOMATION_FILE,
      );
      if (legacyAutomationSnapshot.kind === 'present') {
        await validateLegacyAutomationSourceSnapshot(legacyAutomationSnapshot.snapshot);
      }

      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      const databasePath = resolve(stagingRoot, OPERATIONAL_STATE_DATABASE_NAME);
      await database.backup(databasePath);
      normalizeStandaloneSqliteSnapshot(databasePath);
      await chmod(databasePath, 0o600);
      await syncFile(databasePath);
      await input.failpoint?.('after_database_snapshot');

      const validated = await validateDatabaseSnapshot(
        databasePath,
        OPERATIONAL_BACKUP_SCHEMA_VERSION,
      );
      assertSameArtifactRecords(
        validated.artifacts,
        artifactRecords,
        'source changed during backup',
        'source_changed',
      );
      assertSameStringSet(
        validated.sessionIds,
        transcriptSnapshots.map((snapshot) => snapshot.sessionId),
        'SQLite sessions do not match transcript files',
        'source_changed',
      );

      const transcripts = await copyTranscriptSnapshots(stagingRoot, transcriptSnapshots);
      const artifacts = await copyArtifactSnapshots(
        stagingRoot,
        artifactSnapshots,
        artifactRecords,
      );
      const legacyAutomation = await copyOptionalSourceSnapshot(
        stagingRoot,
        legacyAutomationSnapshot,
      );
      assertSameArtifactRecords(
        metadata.readAll(),
        artifactRecords,
        'source changed during backup',
        'source_changed',
      );
      await input.failpoint?.('after_payload_copy');

      const createdAt = (input.now ?? Date.now)();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new OperationalBackupError('invalid_manifest', 'Operational backup time is invalid');
      }
      const manifest: CurrentOperationalBackupManifest = {
        format: OPERATIONAL_BACKUP_FORMAT,
        schemaVersion: OPERATIONAL_BACKUP_SCHEMA_VERSION,
        createdAt,
        database: await describeBackupFile(databasePath, OPERATIONAL_STATE_DATABASE_NAME),
        transcripts,
        artifacts,
        legacyAutomation,
      };
      const manifestPath = resolve(stagingRoot, OPERATIONAL_BACKUP_MANIFEST_FILE);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await syncFile(manifestPath);
      await input.failpoint?.('after_manifest_write');

      await validateOperationalStateBackup(stagingRoot);
      await syncDirectoryChain(stagingRoot, stagingRoot);
      await rename(stagingRoot, destinationRoot);
      await syncDirectory(dirname(destinationRoot));
      return manifest;
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    } finally {
      database.close();
      metadata.close();
    }
  });
}

export async function validateOperationalStateBackup(
  backupRootInput: string,
): Promise<OperationalBackupManifest> {
  const backupRoot = await canonicalizeExistingDirectory(backupRootInput, 'backup');
  const manifestPath = resolve(backupRoot, OPERATIONAL_BACKUP_MANIFEST_FILE);
  const manifest = await readOperationalBackupManifest(manifestPath);
  await assertBackupTreeExactlyMatchesManifest(backupRoot, manifest);
  await validateManifestFiles(backupRoot, manifest);
  const validated = await validateDatabaseSnapshot(
    resolve(backupRoot, manifest.database.path),
    manifest.schemaVersion,
  );
  assertSameArtifactRecords(
    validated.artifacts,
    manifest.artifacts.map((artifact) => artifact.record),
    'Artifact manifest does not match runtime.sqlite',
    'corrupt_backup',
  );
  assertSameStringSet(
    validated.sessionIds,
    manifest.transcripts.map((transcript) => transcript.sessionId),
    'Transcript manifest does not match runtime.sqlite',
    'corrupt_backup',
  );
  return manifest;
}

export async function restoreOperationalStateBackup(
  input: RestoreOperationalBackupInput,
): Promise<OperationalBackupManifest> {
  const backupRoot = await canonicalizeExistingDirectory(input.backupRoot, 'backup');
  const destinationRoot = await canonicalizeMissingPath(input.destinationRoot, 'destination');
  assertRootsDoNotOverlap(backupRoot, destinationRoot);
  await assertPathMissing(destinationRoot, 'Operational restore destination');
  const manifest = await validateOperationalStateBackup(backupRoot);
  const stagingRoot = `${destinationRoot}.staging-${randomUUID()}`;
  try {
    await assertPathMissing(stagingRoot, 'Operational restore staging destination');
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    for (const file of manifestFiles(manifest)) {
      const sourcePath = resolveBackupPath(backupRoot, file.path);
      const destinationPath = resolveBackupPath(stagingRoot, file.path);
      await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
      await copyFile(sourcePath, destinationPath);
      await chmod(destinationPath, 0o600);
      await syncFile(destinationPath);
      await syncDirectoryChain(dirname(destinationPath), stagingRoot);
    }
    await input.failpoint?.('after_restore_copy');
    await validateManifestFiles(stagingRoot, manifest);
    const validated = await validateDatabaseSnapshot(
      resolve(stagingRoot, manifest.database.path),
      manifest.schemaVersion,
    );
    assertSameArtifactRecords(
      validated.artifacts,
      manifest.artifacts.map((artifact) => artifact.record),
      'Restored Artifact rows do not match the backup manifest',
      'corrupt_backup',
    );
    assertSameStringSet(
      validated.sessionIds,
      manifest.transcripts.map((transcript) => transcript.sessionId),
      'Restored sessions do not match the backup manifest',
      'corrupt_backup',
    );
    await syncDirectoryChain(stagingRoot, stagingRoot);
    await rename(stagingRoot, destinationRoot);
    await syncDirectory(dirname(destinationRoot));
    return manifest;
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function snapshotSessionTranscripts(stateRoot: string): Promise<SourceTranscriptSnapshot[]> {
  const sessionsRoot = resolve(stateRoot, 'sessions');
  let entries;
  try {
    entries = await readdir(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  await assertRegularDirectory(sessionsRoot, stateRoot, 'sessions');
  const snapshots: SourceTranscriptSnapshot[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!isSafeEntityId(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) {
      throw new OperationalBackupError(
        'invalid_root',
        `Operational backup found an invalid sessions entry: sessions/${entry.name}`,
      );
    }
    const sessionRoot = resolve(sessionsRoot, entry.name);
    await assertRegularDirectory(sessionRoot, stateRoot, `sessions/${entry.name}`);
    const relativePath = `sessions/${entry.name}/session.jsonl`;
    const sourcePath = resolve(sessionRoot, 'session.jsonl');
    const snapshot = {
      sessionId: entry.name,
      ...(await snapshotSourceFile(sourcePath, stateRoot, relativePath)),
    };
    await validateTranscriptFile(sourcePath, entry.name);
    snapshots.push(snapshot);
  }
  return snapshots;
}

async function snapshotOptionalSourceFile(
  stateRoot: string,
  relativePath: string,
): Promise<OptionalSourceFileSnapshot> {
  const sourcePath = resolve(stateRoot, relativePath);
  try {
    await lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'absent', sourcePath, path: relativePath };
    }
    throw error;
  }
  return {
    kind: 'present',
    snapshot: await snapshotSourceFile(sourcePath, stateRoot, relativePath),
  };
}

async function snapshotArtifactPayloads(
  stateRoot: string,
  records: readonly ArtifactRecord[],
): Promise<SourceFileSnapshot[]> {
  const artifactRoot = resolve(stateRoot, 'artifacts');
  const expectedPaths = new Set(records.map((record) => record.relativePath));
  let rootEntries;
  try {
    rootEntries = await readdir(artifactRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && records.length === 0) return [];
    throw new OperationalBackupError(
      'invalid_root',
      'Operational backup Artifact root is missing',
      {
        cause: error,
      },
    );
  }
  await assertRegularDirectory(artifactRoot, stateRoot, 'artifacts');
  const foundPaths = new Set<string>();
  for (const entry of rootEntries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relativeRootPath = `artifacts/${entry.name}`;
    if (entry.isSymbolicLink()) throw invalidSourceEntry(relativeRootPath);
    if (entry.name === 'metadata.jsonl') {
      await assertRegularFile(resolve(artifactRoot, entry.name), stateRoot, relativeRootPath);
      continue;
    }
    if (
      entry.name === ARTIFACT_PURGE_INTENT_FILE ||
      isCanonicalArtifactRecoveryTempName(entry.name)
    ) {
      throw new OperationalBackupError(
        'source_changed',
        `Artifact authority recovery is required before backup: ${relativeRootPath}`,
      );
    }
    if (!entry.isDirectory() || !isSafeEntityId(entry.name)) {
      throw invalidSourceEntry(relativeRootPath);
    }
    const sessionRoot = resolve(artifactRoot, entry.name);
    await assertRegularDirectory(sessionRoot, stateRoot, relativeRootPath);
    for (const child of await readdir(sessionRoot, { withFileTypes: true })) {
      const relativePath = `${entry.name}/${child.name}`;
      const backupPath = `artifacts/${relativePath}`;
      if (child.isSymbolicLink()) throw invalidSourceEntry(backupPath);
      if (ARTIFACT_PUBLICATION_STAGING_PATTERN.test(child.name)) {
        throw new OperationalBackupError(
          'source_changed',
          `Artifact authority recovery is required before backup: ${backupPath}`,
        );
      }
      if (!child.isFile() || !expectedPaths.has(relativePath)) {
        throw invalidSourceEntry(backupPath);
      }
      await assertRegularFile(resolve(sessionRoot, child.name), stateRoot, backupPath);
      foundPaths.add(relativePath);
    }
  }
  for (const record of records) {
    if (!foundPaths.has(record.relativePath)) {
      throw new OperationalBackupError(
        'invalid_root',
        `Artifact payload is missing: artifacts/${record.relativePath}`,
      );
    }
  }
  const snapshots: SourceFileSnapshot[] = [];
  for (const record of records) {
    const snapshot = await snapshotSourceFile(
      resolve(artifactRoot, record.relativePath),
      stateRoot,
      `artifacts/${record.relativePath}`,
    );
    if (snapshot.sizeBytes !== record.sizeBytes) {
      throw new OperationalBackupError(
        'corrupt_backup',
        `Artifact payload size does not match metadata: artifacts/${record.relativePath}`,
      );
    }
    snapshots.push(snapshot);
  }
  return snapshots;
}

async function copyTranscriptSnapshots(
  stagingRoot: string,
  snapshots: readonly SourceTranscriptSnapshot[],
): Promise<OperationalBackupTranscript[]> {
  const copied: OperationalBackupTranscript[] = [];
  for (const snapshot of snapshots) {
    await copySourceSnapshot(stagingRoot, snapshot);
    copied.push({
      sessionId: snapshot.sessionId,
      path: snapshot.path,
      sizeBytes: snapshot.sizeBytes,
      sha256: snapshot.sha256,
    });
  }
  return copied;
}

async function copyArtifactSnapshots(
  stagingRoot: string,
  snapshots: readonly SourceFileSnapshot[],
  records: readonly ArtifactRecord[],
): Promise<OperationalBackupArtifact[]> {
  const copied: OperationalBackupArtifact[] = [];
  for (const [index, snapshot] of snapshots.entries()) {
    const record = records[index];
    if (!record || snapshot.path !== `artifacts/${record.relativePath}`) {
      throw new OperationalBackupError('source_changed', 'Artifact snapshot order changed');
    }
    await copySourceSnapshot(stagingRoot, snapshot);
    copied.push({
      record,
      path: snapshot.path,
      sizeBytes: snapshot.sizeBytes,
      sha256: snapshot.sha256,
    });
  }
  return copied;
}

async function copyOptionalSourceSnapshot(
  stagingRoot: string,
  optional: OptionalSourceFileSnapshot,
): Promise<OperationalBackupFile | null> {
  if (optional.kind === 'absent') {
    await assertOptionalSourceStillAbsent(optional);
    return null;
  }
  const { snapshot } = optional;
  await copySourceSnapshot(stagingRoot, snapshot);
  return {
    path: snapshot.path,
    sizeBytes: snapshot.sizeBytes,
    sha256: snapshot.sha256,
  };
}

async function assertOptionalSourceStillAbsent(
  snapshot: Extract<OptionalSourceFileSnapshot, { readonly kind: 'absent' }>,
): Promise<void> {
  try {
    await lstat(snapshot.sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw new OperationalBackupError(
      'source_changed',
      `Operational backup source changed during copy: ${snapshot.path}`,
      { cause: error },
    );
  }
  throw new OperationalBackupError(
    'source_changed',
    `Operational backup source changed during copy: ${snapshot.path}`,
  );
}

async function copySourceSnapshot(
  stagingRoot: string,
  snapshot: SourceFileSnapshot,
): Promise<void> {
  const destinationPath = resolveBackupPath(stagingRoot, snapshot.path);
  await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
  await copyFile(snapshot.sourcePath, destinationPath);
  await chmod(destinationPath, 0o600);
  const current = await snapshotSourceFile(
    snapshot.sourcePath,
    dirname(snapshot.sourcePath),
    basename(snapshot.sourcePath),
  );
  if (
    current.dev !== snapshot.dev ||
    current.ino !== snapshot.ino ||
    current.mtimeNs !== snapshot.mtimeNs ||
    current.ctimeNs !== snapshot.ctimeNs ||
    current.sizeBytes !== snapshot.sizeBytes ||
    current.sha256 !== snapshot.sha256
  ) {
    throw new OperationalBackupError(
      'source_changed',
      `Operational backup source changed during copy: ${snapshot.path}`,
    );
  }
  const destination = await describeBackupFile(destinationPath, snapshot.path);
  if (destination.sizeBytes !== snapshot.sizeBytes || destination.sha256 !== snapshot.sha256) {
    throw new OperationalBackupError(
      'corrupt_backup',
      `Operational backup copy failed validation: ${snapshot.path}`,
    );
  }
  await syncFile(destinationPath);
  await syncDirectoryChain(dirname(destinationPath), stagingRoot);
}

async function snapshotSourceFile(
  path: string,
  root: string,
  relativePath: string,
): Promise<SourceFileSnapshot> {
  await assertRegularFile(path, root, relativePath);
  const metadata = await lstat(path, { bigint: true });
  const descriptor = await describeBackupFile(path, relativePath);
  return {
    ...descriptor,
    sourcePath: path,
    dev: metadata.dev,
    ino: metadata.ino,
    mtimeNs: metadata.mtimeNs,
    ctimeNs: metadata.ctimeNs,
  };
}

async function describeBackupFile(
  path: string,
  relativePath: string,
): Promise<OperationalBackupFile> {
  const metadata = await stat(path);
  if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size < 0) {
    throw new OperationalBackupError('corrupt_backup', `Backup file is invalid: ${relativePath}`);
  }
  return {
    path: relativePath,
    sizeBytes: metadata.size,
    sha256: await hashFile(path),
  };
}

async function hashFile(path: string): Promise<`sha256:${string}`> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return `sha256:${hash.digest('hex')}`;
}

async function validateDatabaseSnapshot(
  path: string,
  backupSchemaVersion: OperationalBackupManifest['schemaVersion'],
): Promise<ValidatedDatabaseSnapshot> {
  const metadata = await lstat(path).catch((error: unknown) => {
    throw new OperationalBackupError('corrupt_backup', 'Backup runtime.sqlite is missing', {
      cause: error,
    });
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new OperationalBackupError('corrupt_backup', 'Backup runtime.sqlite is not a file');
  }
  const Database = loadDatabaseSync();
  let database: DatabaseSync;
  try {
    database = new Database(path, { readOnly: true });
  } catch (error) {
    throw new OperationalBackupError('corrupt_backup', 'Unable to open backup runtime.sqlite', {
      cause: error,
    });
  }
  try {
    database.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON; BEGIN');
    const integrity = database.prepare('PRAGMA integrity_check').all() as Array<{
      integrity_check?: unknown;
    }>;
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new OperationalBackupError('corrupt_backup', 'Backup SQLite integrity check failed');
    }
    const foreignKeys = database.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length > 0) {
      throw new OperationalBackupError('corrupt_backup', 'Backup SQLite foreign keys are invalid');
    }
    validateOperationalSchemaVersions(database, backupSchemaVersion);
    if (!sqliteTableExists(database, 'artifact_records')) {
      throw new OperationalBackupError('corrupt_backup', 'Backup is missing artifact_records');
    }
    if (!sqliteTableExists(database, 'session_metadata')) {
      throw new OperationalBackupError('corrupt_backup', 'Backup is missing session_metadata');
    }
    const artifactRows = database
      .prepare(`
        SELECT artifact_id, session_id, created_at, status, relative_path, record_json
        FROM artifact_records
        ORDER BY created_at, storage_key
      `)
      .all() as Array<{
      artifact_id?: unknown;
      session_id?: unknown;
      created_at?: unknown;
      status?: unknown;
      relative_path?: unknown;
      record_json?: unknown;
    }>;
    if (artifactRows.some((row) => typeof row.record_json !== 'string')) {
      throw new OperationalBackupError('corrupt_backup', 'Backup Artifact row is invalid');
    }
    let artifacts: ArtifactRecord[];
    try {
      const text = artifactRows.map((row) => row.record_json as string).join('\n');
      artifacts = decodeArtifactMetadata(text ? `${text}\n` : '');
    } catch (error) {
      throw new OperationalBackupError('corrupt_backup', 'Backup Artifact metadata is invalid', {
        cause: error,
      });
    }
    for (const [index, record] of artifacts.entries()) {
      const row = artifactRows[index];
      if (
        row?.artifact_id !== record.id ||
        row.session_id !== record.sessionId ||
        row.created_at !== record.createdAt ||
        row.status !== record.status ||
        row.relative_path !== record.relativePath
      ) {
        throw new OperationalBackupError(
          'corrupt_backup',
          `Backup Artifact indexes do not match record ${record.id}`,
        );
      }
    }
    const sessionRows = database
      .prepare('SELECT session_id FROM session_metadata ORDER BY session_id')
      .all() as Array<{ session_id?: unknown }>;
    if (sessionRows.some((row) => typeof row.session_id !== 'string')) {
      throw new OperationalBackupError('corrupt_backup', 'Backup session metadata is invalid');
    }
    return {
      artifacts,
      sessionIds: sessionRows.map((row) => row.session_id as string),
    };
  } catch (error) {
    if (error instanceof OperationalBackupError) throw error;
    throw new OperationalBackupError('corrupt_backup', 'Unable to validate backup runtime.sqlite', {
      cause: error,
    });
  } finally {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the validation error.
    }
    database.close();
  }
}

function normalizeStandaloneSqliteSnapshot(path: string): void {
  const Database = loadDatabaseSync();
  const database = new Database(path);
  try {
    const row = database.prepare('PRAGMA journal_mode = DELETE').get() as
      | { journal_mode?: unknown }
      | undefined;
    if (row?.journal_mode !== 'delete') {
      throw new OperationalBackupError(
        'corrupt_backup',
        'Unable to make the SQLite backup self-contained',
      );
    }
  } finally {
    database.close();
  }
}

function validateOperationalSchemaVersions(
  database: DatabaseSync,
  backupSchemaVersion: OperationalBackupManifest['schemaVersion'],
): void {
  if (!sqliteTableExists(database, 'operational_schema_migrations')) {
    throw new OperationalBackupError('corrupt_backup', 'Backup is missing schema migrations');
  }
  const rows = database
    .prepare('SELECT scope, version FROM operational_schema_migrations ORDER BY scope')
    .all() as Array<{ scope?: unknown; version?: unknown }>;
  const actual = new Map<string, number>();
  for (const row of rows) {
    if (
      typeof row.scope !== 'string' ||
      typeof row.version !== 'number' ||
      !Number.isSafeInteger(row.version) ||
      row.version < 0
    ) {
      throw new OperationalBackupError('corrupt_backup', 'Backup schema registry is invalid');
    }
    actual.set(row.scope, row.version);
  }
  for (const [scope, supported] of supportedSchemaVersions) {
    const version = actual.get(scope);
    if (version === undefined) {
      if (
        scope === 'automation' &&
        backupSchemaVersion === LEGACY_OPERATIONAL_BACKUP_SCHEMA_VERSION
      ) {
        continue;
      }
      throw new OperationalBackupError('corrupt_backup', `Backup schema is missing ${scope}`);
    }
    if (version > supported) {
      throw new OperationalBackupError(
        'unsupported_schema',
        `Backup schema ${scope} version ${version} is newer than supported ${supported}`,
      );
    }
    if (version !== supported) {
      throw new OperationalBackupError(
        'unsupported_schema',
        `Backup schema ${scope} version ${version} requires migration before restore`,
      );
    }
  }
  for (const scope of actual.keys()) {
    if (!supportedSchemaVersions.has(scope)) {
      throw new OperationalBackupError(
        'unsupported_schema',
        `Backup contains an unknown schema scope: ${scope}`,
      );
    }
  }
}

async function readOperationalBackupManifest(path: string): Promise<OperationalBackupManifest> {
  const metadata = await lstat(path).catch((error: unknown) => {
    throw new OperationalBackupError('invalid_manifest', 'Operational backup manifest is missing', {
      cause: error,
    });
  });
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_MANIFEST_BYTES) {
    throw new OperationalBackupError('invalid_manifest', 'Operational backup manifest is invalid');
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new OperationalBackupError('invalid_manifest', 'Operational backup manifest is invalid', {
      cause: error,
    });
  }
  return decodeOperationalBackupManifest(value);
}

function decodeOperationalBackupManifest(value: unknown): OperationalBackupManifest {
  if (!isRecord(value)) throw invalidManifest();
  const legacy = value.schemaVersion === LEGACY_OPERATIONAL_BACKUP_SCHEMA_VERSION;
  const current = value.schemaVersion === OPERATIONAL_BACKUP_SCHEMA_VERSION;
  const commonKeys = [
    'format',
    'schemaVersion',
    'createdAt',
    'database',
    'transcripts',
    'artifacts',
  ];
  if (!legacy && !current) throw invalidManifest();
  if (!hasExactKeys(value, current ? [...commonKeys, 'legacyAutomation'] : commonKeys)) {
    throw invalidManifest();
  }
  if (
    value.format !== OPERATIONAL_BACKUP_FORMAT ||
    typeof value.createdAt !== 'number' ||
    !Number.isSafeInteger(value.createdAt) ||
    value.createdAt < 0 ||
    !Array.isArray(value.transcripts) ||
    !Array.isArray(value.artifacts)
  ) {
    throw invalidManifest();
  }
  const database = decodeBackupFile(value.database);
  if (database.path !== OPERATIONAL_STATE_DATABASE_NAME) throw invalidManifest();
  const transcripts = value.transcripts.map((entry) => decodeTranscript(entry));
  const artifacts = value.artifacts.map((entry) => decodeArtifact(entry));
  const legacyAutomation = current
    ? value.legacyAutomation === null
      ? null
      : decodeBackupFile(value.legacyAutomation)
    : undefined;
  if (legacyAutomation && legacyAutomation.path !== LEGACY_AUTOMATION_FILE) {
    throw invalidManifest();
  }
  assertUniqueManifestPaths([
    database,
    ...transcripts,
    ...artifacts,
    ...(legacyAutomation ? [legacyAutomation] : []),
  ]);
  assertUniqueValues(
    transcripts.map((entry) => entry.sessionId),
    'session id',
  );
  assertUniqueValues(
    artifacts.map((entry) => entry.record.id),
    'Artifact id',
  );
  const common: OperationalBackupManifestBase = {
    format: OPERATIONAL_BACKUP_FORMAT,
    createdAt: value.createdAt,
    database,
    transcripts,
    artifacts,
  };
  return current
    ? {
        ...common,
        schemaVersion: OPERATIONAL_BACKUP_SCHEMA_VERSION,
        legacyAutomation: legacyAutomation ?? null,
      }
    : {
        ...common,
        schemaVersion: LEGACY_OPERATIONAL_BACKUP_SCHEMA_VERSION,
      };
}

function decodeBackupFile(value: unknown): OperationalBackupFile {
  if (!isRecord(value) || !hasExactKeys(value, ['path', 'sizeBytes', 'sha256'])) {
    throw invalidManifest();
  }
  if (
    typeof value.path !== 'string' ||
    !isSafeBackupPath(value.path) ||
    typeof value.sizeBytes !== 'number' ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 0 ||
    typeof value.sha256 !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(value.sha256)
  ) {
    throw invalidManifest();
  }
  return value as unknown as OperationalBackupFile;
}

function decodeTranscript(value: unknown): OperationalBackupTranscript {
  if (!isRecord(value) || !hasExactKeys(value, ['sessionId', 'path', 'sizeBytes', 'sha256'])) {
    throw invalidManifest();
  }
  const file = decodeBackupFile({
    path: value.path,
    sizeBytes: value.sizeBytes,
    sha256: value.sha256,
  });
  if (
    typeof value.sessionId !== 'string' ||
    !isSafeEntityId(value.sessionId) ||
    file.path !== `sessions/${value.sessionId}/session.jsonl`
  ) {
    throw invalidManifest();
  }
  return { sessionId: value.sessionId, ...file };
}

function decodeArtifact(value: unknown): OperationalBackupArtifact {
  if (!isRecord(value) || !hasExactKeys(value, ['record', 'path', 'sizeBytes', 'sha256'])) {
    throw invalidManifest();
  }
  const file = decodeBackupFile({
    path: value.path,
    sizeBytes: value.sizeBytes,
    sha256: value.sha256,
  });
  let records: ArtifactRecord[];
  try {
    records = decodeArtifactMetadata(`${JSON.stringify(value.record)}\n`);
  } catch (error) {
    throw new OperationalBackupError('invalid_manifest', 'Artifact manifest record is invalid', {
      cause: error,
    });
  }
  const record = records[0];
  if (
    !record ||
    file.path !== `artifacts/${record.relativePath}` ||
    file.sizeBytes !== record.sizeBytes
  ) {
    throw invalidManifest();
  }
  return { record, ...file };
}

async function assertBackupTreeExactlyMatchesManifest(
  backupRoot: string,
  manifest: OperationalBackupManifest,
): Promise<void> {
  const expected = new Set([
    OPERATIONAL_BACKUP_MANIFEST_FILE,
    ...manifestFiles(manifest).map((file) => file.path),
  ]);
  const expectedDirectories = manifestDirectories(expected);
  const actual = await listBackupTree(backupRoot);
  if (
    actual.files.length !== expected.size ||
    actual.files.some((path) => !expected.has(path)) ||
    actual.directories.length !== expectedDirectories.size ||
    actual.directories.some((path) => !expectedDirectories.has(path))
  ) {
    throw new OperationalBackupError(
      'corrupt_backup',
      `Operational backup contains missing or unmanifested entries: ${[
        ...actual.directories,
        ...actual.files,
      ].join(', ')}`,
    );
  }
}

async function validateManifestFiles(
  root: string,
  manifest: OperationalBackupManifest,
): Promise<void> {
  for (const file of manifestFiles(manifest)) {
    const path = resolveBackupPath(root, file.path);
    const actual = await describeBackupFile(path, file.path).catch((error: unknown) => {
      throw new OperationalBackupError('corrupt_backup', `Backup file is missing: ${file.path}`, {
        cause: error,
      });
    });
    if (actual.sizeBytes !== file.sizeBytes || actual.sha256 !== file.sha256) {
      throw new OperationalBackupError(
        'corrupt_backup',
        `Backup file digest does not match manifest: ${file.path}`,
      );
    }
  }
  for (const transcript of manifest.transcripts) {
    await validateTranscriptFile(resolveBackupPath(root, transcript.path), transcript.sessionId);
  }
  if (manifest.schemaVersion === OPERATIONAL_BACKUP_SCHEMA_VERSION && manifest.legacyAutomation) {
    await validateLegacyAutomationBackupFile(
      resolveBackupPath(root, manifest.legacyAutomation.path),
    );
  }
}

async function validateLegacyAutomationSourceSnapshot(snapshot: SourceFileSnapshot): Promise<void> {
  const contents = await readFile(snapshot.sourcePath);
  const sha256 = `sha256:${createHash('sha256').update(contents).digest('hex')}`;
  if (contents.byteLength !== snapshot.sizeBytes || sha256 !== snapshot.sha256) {
    throw new OperationalBackupError(
      'source_changed',
      `Operational backup source changed during validation: ${snapshot.path}`,
    );
  }
  try {
    decodeLegacyAutomationFile(contents.toString('utf8'));
  } catch (error) {
    throw new OperationalBackupError(
      'corrupt_backup',
      'Legacy Automation source cannot be backed up',
      { cause: error },
    );
  }
}

async function validateLegacyAutomationBackupFile(path: string): Promise<void> {
  try {
    decodeLegacyAutomationFile(await readFile(path, 'utf8'));
  } catch (error) {
    throw new OperationalBackupError(
      'corrupt_backup',
      'Legacy Automation backup payload cannot be restored',
      { cause: error },
    );
  }
}

async function validateTranscriptFile(path: string, sessionId: string): Promise<void> {
  const text = await readFile(path, 'utf8');
  const lines = text
    .split('\n')
    .map((line, index) => ({ line, lineNumber: index + 1 }))
    .filter((entry) => entry.line.trim().length > 0);
  if (lines.length === 0 || !lines[0]) {
    throw new OperationalBackupError('corrupt_backup', `Session ${sessionId} transcript is empty`);
  }
  try {
    const first = JSON.parse(lines[0].line) as unknown;
    if (isSessionTranscriptMarker(first)) decodeSessionTranscriptMarker(first, sessionId);
    else decodeSessionHeader(first, sessionId);
    for (const entry of lines.slice(1)) {
      decodeStoredMessageForRecovery(JSON.parse(entry.line) as unknown);
    }
  } catch (error) {
    throw new OperationalBackupError(
      'corrupt_backup',
      `Session ${sessionId} transcript cannot be restored`,
      { cause: error },
    );
  }
}

function manifestFiles(manifest: OperationalBackupManifest): OperationalBackupFile[] {
  return [
    manifest.database,
    ...manifest.transcripts,
    ...manifest.artifacts,
    ...(manifest.schemaVersion === OPERATIONAL_BACKUP_SCHEMA_VERSION && manifest.legacyAutomation
      ? [manifest.legacyAutomation]
      : []),
  ];
}

async function listBackupTree(
  root: string,
  current = root,
): Promise<{ files: string[]; directories: string[] }> {
  const files: string[] = [];
  const directories: string[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = resolve(current, entry.name);
    const relativePath = relative(root, path).split(sep).join('/');
    if (entry.isSymbolicLink()) {
      throw new OperationalBackupError(
        'corrupt_backup',
        `Backup contains symlink: ${relativePath}`,
      );
    }
    if (entry.isDirectory()) {
      directories.push(relativePath);
      const child = await listBackupTree(root, path);
      files.push(...child.files);
      directories.push(...child.directories);
    } else if (entry.isFile()) files.push(relativePath);
    else {
      throw new OperationalBackupError(
        'corrupt_backup',
        `Backup contains special file: ${relativePath}`,
      );
    }
  }
  return {
    files: files.sort((left, right) => left.localeCompare(right)),
    directories: directories.sort((left, right) => left.localeCompare(right)),
  };
}

function manifestDirectories(files: ReadonlySet<string>): Set<string> {
  const directories = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      directories.add(parts.slice(0, index).join('/'));
    }
  }
  return directories;
}

async function assertRegularFile(path: string, root: string, relativePath: string): Promise<void> {
  const metadata = await lstat(path).catch((error: unknown) => {
    throw new OperationalBackupError('invalid_root', `Required file is missing: ${relativePath}`, {
      cause: error,
    });
  });
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw invalidSourceEntry(relativePath);
  await assertCanonicalPathInside(path, root, relativePath);
}

async function assertRegularDirectory(
  path: string,
  root: string,
  relativePath: string,
): Promise<void> {
  const metadata = await lstat(path).catch((error: unknown) => {
    throw new OperationalBackupError(
      'invalid_root',
      `Required directory is missing: ${relativePath}`,
      { cause: error },
    );
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw invalidSourceEntry(relativePath);
  await assertCanonicalPathInside(path, root, relativePath);
}

async function assertCanonicalPathInside(path: string, root: string, role: string): Promise<void> {
  const canonical = await realpath(path);
  if (!pathIsAtOrInside(root, canonical)) {
    throw new OperationalBackupError('invalid_root', `Path escapes state root: ${role}`);
  }
}

async function canonicalizeExistingDirectory(path: string, role: string): Promise<string> {
  const requested = resolve(path);
  const metadata = await lstat(requested).catch((error: unknown) => {
    throw new OperationalBackupError('invalid_root', `Operational ${role} root does not exist`, {
      cause: error,
    });
  });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new OperationalBackupError('invalid_root', `Operational ${role} root is invalid`);
  }
  return realpath(requested);
}

async function canonicalizeMissingPath(path: string, role: string): Promise<string> {
  const requested = resolve(path);
  let candidate = requested;
  const suffix: string[] = [];
  while (true) {
    try {
      const metadata = await lstat(candidate);
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
        throw new OperationalBackupError(
          'invalid_root',
          `Operational ${role} parent is invalid: ${candidate}`,
        );
      }
      return resolve(await realpath(candidate), ...suffix.reverse());
    } catch (error) {
      if (error instanceof OperationalBackupError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(candidate);
      if (parent === candidate) {
        throw new OperationalBackupError('invalid_root', `Operational ${role} path is invalid`);
      }
      suffix.push(basename(candidate));
      candidate = parent;
    }
  }
}

async function assertPathMissing(path: string, role: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  throw new OperationalBackupError('destination_exists', `${role} already exists: ${path}`);
}

function assertRootsDoNotOverlap(left: string, right: string): void {
  if (pathIsAtOrInside(left, right) || pathIsAtOrInside(right, left)) {
    throw new OperationalBackupError(
      'overlapping_roots',
      `Operational backup roots overlap: ${left} and ${right}`,
    );
  }
}

function resolveBackupPath(root: string, relativePath: string): string {
  if (!isSafeBackupPath(relativePath)) throw invalidManifest();
  const path = resolve(root, ...relativePath.split('/'));
  if (!pathIsAtOrInside(root, path)) throw invalidManifest();
  return path;
}

function isSafeBackupPath(path: string): boolean {
  if (!path || isAbsolute(path) || path.includes('\\') || path.includes('\0')) return false;
  const parts = path.split('/');
  return parts.every((part) => part.length > 0 && part !== '.' && part !== '..');
}

function pathIsAtOrInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function isSafeEntityId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function sqliteTableExists(database: DatabaseSync, table: string): boolean {
  return (
    database.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(table) !==
    undefined
  );
}

function assertSameArtifactRecords(
  left: readonly ArtifactRecord[],
  right: readonly ArtifactRecord[],
  message: string,
  code: OperationalBackupErrorCode,
): void {
  const canonical = (records: readonly ArtifactRecord[]) =>
    records.map((record) => JSON.stringify(record)).sort((a, b) => a.localeCompare(b));
  const leftRecords = canonical(left);
  const rightRecords = canonical(right);
  if (
    leftRecords.length !== rightRecords.length ||
    leftRecords.some((record, index) => record !== rightRecords[index])
  ) {
    throw new OperationalBackupError(code, message);
  }
}

function assertSameStringSet(
  left: readonly string[],
  right: readonly string[],
  message: string,
  code: OperationalBackupErrorCode,
): void {
  const leftValues = [...left].sort((a, b) => a.localeCompare(b));
  const rightValues = [...right].sort((a, b) => a.localeCompare(b));
  if (
    leftValues.length !== rightValues.length ||
    leftValues.some((value, index) => value !== rightValues[index])
  ) {
    throw new OperationalBackupError(code, message);
  }
}

function assertUniqueManifestPaths(files: readonly OperationalBackupFile[]): void {
  assertUniqueValues(
    files.map((file) => file.path),
    'file path',
  );
}

function assertUniqueValues(values: readonly string[], role: string): void {
  if (new Set(values).size !== values.length) {
    throw new OperationalBackupError('invalid_manifest', `Duplicate backup ${role}`);
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort((a, b) => a.localeCompare(b));
  const canonicalExpected = [...expected].sort((a, b) => a.localeCompare(b));
  return (
    keys.length === canonicalExpected.length &&
    keys.every((key, index) => key === canonicalExpected[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidManifest(): OperationalBackupError {
  return new OperationalBackupError('invalid_manifest', 'Operational backup manifest is invalid');
}

function invalidSourceEntry(path: string): OperationalBackupError {
  return new OperationalBackupError('invalid_root', `Invalid operational backup source: ${path}`);
}

function loadDatabaseSync(): typeof import('node:sqlite').DatabaseSync {
  return (require('node:sqlite') as typeof import('node:sqlite')).DatabaseSync;
}
