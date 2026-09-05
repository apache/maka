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

  readUpgradeOrphanPaths(): string[] {
    this.assertOpen();
    const rows = this.#lease.database
      .prepare('SELECT relative_path FROM artifact_upgrade_orphan_paths ORDER BY relative_path')
      .all() as Array<{ relative_path: string }>;
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
