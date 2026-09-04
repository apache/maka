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

export const SQLITE_ARTIFACT_SCHEMA_VERSION = 3;

export function migrateSqliteArtifactDatabase(db: DatabaseSync): void {
  const columns = db.prepare('PRAGMA table_info(artifact_records)').all() as Array<{
    name?: unknown;
  }>;
  if (columns.some(({ name }) => name === 'status' || name === 'storage_key')) {
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
  `);
}
