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

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { ArtifactRecord } from '@maka/core/artifacts';
import type { ArtifactMetadataRepository } from './artifact-metadata-repository.js';
import { decodeArtifactRecordJsons } from './artifact-metadata-codec.js';
import {
  acquireOperationalStateDatabase,
  type OperationalStateDatabaseLease,
} from './operational-state-store.js';

export function createSqliteArtifactMetadataRepository(
  workspaceRoot: string,
): ArtifactMetadataRepository {
  return new SqliteArtifactMetadataRepository(workspaceRoot);
}

class SqliteArtifactMetadataRepository implements ArtifactMetadataRepository {
  readonly #lease: OperationalStateDatabaseLease;
  #closed = false;

  constructor(workspaceRoot: string) {
    this.#lease = acquireOperationalStateDatabase(resolve(workspaceRoot));
  }

  ready(): Promise<void> {
    this.assertOpen();
    return Promise.resolve();
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

function decodeRows(rows: readonly { record_json: string }[]): ArtifactRecord[] {
  return decodeArtifactRecordJsons(rows.map((row) => row.record_json));
}

function artifactIdentityKey(id: string): string {
  return createHash('sha256').update(JSON.stringify(id)).digest('hex');
}
