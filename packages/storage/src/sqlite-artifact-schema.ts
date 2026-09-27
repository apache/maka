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

export const SQLITE_ARTIFACT_SCHEMA_VERSION = 4;

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
  migrateSessionRevisions(db);
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

function migrateSessionRevisions(db: DatabaseSync): void {
  const existing = db
    .prepare(
      "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'artifact_session_revisions'",
    )
    .get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_session_revisions (
      session_id TEXT PRIMARY KEY,
      revision_token TEXT NOT NULL CHECK (
        length(revision_token) = 64 AND revision_token NOT GLOB '*[^0-9a-f]*'
      )
    );
  `);
  if (!existing) {
    // One-time v3 -> v4 backfill reads the covering Session index, not record_json.
    // The enclosing operational migration commits the state and triggers together.
    db.exec(`
      INSERT INTO artifact_session_revisions(session_id, revision_token)
      SELECT session_id, lower(hex(randomblob(32))) FROM artifact_records GROUP BY session_id;
    `);
  }
  // SQLite owns invalidation, including writes made by another connection/process.
  // Each changed row touches at most two Session keys. No Session scan or hash is
  // moved onto the mutation path. The empty-Session check stops at the first index entry.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS artifact_revision_after_insert
    AFTER INSERT ON artifact_records
    BEGIN
      INSERT INTO artifact_session_revisions(session_id, revision_token)
      VALUES (NEW.session_id, lower(hex(randomblob(32))))
      ON CONFLICT(session_id) DO UPDATE SET revision_token = excluded.revision_token;
    END;

    CREATE TRIGGER IF NOT EXISTS artifact_revision_after_update
    AFTER UPDATE ON artifact_records
    WHEN OLD.artifact_id IS NOT NEW.artifact_id
      OR OLD.session_id IS NOT NEW.session_id
      OR OLD.created_at IS NOT NEW.created_at
      OR OLD.relative_path IS NOT NEW.relative_path
      OR OLD.record_json IS NOT NEW.record_json
    BEGIN
      UPDATE artifact_session_revisions SET revision_token = lower(hex(randomblob(32)))
      WHERE session_id = OLD.session_id AND OLD.session_id IS NOT NEW.session_id;
      INSERT INTO artifact_session_revisions(session_id, revision_token)
      VALUES (NEW.session_id, lower(hex(randomblob(32))))
      ON CONFLICT(session_id) DO UPDATE SET revision_token = excluded.revision_token;
      DELETE FROM artifact_session_revisions
      WHERE session_id = OLD.session_id
        AND NOT EXISTS (SELECT 1 FROM artifact_records WHERE session_id = OLD.session_id LIMIT 1);
    END;

    CREATE TRIGGER IF NOT EXISTS artifact_revision_after_delete
    AFTER DELETE ON artifact_records
    BEGIN
      UPDATE artifact_session_revisions SET revision_token = lower(hex(randomblob(32)))
      WHERE session_id = OLD.session_id;
      DELETE FROM artifact_session_revisions
      WHERE session_id = OLD.session_id
        AND NOT EXISTS (SELECT 1 FROM artifact_records WHERE session_id = OLD.session_id LIMIT 1);
    END;
  `);
}
