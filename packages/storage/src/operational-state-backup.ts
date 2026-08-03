import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { withArtifactWriterLock } from './artifact-writer-lock.js';
import {
  acquireOperationalStateDatabase,
  OPERATIONAL_STATE_DATABASE_NAME,
  OPERATIONAL_STATE_SCHEMA_VERSION,
} from './operational-state-store.js';
import { SQLITE_ARTIFACT_SCHEMA_VERSION } from './sqlite-artifact-schema.js';
import { SQLITE_AUTOMATION_SCHEMA_VERSION } from './sqlite-automation-schema.js';
import { SQLITE_CORE_EXECUTION_SCHEMA_VERSION } from './sqlite-core-execution-schema.js';
import { SQLITE_RUNTIME_SCHEMA_VERSION } from './sqlite-runtime-schema.js';
import { SQLITE_SESSION_METADATA_SCHEMA_VERSION } from './sqlite-session-metadata-schema.js';
import { SQLITE_USAGE_SCHEMA_VERSION } from './sqlite-usage-schema.js';
import { SQLITE_WORKFLOW_SCHEMA_VERSION } from './sqlite-workflow-schema.js';

export const OPERATIONAL_BACKUP_FORMAT = 'maka-operational-backup';
export const OPERATIONAL_BACKUP_SCHEMA_VERSION = 3 as const;
export const OPERATIONAL_BACKUP_MANIFEST_FILE = 'operational-backup.json';

export type OperationalBackupErrorCode =
  | 'invalid_root'
  | 'overlapping_roots'
  | 'destination_not_empty'
  | 'unsupported_schema'
  | 'corrupt_backup';

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

export interface OperationalBackupFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: `sha256:${string}`;
}

export interface OperationalBackupManifest {
  readonly format: typeof OPERATIONAL_BACKUP_FORMAT;
  readonly schemaVersion: typeof OPERATIONAL_BACKUP_SCHEMA_VERSION;
  readonly createdAt: number;
  readonly files: readonly OperationalBackupFile[];
}

export interface CreateOperationalBackupInput {
  readonly stateRoot: string;
  readonly destinationRoot: string;
  readonly now?: () => number;
}

export interface RestoreOperationalBackupInput {
  readonly backupRoot: string;
  readonly destinationRoot: string;
}

export async function createOperationalStateBackup(
  input: CreateOperationalBackupInput,
): Promise<OperationalBackupManifest> {
  const stateRoot = resolve(input.stateRoot);
  const destinationRoot = resolve(input.destinationRoot);
  assertSeparateRoots(stateRoot, destinationRoot);
  await assertMissing(destinationRoot, 'backup destination');
  return withArtifactWriterLock(stateRoot, async (canonicalStateRoot) => {
    assertSeparateRoots(canonicalStateRoot, destinationRoot);
    const stagingRoot = `${destinationRoot}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await mkdir(stagingRoot, { recursive: true });
      const database = acquireOperationalStateDatabase(canonicalStateRoot);
      try {
        await database.backup(resolve(stagingRoot, OPERATIONAL_STATE_DATABASE_NAME));
      } finally {
        database.close();
      }
      const artifactRoot = resolve(canonicalStateRoot, 'artifacts');
      if (await pathExists(artifactRoot)) {
        await copyRegularTree(artifactRoot, resolve(stagingRoot, 'artifacts'), artifactRoot);
      }
      const createdAt = (input.now ?? Date.now)();
      if (!Number.isSafeInteger(createdAt) || createdAt < 0) {
        throw new OperationalBackupError('corrupt_backup', 'Backup creation time is invalid');
      }
      const manifest: OperationalBackupManifest = {
        format: OPERATIONAL_BACKUP_FORMAT,
        schemaVersion: OPERATIONAL_BACKUP_SCHEMA_VERSION,
        createdAt,
        files: await inventory(stagingRoot),
      };
      await writeFile(
        resolve(stagingRoot, OPERATIONAL_BACKUP_MANIFEST_FILE),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );
      await mkdir(dirname(destinationRoot), { recursive: true });
      await rename(stagingRoot, destinationRoot);
      return manifest;
    } catch (error) {
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
  });
}

export async function validateOperationalStateBackup(
  backupRoot: string,
): Promise<OperationalBackupManifest> {
  const root = resolve(backupRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(resolve(root, OPERATIONAL_BACKUP_MANIFEST_FILE), 'utf8'));
  } catch (error) {
    throw new OperationalBackupError('corrupt_backup', 'Backup manifest is missing or invalid', {
      cause: error,
    });
  }
  const manifest = decodeManifest(parsed);
  const actual = await inventory(root);
  if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
    throw new OperationalBackupError('corrupt_backup', 'Backup file inventory does not match');
  }
  validateSqlite(resolve(root, OPERATIONAL_STATE_DATABASE_NAME));
  return manifest;
}

export async function restoreOperationalStateBackup(
  input: RestoreOperationalBackupInput,
): Promise<OperationalBackupManifest> {
  const backupRoot = resolve(input.backupRoot);
  const destinationRoot = resolve(input.destinationRoot);
  assertSeparateRoots(backupRoot, destinationRoot);
  await assertMissing(destinationRoot, 'restore destination');
  const manifest = await validateOperationalStateBackup(backupRoot);
  const stagingRoot = `${destinationRoot}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(stagingRoot, { recursive: true });
    for (const file of manifest.files) {
      const source = resolveInside(backupRoot, file.path);
      const destination = resolveInside(stagingRoot, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
    }
    await mkdir(dirname(destinationRoot), { recursive: true });
    await rename(stagingRoot, destinationRoot);
    return manifest;
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function decodeManifest(value: unknown): OperationalBackupManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OperationalBackupError('corrupt_backup', 'Backup manifest must be an object');
  }
  const record = value as Record<string, unknown>;
  if (record.format !== OPERATIONAL_BACKUP_FORMAT) {
    throw new OperationalBackupError('corrupt_backup', 'Backup format is invalid');
  }
  if (record.schemaVersion !== OPERATIONAL_BACKUP_SCHEMA_VERSION) {
    throw new OperationalBackupError('unsupported_schema', 'Backup schema is unsupported');
  }
  if (
    !Number.isSafeInteger(record.createdAt) ||
    (record.createdAt as number) < 0 ||
    !Array.isArray(record.files)
  ) {
    throw new OperationalBackupError('corrupt_backup', 'Backup manifest fields are invalid');
  }
  const files = record.files.map((value): OperationalBackupFile => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new OperationalBackupError('corrupt_backup', 'Backup file entry is invalid');
    }
    const file = value as Record<string, unknown>;
    if (
      typeof file.path !== 'string' ||
      file.path === OPERATIONAL_BACKUP_MANIFEST_FILE ||
      !Number.isSafeInteger(file.size) ||
      (file.size as number) < 0 ||
      typeof file.sha256 !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new OperationalBackupError('corrupt_backup', 'Backup file entry is invalid');
    }
    resolveInside('/backup-root', file.path);
    return file as unknown as OperationalBackupFile;
  });
  if (!files.some((file) => file.path === OPERATIONAL_STATE_DATABASE_NAME)) {
    throw new OperationalBackupError('corrupt_backup', 'Backup runtime.sqlite is missing');
  }
  return {
    format: OPERATIONAL_BACKUP_FORMAT,
    schemaVersion: OPERATIONAL_BACKUP_SCHEMA_VERSION,
    createdAt: record.createdAt as number,
    files,
  };
}

async function inventory(root: string): Promise<OperationalBackupFile[]> {
  const result: OperationalBackupFile[] = [];
  await walk(root, root, result);
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function walk(root: string, current: string, result: OperationalBackupFile[]): Promise<void> {
  for (const entry of (await readdir(current, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.name === OPERATIONAL_BACKUP_MANIFEST_FILE) continue;
    if (
      entry.name === `${OPERATIONAL_STATE_DATABASE_NAME}-shm` ||
      entry.name === `${OPERATIONAL_STATE_DATABASE_NAME}-wal`
    ) {
      continue;
    }
    const path = resolve(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new OperationalBackupError('corrupt_backup', 'Backup cannot contain symlinks');
    }
    if (entry.isDirectory()) {
      await walk(root, path, result);
      continue;
    }
    if (!entry.isFile()) {
      throw new OperationalBackupError('corrupt_backup', 'Backup contains a non-regular file');
    }
    result.push(await describeFile(root, path));
  }
}

async function describeFile(root: string, path: string): Promise<OperationalBackupFile> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    size += bytes.byteLength;
    hash.update(bytes);
  }
  return {
    path: relative(root, path).split('\\').join('/'),
    size,
    sha256: `sha256:${hash.digest('hex')}`,
  };
}

async function copyRegularTree(source: string, destination: string, root: string): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) {
    throw new OperationalBackupError('invalid_root', 'Artifact tree cannot contain symlinks');
  }
  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) {
      await copyRegularTree(resolve(source, entry), resolve(destination, entry), root);
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new OperationalBackupError('invalid_root', 'Artifact tree contains a non-regular file');
  }
  resolveInside(root, relative(root, source));
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

function validateSqlite(path: string): void {
  try {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const row = database.prepare('PRAGMA quick_check').get() as { quick_check?: unknown };
      if (row.quick_check !== 'ok') throw new Error('quick_check failed');
      const expected = new Map<string, number>([
        ['runtime', SQLITE_RUNTIME_SCHEMA_VERSION],
        ['session_metadata', SQLITE_SESSION_METADATA_SCHEMA_VERSION],
        ['core_execution', SQLITE_CORE_EXECUTION_SCHEMA_VERSION],
        ['workflow', SQLITE_WORKFLOW_SCHEMA_VERSION],
        ['usage', SQLITE_USAGE_SCHEMA_VERSION],
        ['artifact', SQLITE_ARTIFACT_SCHEMA_VERSION],
        ['automation', SQLITE_AUTOMATION_SCHEMA_VERSION],
        ['operational', OPERATIONAL_STATE_SCHEMA_VERSION],
      ]);
      const rows = database
        .prepare('SELECT scope, version FROM operational_schema_migrations')
        .all() as Array<{ scope?: unknown; version?: unknown }>;
      if (
        rows.length !== expected.size ||
        rows.some(
          (entry) => typeof entry.scope !== 'string' || expected.get(entry.scope) !== entry.version,
        )
      ) {
        throw new Error('operational schema versions do not match');
      }
    } finally {
      database.close();
    }
  } catch (error) {
    throw new OperationalBackupError('corrupt_backup', 'Backup runtime.sqlite is invalid', {
      cause: error,
    });
  }
}

function resolveInside(root: string, path: string): string {
  const candidate = resolve(root, path);
  const rel = relative(root, candidate);
  if (rel === '' || rel.startsWith('..') || rel.includes(':')) {
    throw new OperationalBackupError('corrupt_backup', `Unsafe backup path: ${path}`);
  }
  return candidate;
}

function assertSeparateRoots(left: string, right: string): void {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  if (
    left === right ||
    (!leftToRight.startsWith('..') && !leftToRight.includes(':')) ||
    (!rightToLeft.startsWith('..') && !rightToLeft.includes(':'))
  ) {
    throw new OperationalBackupError('overlapping_roots', 'Backup roots must not overlap');
  }
}

async function assertMissing(path: string, label: string): Promise<void> {
  if (await pathExists(path)) {
    throw new OperationalBackupError('destination_not_empty', `${label} already exists: ${path}`);
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
