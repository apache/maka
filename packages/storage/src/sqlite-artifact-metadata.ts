import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ArtifactRecord } from '@maka/core/artifacts';
import type { ArtifactMetadataRepository } from './artifact-metadata-repository.js';
import { decodeArtifactMetadata } from './artifact-metadata-codec.js';
import {
  acquireOperationalStateDatabase,
  completeOperationalStoreCutover,
  type OperationalStateDatabaseLease,
  type OperationalStoreCutoverFailpoint,
} from './operational-state-store.js';

export interface CreateSqliteArtifactMetadataOptions {
  readonly failpoint?: (point: OperationalStoreCutoverFailpoint) => void;
}

export function artifactMetadataSourceFingerprint(source: string | undefined): string {
  return `sha256:${createHash('sha256')
    .update(source === undefined ? 'missing' : source)
    .digest('hex')}`;
}

export function createSqliteArtifactMetadataRepository(
  workspaceRoot: string,
  options: CreateSqliteArtifactMetadataOptions = {},
): ArtifactMetadataRepository {
  return new SqliteArtifactMetadataRepository(workspaceRoot, options.failpoint);
}

class SqliteArtifactMetadataRepository implements ArtifactMetadataRepository {
  readonly #root: string;
  readonly #lease: OperationalStateDatabaseLease;
  readonly #failpoint?: (point: OperationalStoreCutoverFailpoint) => void;
  #ready: Promise<void> | undefined;
  #closed = false;

  constructor(
    workspaceRoot: string,
    failpoint?: (point: OperationalStoreCutoverFailpoint) => void,
  ) {
    this.#root = resolve(workspaceRoot);
    this.#lease = acquireOperationalStateDatabase(this.#root);
    this.#failpoint = failpoint;
  }

  ready(): Promise<void> {
    this.assertOpen();
    this.#ready ??= importLegacyArtifactMetadata(this.#root, this.#lease, this.#failpoint);
    return this.#ready;
  }

  readAll(): ArtifactRecord[] {
    this.assertOpen();
    const rows = this.#lease.database
      .prepare(`
        SELECT record_json
        FROM artifact_records
        ORDER BY created_at, storage_key
      `)
      .all() as Array<{ record_json: string }>;
    return decodeRows(rows);
  }

  replaceAll(records: readonly ArtifactRecord[]): void {
    this.assertOpen();
    this.#lease.transaction('write', () => {
      this.#lease.database.prepare('DELETE FROM artifact_records').run();
      const insert = this.#lease.database.prepare(`
        INSERT INTO artifact_records(
          storage_key,
          artifact_id,
          session_id,
          created_at,
          status,
          relative_path,
          record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const record of records) {
        insert.run(
          artifactIdentityKey(record.id),
          record.id,
          record.sessionId,
          record.createdAt,
          record.status,
          record.relativePath,
          JSON.stringify(record),
        );
      }
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#lease.close();
  }

  private assertOpen(): void {
    if (this.#closed) throw new Error('Artifact metadata repository is closed');
  }
}

async function importLegacyArtifactMetadata(
  root: string,
  lease: OperationalStateDatabaseLease,
  failpoint?: (point: OperationalStoreCutoverFailpoint) => void,
): Promise<void> {
  const sourcePath = join(root, 'artifacts', 'metadata.jsonl');
  const source = await readOptionalText(sourcePath);
  const records = source === undefined ? [] : decodeArtifactMetadata(source);
  const fingerprint = artifactMetadataSourceFingerprint(source);
  completeOperationalStoreCutover(lease, {
    storeName: 'artifact_metadata',
    sourcePath,
    sourceFingerprint: fingerprint,
    failpoint,
    importAndValidate: (database) => {
      const insert = database.prepare(`
        INSERT INTO artifact_records(
          storage_key,
          artifact_id,
          session_id,
          created_at,
          status,
          relative_path,
          record_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(storage_key) DO UPDATE SET
          artifact_id = excluded.artifact_id,
          session_id = excluded.session_id,
          created_at = excluded.created_at,
          status = excluded.status,
          relative_path = excluded.relative_path,
          record_json = excluded.record_json
      `);
      for (const record of records) {
        insert.run(
          artifactIdentityKey(record.id),
          record.id,
          record.sessionId,
          record.createdAt,
          record.status,
          record.relativePath,
          JSON.stringify(record),
        );
      }
      const persisted = database
        .prepare('SELECT record_json FROM artifact_records ORDER BY created_at, storage_key')
        .all() as Array<{ record_json: string }>;
      const decoded = decodeRows(persisted);
      if (decoded.length !== records.length || !sameRecordSet(decoded, records)) {
        throw new Error('Artifact metadata cutover validation failed');
      }
      return { records: records.length };
    },
  });
}

function decodeRows(rows: readonly { record_json: string }[]): ArtifactRecord[] {
  const text = rows.map((row) => row.record_json).join('\n');
  return decodeArtifactMetadata(text ? `${text}\n` : '');
}

function sameRecordSet(left: readonly ArtifactRecord[], right: readonly ArtifactRecord[]): boolean {
  const canonical = (records: readonly ArtifactRecord[]) =>
    [...records].map((record) => JSON.stringify(record)).sort((a, b) => a.localeCompare(b));
  const leftRecords = canonical(left);
  const rightRecords = canonical(right);
  return leftRecords.every((record, index) => record === rightRecords[index]);
}

function artifactIdentityKey(id: string): string {
  return createHash('sha256').update(JSON.stringify(id)).digest('hex');
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
