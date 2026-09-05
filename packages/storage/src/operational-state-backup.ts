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
import { createReadStream, lstatSync } from 'node:fs';
import {
  chmod,
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
import { decodeArtifactRecordJsons } from './artifact-metadata-codec.js';
import { withArtifactWriterLock } from './artifact-writer-lock.js';
import { decodeStoredMessage } from './execution-record-codec.js';
import {
  acquireOperationalStateDatabase,
  inspectOperationalStateSchema,
  OPERATIONAL_STATE_DATABASE_NAME,
} from './operational-state-store.js';
import { assertCurrentOperationalTargetSchema } from './operational-target-schema.js';
import {
  SQLITE_SESSION_MESSAGE_CHUNK_BYTES,
  SQLITE_SESSION_MESSAGE_CHUNK_MARKER,
} from './sqlite-session-metadata-schema.js';
import { syncDirectory, syncDirectoryChain, syncFile } from './stable-storage.js';

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
      await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
      const database = acquireOperationalStateDatabase(canonicalStateRoot);
      const databasePath = resolve(stagingRoot, OPERATIONAL_STATE_DATABASE_NAME);
      try {
        await database.backup(databasePath);
      } finally {
        database.close();
      }
      normalizeStandaloneSqliteSnapshot(databasePath);
      await chmod(databasePath, 0o600);
      await syncFile(databasePath);
      const artifactRoot = resolve(canonicalStateRoot, 'artifacts');
      if (await pathExists(artifactRoot)) {
        await copyRegularTree(
          artifactRoot,
          resolve(stagingRoot, 'artifacts'),
          artifactRoot,
          stagingRoot,
        );
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
      const manifestPath = resolve(stagingRoot, OPERATIONAL_BACKUP_MANIFEST_FILE);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await syncFile(manifestPath);
      await validateOperationalStateBackup(stagingRoot);
      await syncDirectoryChain(stagingRoot, stagingRoot);
      await mkdir(dirname(destinationRoot), { recursive: true });
      await rename(stagingRoot, destinationRoot);
      await syncDirectory(dirname(destinationRoot));
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
  validateSqlite(resolve(root, OPERATIONAL_STATE_DATABASE_NAME), manifest.files);
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
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    for (const file of manifest.files) {
      const source = resolveInside(backupRoot, file.path);
      const destination = resolveInside(stagingRoot, file.path);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(source, destination);
      await chmod(destination, 0o600);
      await syncFile(destination);
      await syncDirectoryChain(dirname(destination), stagingRoot);
    }
    const actual = await inventory(stagingRoot);
    if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) {
      throw new OperationalBackupError('corrupt_backup', 'Restored file inventory does not match');
    }
    validateSqlite(resolve(stagingRoot, OPERATIONAL_STATE_DATABASE_NAME), manifest.files);
    await syncDirectoryChain(stagingRoot, stagingRoot);
    await mkdir(dirname(destinationRoot), { recursive: true });
    await rename(stagingRoot, destinationRoot);
    await syncDirectory(dirname(destinationRoot));
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

async function copyRegularTree(
  source: string,
  destination: string,
  root: string,
  destinationRoot: string,
): Promise<void> {
  const metadata = await lstat(source);
  if (metadata.isSymbolicLink()) {
    throw new OperationalBackupError('invalid_root', 'Artifact tree cannot contain symlinks');
  }
  if (metadata.isDirectory()) {
    await mkdir(destination, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(source)) {
      await copyRegularTree(
        resolve(source, entry),
        resolve(destination, entry),
        root,
        destinationRoot,
      );
    }
    return;
  }
  if (!metadata.isFile()) {
    throw new OperationalBackupError('invalid_root', 'Artifact tree contains a non-regular file');
  }
  resolveInside(root, relative(root, source));
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await copyFile(source, destination);
  await chmod(destination, 0o600);
  await syncFile(destination);
  await syncDirectoryChain(dirname(destination), destinationRoot);
}

function validateSqlite(path: string, files: readonly OperationalBackupFile[]): void {
  try {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error('runtime.sqlite is not a regular file');
    }
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      database.exec('PRAGMA query_only = ON; PRAGMA foreign_keys = ON; BEGIN');
      const integrity = database.prepare('PRAGMA integrity_check').all() as Array<{
        integrity_check?: unknown;
      }>;
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error('integrity_check failed');
      }
      if (database.prepare('PRAGMA foreign_key_check').all().length > 0) {
        throw new Error('foreign_key_check failed');
      }
      if (inspectOperationalStateSchema(database).status !== 'current') {
        throw new Error('operational schema versions do not match');
      }

      assertCurrentOperationalTargetSchema(database);

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
      const artifacts = decodeArtifactRecordJsons(artifactRows.map((row) => row.record_json));
      const filesByPath = new Map(files.map((file) => [file.path, file]));
      for (const [index, record] of artifacts.entries()) {
        const row = artifactRows[index];
        if (
          row?.artifact_id !== record.id ||
          row.session_id !== record.sessionId ||
          row.created_at !== record.createdAt ||
          row.status !== record.status ||
          row.relative_path !== record.relativePath
        ) {
          throw new Error(`artifact indexes do not match record: ${record.id}`);
        }
        const payload = filesByPath.get(`artifacts/${record.relativePath}`);
        if (!payload || payload.size !== record.sizeBytes) {
          throw new Error(`artifact payload does not match metadata: ${record.id}`);
        }
      }

      const messageRows = database
        .prepare(`
          SELECT message.session_id, message.sequence, message.message_id,
            message.message_type, message.message_ts, message.record_json,
            payload.record_bytes, payload.sha256
          FROM session_messages AS message
          LEFT JOIN session_message_payloads AS payload
            ON payload.session_id = message.session_id AND payload.sequence = message.sequence
          ORDER BY message.session_id, message.sequence
        `)
        .all() as Array<{
        session_id?: unknown;
        sequence?: unknown;
        message_id?: unknown;
        message_type?: unknown;
        message_ts?: unknown;
        record_json?: unknown;
        record_bytes?: unknown;
        sha256?: unknown;
      }>;
      const readMessageChunks = database.prepare(`
        SELECT chunk_index, data, sha256
        FROM session_message_chunks
        WHERE session_id = ? AND sequence = ?
        ORDER BY chunk_index
      `);
      for (const row of messageRows) {
        if (
          typeof row.session_id !== 'string' ||
          !Number.isSafeInteger(row.sequence) ||
          (row.sequence as number) < 0 ||
          typeof row.record_json !== 'string' ||
          (row.record_bytes !== null && !Number.isSafeInteger(row.record_bytes))
        ) {
          throw new Error('session message index is invalid');
        }
        const chunks = readMessageChunks.all(row.session_id, row.sequence as number) as Array<{
          chunk_index?: unknown;
          data?: unknown;
          sha256?: unknown;
        }>;
        const chunked = row.record_bytes !== null;
        let encoded: Buffer;
        if (chunked) {
          if (
            row.record_json !== SQLITE_SESSION_MESSAGE_CHUNK_MARKER ||
            !Number.isSafeInteger(row.record_bytes) ||
            (row.record_bytes as number) <= SQLITE_SESSION_MESSAGE_CHUNK_BYTES ||
            typeof row.sha256 !== 'string'
          ) {
            throw new Error('session message payload is invalid');
          }
          if (
            chunks.some(
              (chunk, index) =>
                chunk.chunk_index !== index ||
                !(chunk.data instanceof Uint8Array) ||
                typeof chunk.sha256 !== 'string' ||
                chunk.sha256 !== createHash('sha256').update(chunk.data).digest('hex'),
            )
          ) {
            throw new Error('session message chunks do not match payload');
          }
          encoded = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.data as Uint8Array)));
          if (
            encoded.byteLength !== row.record_bytes ||
            createHash('sha256').update(encoded).digest('hex') !== row.sha256
          ) {
            throw new Error('session message chunks do not match payload');
          }
        } else {
          if (row.record_json === SQLITE_SESSION_MESSAGE_CHUNK_MARKER || chunks.length !== 0) {
            throw new Error('session message payload is invalid');
          }
          encoded = Buffer.from(row.record_json, 'utf8');
        }
        const expectedChunks = chunked
          ? Math.ceil(encoded.byteLength / SQLITE_SESSION_MESSAGE_CHUNK_BYTES)
          : 0;
        if (chunks.length !== expectedChunks) {
          throw new Error('session message chunks do not match payload');
        }
        const message = decodeStoredMessage(JSON.parse(encoded.toString('utf8')));
        if (
          message.id !== row.message_id ||
          message.type !== row.message_type ||
          message.ts !== row.message_ts
        ) {
          throw new Error(`session message indexes do not match record: ${message.id}`);
        }
      }
    } finally {
      try {
        database.exec('ROLLBACK');
      } catch {
        // Preserve the validation error.
      }
      database.close();
    }
  } catch (error) {
    // The reason has to reach the message: validation covers integrity,
    // foreign keys, schema versions, target schema, Artifact payload
    // reconciliation and message decoding, and a bare "is invalid" leaves an
    // operator with no way to tell those apart in a log that dropped `cause`.
    const reason = error instanceof Error ? error.message : String(error);
    throw new OperationalBackupError(
      'corrupt_backup',
      `Backup runtime.sqlite is invalid: ${reason}`,
      { cause: error },
    );
  }
}

function normalizeStandaloneSqliteSnapshot(path: string): void {
  const database = new DatabaseSync(path);
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
