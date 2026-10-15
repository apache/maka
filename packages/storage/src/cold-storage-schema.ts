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
  RUNTIME_COMPRESSIBLE_KINDS,
  RUNTIME_PAYLOAD_PREFIX,
  RUNTIME_PAYLOAD_MAX_BYTES,
} from './runtime-payload-codec.js';

export const COLD_STORAGE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const COLD_STORAGE_DEFAULT_WRITER_ENABLED = 1;
const WRITE_TIME = "CAST(unixepoch('subsec') * 1000 AS INTEGER)";

/** Built-in SQL time also covers importers and secondary processes, in the content transaction. */
export function migrateColdStorageDatabase(db: DatabaseSync, now: number): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_content_activity (
      session_id TEXT PRIMARY KEY,
      last_content_write_at INTEGER NOT NULL CHECK (last_content_write_at >= 0),
      activity_version INTEGER NOT NULL CHECK (activity_version >= 0)
    );
    CREATE INDEX IF NOT EXISTS session_content_activity_age
      ON session_content_activity(last_content_write_at, session_id);
    CREATE TABLE IF NOT EXISTS runtime_compression_checks (
      event_id TEXT PRIMARY KEY REFERENCES runtime_events(event_id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      policy TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_storage_policy (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      writer_enabled INTEGER NOT NULL CHECK (writer_enabled IN (0, 1)),
      epoch INTEGER NOT NULL CHECK (epoch >= 0)
    );
    INSERT OR IGNORE INTO runtime_storage_policy VALUES (1, ${COLD_STORAGE_DEFAULT_WRITER_ENABLED}, 0);
    CREATE INDEX IF NOT EXISTS runtime_cold_candidates ON runtime_events(session_id, event_id)
      WHERE event_kind IN (${RUNTIME_COMPRESSIBLE_KINDS.map((kind) => `'${kind}'`).join(', ')})
      AND substr(payload_json, 1, ${RUNTIME_PAYLOAD_PREFIX.length}) <> '${RUNTIME_PAYLOAD_PREFIX}'
      AND length(CAST(payload_json AS BLOB)) BETWEEN 1024 AND ${RUNTIME_PAYLOAD_MAX_BYTES};
    CREATE INDEX IF NOT EXISTS runtime_encoded_candidates ON runtime_events(session_id, event_id)
      WHERE substr(payload_json, 1, ${RUNTIME_PAYLOAD_PREFIX.length}) = '${RUNTIME_PAYLOAD_PREFIX}';
  `);
  // Historical event timestamps are not evidence of the last actual local write.
  db.prepare(`
    INSERT OR IGNORE INTO session_content_activity
      (session_id, last_content_write_at, activity_version)
    SELECT session_id, ?, 0 FROM (
      SELECT session_id FROM session_metadata
      UNION SELECT session_id FROM runtime_events
      UNION SELECT session_id FROM session_messages
      UNION SELECT session_id FROM core_agent_run_events
      UNION SELECT session_id FROM core_root_turn_admissions
    )
  `).run(now);
  const touch = (session: string) => `
    INSERT INTO session_content_activity(session_id, last_content_write_at, activity_version)
    VALUES (${session}, ${WRITE_TIME}, 1)
    ON CONFLICT(session_id) DO UPDATE SET
      last_content_write_at = max(last_content_write_at, excluded.last_content_write_at),
      activity_version = activity_version + 1;
  `;
  for (const [table, body] of [
    ['runtime_events', 'payload_json'],
    ['session_messages', 'record_json'],
    ['core_agent_run_events', 'record_json'],
    ['runtime_partial_snapshots', 'payload_json'],
  ] as const) {
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS cold_activity_${table}_insert AFTER INSERT ON ${table}
      BEGIN ${touch('NEW.session_id')} END;
    `);
    // RuntimeEvent domain facts are immutable. Their only UPDATE is physical maintenance.
    if (table !== 'runtime_events')
      db.exec(`
      CREATE TRIGGER IF NOT EXISTS cold_activity_${table}_update
      AFTER UPDATE OF ${body} ON ${table} WHEN NEW.${body} <> OLD.${body}
      BEGIN ${touch('NEW.session_id')} END;
    `);
  }
  // Admissions are write-once domain facts. UPDATE only changes their physical representation.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS cold_activity_session_insert
    AFTER INSERT ON session_metadata BEGIN ${touch('NEW.session_id')} END;
    CREATE TRIGGER IF NOT EXISTS cold_activity_admission_insert
    AFTER INSERT ON core_root_turn_admissions BEGIN ${touch('NEW.session_id')} END;
    CREATE TRIGGER IF NOT EXISTS cold_activity_message_payload_insert
    AFTER INSERT ON session_message_payloads BEGIN ${touch('NEW.session_id')} END;
    CREATE TRIGGER IF NOT EXISTS cold_activity_message_payload_update
    AFTER UPDATE ON session_message_payloads BEGIN ${touch('NEW.session_id')} END;
    CREATE TRIGGER IF NOT EXISTS cold_activity_partial_segment_insert
    AFTER INSERT ON runtime_partial_segments BEGIN
      INSERT INTO session_content_activity(session_id, last_content_write_at, activity_version)
      SELECT session_id, ${WRITE_TIME}, 1 FROM runtime_partial_snapshots
      WHERE stream_key = NEW.stream_key
      ON CONFLICT(session_id) DO UPDATE SET
        last_content_write_at = max(last_content_write_at, excluded.last_content_write_at),
        activity_version = activity_version + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS cold_activity_partial_segment_update
    AFTER UPDATE ON runtime_partial_segments BEGIN
      INSERT INTO session_content_activity(session_id, last_content_write_at, activity_version)
      SELECT session_id, ${WRITE_TIME}, 1 FROM runtime_partial_snapshots
      WHERE stream_key = NEW.stream_key
      ON CONFLICT(session_id) DO UPDATE SET
        last_content_write_at = max(last_content_write_at, excluded.last_content_write_at),
        activity_version = activity_version + 1;
    END;
    CREATE TRIGGER IF NOT EXISTS cold_activity_partial_text_update
    AFTER UPDATE OF text_content ON runtime_partial_snapshots WHEN NEW.text_content <> OLD.text_content
    BEGIN ${touch('NEW.session_id')} END;
    CREATE TRIGGER IF NOT EXISTS cold_activity_session_delete
    AFTER DELETE ON session_metadata BEGIN
      DELETE FROM session_content_activity WHERE session_id = OLD.session_id;
    END;
  `);
}

/** A logical restore/import starts a fresh cooling period even if the incoming bytes are encoded. */
export function resetColdStorageActivity(db: DatabaseSync, now: number): void {
  db.prepare(`UPDATE session_content_activity SET
    last_content_write_at = max(last_content_write_at, ?), activity_version = activity_version + 1
  `).run(now);
}
