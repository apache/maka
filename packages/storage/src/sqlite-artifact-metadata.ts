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

import { resolve } from 'node:path';
import type {
  ImageDeliveryIdentity,
  ImageDeliveryAttempt,
  ImageDeliveryResult,
} from '@maka/core/image-delivery';
import {
  readImageDeliveryAttempt,
  writeImageDeliveryAttempt,
  removeImageDeliveryAttempt,
  readImageDeliveryAttempts,
  type StoredImageDeliveryAttempt,
} from './sqlite-image-delivery.js';
import type { ArtifactRecord } from '@maka/core/artifacts';
import { decodeArtifactRecordJsons } from './artifact-metadata-codec.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

export interface ArtifactMetadataChanges {
  readonly upserts?: readonly ArtifactRecord[];
  readonly deleteIds?: readonly string[];
}

export function createSqliteArtifactMetadataRepository(workspaceRoot: string) {
  return new SqliteArtifactMetadataRepository(workspaceRoot);
}

class SqliteArtifactMetadataRepository {
  readonly #lease: OperationalStateDatabaseLease;
  #closed = false;

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(resolve(workspaceRoot));
  }

  findImageDelivery(
    sessionId: string,
    turnId: string,
    messageId: string,
    source: string,
  ): ImageDeliveryResult | undefined {
    this.assertOpen();
    const rows = this.#lease.database
      .prepare(`
      SELECT record_json FROM artifact_records
      WHERE session_id = ? AND json_valid(record_json)
        AND json_type(record_json, '$.imageDelivery') = 'object'
        AND json_extract(record_json, '$.turnId') = ?
        AND json_extract(record_json, '$.imageDelivery.messageId') = ?
        AND json_extract(record_json, '$.imageDelivery.source') = ?
        AND json_extract(record_json, '$.imageDelivery.status') = 'ready'
      ORDER BY created_at DESC, artifact_id DESC LIMIT 1
    `)
      .all(sessionId, turnId, messageId, source) as Array<{ record_json: string }>;
    const record = decodeRows(rows)[0];
    if (record?.imageDelivery?.status === 'ready')
      return { status: 'ready', artifactId: record.id };
    return readImageDeliveryAttempt(this.#lease.database, { sessionId, turnId, messageId, source });
  }

  setImageDeliveryAttempt(identity: ImageDeliveryIdentity, attempt: ImageDeliveryAttempt): void {
    this.assertOpen();
    this.#lease.transaction('write', () => {
      // Saved history is immutable, including when a retry races publication.
      if (
        this.findImageDelivery(
          identity.sessionId,
          identity.turnId,
          identity.messageId,
          identity.source,
        )?.status === 'ready'
      )
        return;
      writeImageDeliveryAttempt(this.#lease.database, identity, attempt);
    });
  }

  readImageDeliveryAttempts(
    sessionId: string,
    turnIds: readonly string[],
  ): StoredImageDeliveryAttempt[] {
    this.assertOpen();
    return readImageDeliveryAttempts(this.#lease.database, sessionId, turnIds);
  }

  copyImageDeliveryAttempts(
    attempts: readonly StoredImageDeliveryAttempt[],
    targetSessionId: string,
  ): void {
    this.assertOpen();
    this.#lease.transaction('write', () => {
      for (const record of attempts) {
        const identity = { ...record.identity, sessionId: targetSessionId };
        if (
          !this.findImageDelivery(
            identity.sessionId,
            identity.turnId,
            identity.messageId,
            identity.source,
          )
        )
          writeImageDeliveryAttempt(
            this.#lease.database,
            identity,
            record.attempt,
            record.createdAt,
          );
      }
    });
  }

  purgeImageDeliveryAttempts(sessionId: string): void {
    this.assertOpen();
    this.#lease.transaction('write', () => {
      this.#lease.database
        .prepare('DELETE FROM image_delivery_attempts WHERE session_id = ?')
        .run(sessionId);
    });
  }

  readAll(): ArtifactRecord[] {
    this.assertOpen();
    const rows = this.#lease.database
      .prepare(`
        SELECT record_json
        FROM artifact_records
        ORDER BY created_at, artifact_id
      `)
      .all() as Array<{ record_json: string }>;
    return decodeRows(rows);
  }

  applyChanges(changes: ArtifactMetadataChanges): void {
    this.assertOpen();
    this.#lease.transaction('write', () => {
      const remove = this.#lease.database.prepare(
        'DELETE FROM artifact_records WHERE artifact_id = ?',
      );
      for (const id of changes.deleteIds ?? []) remove.run(id);

      const upsert = this.#lease.database.prepare(`
        INSERT INTO artifact_records(
          artifact_id,
          session_id,
          created_at,
          relative_path,
          record_json
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(artifact_id) DO UPDATE SET
          session_id = excluded.session_id,
          created_at = excluded.created_at,
          relative_path = excluded.relative_path,
          record_json = excluded.record_json
        WHERE session_id IS NOT excluded.session_id
           OR created_at IS NOT excluded.created_at
           OR relative_path IS NOT excluded.relative_path
           OR record_json IS NOT excluded.record_json
      `);
      for (const record of changes.upserts ?? []) {
        if (record.imageDelivery?.status === 'ready')
          removeImageDeliveryAttempt(this.#lease.database, {
            sessionId: record.sessionId,
            turnId: record.turnId,
            messageId: record.imageDelivery.messageId,
            source: record.imageDelivery.source,
          });
        upsert.run(
          record.id,
          record.sessionId,
          record.createdAt,
          record.relativePath,
          JSON.stringify(record),
        );
      }
    });
  }

  readUpgradeOrphanPaths(after: string, limit: number): string[] {
    this.assertOpen();
    const rows = this.#lease.database
      .prepare(`SELECT relative_path FROM artifact_upgrade_orphan_paths
        WHERE relative_path > ? ORDER BY relative_path LIMIT ?`)
      .all(after, limit) as Array<{ relative_path: string }>;
    return rows.map((row) => row.relative_path);
  }

  hasRelativePath(relativePath: string): boolean {
    this.assertOpen();
    return Boolean(
      this.#lease.database
        .prepare('SELECT 1 FROM artifact_records WHERE relative_path = ?')
        .get(relativePath),
    );
  }

  readRelativePathsByCaseFoldedArtifactIds(artifactIds: readonly string[]): string[] {
    this.assertOpen();
    if (artifactIds.length === 0) return [];
    const placeholders = artifactIds.map(() => '?').join(', ');
    const rows = this.#lease.database
      .prepare(
        `SELECT relative_path FROM artifact_records
          WHERE artifact_id COLLATE NOCASE IN (${placeholders})`,
      )
      .all(...artifactIds) as Array<{ relative_path: string }>;
    return rows.map((row) => row.relative_path);
  }

  forgetUpgradeOrphanPaths(relativePaths: readonly string[]): void {
    this.assertOpen();
    this.#lease.transaction('write', () => {
      const forget = this.#lease.database.prepare(
        'DELETE FROM artifact_upgrade_orphan_paths WHERE relative_path = ?',
      );
      for (const relativePath of relativePaths) forget.run(relativePath);
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

function decodeRows(rows: readonly { record_json: string }[]): ArtifactRecord[] {
  return decodeArtifactRecordJsons(rows.map((row) => row.record_json));
}
