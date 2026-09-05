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

import type { DatabaseSync } from 'node:sqlite';
import {
  decodeArtifactRecordJsons,
  isSafeRelativeArtifactPath,
} from './artifact-metadata-codec.js';

export const SQLITE_ARTIFACT_SCHEMA_VERSION = 3;

export function migrateSqliteArtifactDatabase(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(artifact_records)').all() as Array<{
    name?: unknown;
  }>;
  const retained: string[] = [];
  // Every path the old table named. Whatever is not carried over is a file no
  // catalog will name again, and this is the last moment anything knows it is
  // there. Unlinking here is not an option: a rollback after one would be
  // unrecoverable, so the paths are recorded for the store to reclaim later.
  const scanned: string[] = [];
  const hasStatusColumn = columns.some(({ name }) => name === 'status');
  if (hasStatusColumn || columns.some(({ name }) => name === 'storage_key')) {
    const rows = db.prepare('SELECT * FROM artifact_records').all();
    for (const row of rows) {
      if (typeof row.relative_path === 'string' && isSafeRelativeArtifactPath(row.relative_path)) {
        scanned.push(row.relative_path);
      }
      try {
        const parsed = JSON.parse(String(row.record_json));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        if (
          parsed.id !== row.artifact_id ||
          parsed.sessionId !== row.session_id ||
          parsed.createdAt !== row.created_at ||
          parsed.relativePath !== row.relative_path
        )
          continue;
        if (
          [hasStatusColumn ? row.status : undefined, parsed.status].some(
            (value) => value !== undefined && value !== null && value !== 'live',
          )
        )
          continue;
        delete parsed.status;
        retained.push(JSON.stringify(parsed));
      } catch {}
    }
    db.exec('DROP TABLE artifact_records');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_records (
      artifact_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      relative_path TEXT NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS artifact_records_session_order
      ON artifact_records(session_id, created_at, artifact_id);

    CREATE UNIQUE INDEX IF NOT EXISTS artifact_records_relative_path
      ON artifact_records(relative_path);

    CREATE TABLE IF NOT EXISTS artifact_upgrade_orphan_paths (
      relative_path TEXT PRIMARY KEY
    );
  `);
  const carried = decodeArtifactRecordJsons(retained);
  const kept = new Set(carried.map((record) => record.relativePath));
  const orphan = db.prepare(`
    INSERT INTO artifact_upgrade_orphan_paths VALUES (?)
    ON CONFLICT(relative_path) DO NOTHING
  `);
  for (const relativePath of scanned) if (!kept.has(relativePath)) orphan.run(relativePath);
  const insert = db.prepare(`
    INSERT INTO artifact_records VALUES (?, ?, ?, ?, ?)
  `);
  for (const record of carried) {
    insert.run(
      record.id,
      record.sessionId,
      record.createdAt,
      record.relativePath,
      JSON.stringify(record),
    );
  }
}
