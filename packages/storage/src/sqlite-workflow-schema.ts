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

export const SQLITE_WORKFLOW_SCHEMA_VERSION = 9;

export function migrateSqliteWorkflowDatabase(db: DatabaseSync): void {
  db.exec(`
    DROP INDEX IF EXISTS workflow_plan_reminders_order;
    DROP TABLE IF EXISTS workflow_plan_reminders;

    CREATE TABLE IF NOT EXISTS workflow_task_ledger_events (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      event_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence),
      UNIQUE (session_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS workflow_task_ledger_projections (
      session_id TEXT PRIMARY KEY,
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_plan_events (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      event_id TEXT NOT NULL,
      store_version INTEGER NOT NULL CHECK (store_version > 0),
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence),
      UNIQUE (session_id, event_id),
      UNIQUE (session_id, store_version)
    );

    CREATE TABLE IF NOT EXISTS workflow_plan_projections (
      session_id TEXT PRIMARY KEY,
      store_version INTEGER NOT NULL CHECK (store_version >= 0),
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_deep_research_events (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      event_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence),
      UNIQUE (session_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS workflow_scheduled_tasks (
      task_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS workflow_scheduled_tasks_order
      ON workflow_scheduled_tasks(created_at, task_id);

    CREATE TABLE IF NOT EXISTS workflow_scheduled_task_fires (
      claim_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL UNIQUE,
      claimed_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_quote_companion_cleanup (
      session_id TEXT PRIMARY KEY,
      tracked_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_daily_review_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      config_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_daily_review_authority_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );

    CREATE TABLE IF NOT EXISTS workflow_daily_review_archives (
      archive_id TEXT PRIMARY KEY,
      generated_at INTEGER NOT NULL,
      day_from_ms INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS workflow_daily_review_archives_order
      ON workflow_daily_review_archives(generated_at DESC, day_from_ms DESC, archive_id);

    CREATE TABLE IF NOT EXISTS workflow_work_board_items (
      item_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('inbox', 'project')),
      project_id TEXT,
      archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
      record_json TEXT NOT NULL,
      CHECK (
        (scope_kind = 'inbox' AND project_id IS NULL)
        OR
        (scope_kind = 'project' AND project_id IS NOT NULL)
      )
    );

    -- The intermediate Phase 0 dev build shipped this index with item_id ASC;
    -- drop it once so such databases converge on the released definition.
    DROP INDEX IF EXISTS workflow_work_board_items_scope_order;
    CREATE INDEX IF NOT EXISTS workflow_work_board_items_scope_order
      ON workflow_work_board_items(scope_kind, project_id, updated_at DESC, item_id DESC);
    CREATE INDEX IF NOT EXISTS workflow_work_board_items_order
      ON workflow_work_board_items(updated_at DESC, item_id DESC);
    CREATE INDEX IF NOT EXISTS workflow_work_board_items_active_scope_order
      ON workflow_work_board_items(scope_kind, project_id, updated_at DESC, item_id DESC)
      WHERE archived = 0;
    CREATE INDEX IF NOT EXISTS workflow_work_board_items_active_order
      ON workflow_work_board_items(updated_at DESC, item_id DESC)
      WHERE archived = 0;

    CREATE TABLE IF NOT EXISTS workflow_goal_authority (
      session_id TEXT PRIMARY KEY,
      authority_revision INTEGER NOT NULL CHECK (authority_revision >= 0),
      goal_id TEXT NOT NULL,
      goal_revision INTEGER NOT NULL CHECK (goal_revision >= 0),
      status TEXT NOT NULL,
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS workflow_goal_authority_status
      ON workflow_goal_authority(status, session_id);
  `);

  const cleanupColumns = new Set(
    (
      db.prepare('PRAGMA table_info(workflow_quote_companion_cleanup)').all() as Array<{
        name: string;
      }>
    ).map(({ name }) => name),
  );
  if (!cleanupColumns.has('record_json')) {
    db.exec('ALTER TABLE workflow_quote_companion_cleanup ADD COLUMN record_json TEXT');
  }
  db.prepare(`
    UPDATE workflow_quote_companion_cleanup
    SET record_json = json_object(
      'version', 1,
      'sessionId', session_id,
      'trackedAt', tracked_at,
      'phase', 'cleanup',
      'cancelRequested', json('true')
    )
    WHERE record_json IS NULL
  `).run();
}
