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

export const SQLITE_USAGE_SCHEMA_VERSION = 7;

/**
 * The canonical ledger's columns, in the order every statement binds them.
 *
 * Ordered so `attempt_id, completed_at, session_id` — the three a damaged row
 * keeps — come first, and the pricing columns follow.
 */
export const MODEL_CALL_COLUMNS = [
  'attempt_id',
  'completed_at',
  'session_id',
  'logical_call_id',
  'turn_id',
  'call_kind',
  'connection_slug',
  'provider_id',
  'model_id',
  'latency_ms',
  'status',
  'error_class',
  'usage_basis',
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_miss_input_tokens',
  'cache_write_input_tokens',
  'reasoning_tokens',
  'cost_basis',
  'cost_usd',
] as const;

/**
 * The JSON path each pricing column was read from before the columns existed,
 * used once by the migration that converted the rows.
 */
const MODEL_CALL_COLUMN_SOURCES: readonly (readonly [string, string])[] = [
  ['logical_call_id', '$.logicalCallId'],
  ['turn_id', '$.turnId'],
  ['call_kind', '$.callKind'],
  ['connection_slug', '$.connectionSlug'],
  ['provider_id', '$.providerId'],
  ['model_id', '$.modelId'],
  ['latency_ms', '$.latencyMs'],
  ['status', '$.status'],
  ['error_class', '$.errorClass'],
  ['usage_basis', '$.usageBasis'],
  ['input_tokens', '$.inputTokens'],
  ['output_tokens', '$.outputTokens'],
  ['cache_read_input_tokens', '$.cacheReadInputTokens'],
  ['cache_miss_input_tokens', '$.cacheMissInputTokens'],
  ['cache_write_input_tokens', '$.cacheWriteInputTokens'],
  ['reasoning_tokens', '$.reasoningTokens'],
  ['cost_basis', '$.costBasis'],
  ['cost_usd', '$.costUsd'],
];

/** The columns that are present together or not at all. See the table's CHECK. */
const MODEL_CALL_REQUIRED_COLUMNS = [
  'logical_call_id',
  'turn_id',
  'call_kind',
  'provider_id',
  'model_id',
  'latency_ms',
  'status',
  'usage_basis',
  'cost_basis',
] as const;

const MODEL_CALL_TOKEN_COLUMNS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_miss_input_tokens',
  'cache_write_input_tokens',
  'reasoning_tokens',
] as const;

const NO_TOKENS = MODEL_CALL_TOKEN_COLUMNS.map((column) => `${column} IS NULL`).join(' AND ');

/**
 * Canonical model-call accounting ledger (#1679).
 *
 * One column per field a cost answer reads, so the totals are a `SUM` the
 * database can compute rather than every row of a workspace's history parsed
 * into memory first.
 *
 * A row is either a complete pricing record or a tombstone that kept only the
 * identity and timestamp of a call whose stored form was damaged. Never half of
 * each — which is what makes `cost_basis IS NOT NULL` a sound test for "this row
 * can be counted", and its negation the count a read reports as unreadable.
 *
 * The vocabularies (`status`, `call_kind`) are deliberately not constrained
 * here. They are already validated where a record is decoded, and a CHECK on
 * them would turn one damaged row into a failed migration for the whole
 * workspace.
 */
const MODEL_CALL_TABLE = `
  CREATE TABLE IF NOT EXISTS %TABLE% (
    attempt_id TEXT PRIMARY KEY,
    completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
    session_id TEXT,
    logical_call_id TEXT,
    turn_id TEXT,
    call_kind TEXT,
    connection_slug TEXT,
    provider_id TEXT,
    model_id TEXT,
    latency_ms INTEGER,
    status TEXT,
    error_class TEXT,
    usage_basis TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_input_tokens INTEGER,
    cache_miss_input_tokens INTEGER,
    cache_write_input_tokens INTEGER,
    reasoning_tokens INTEGER,
    cost_basis TEXT,
    cost_usd REAL,
    CHECK (${MODEL_CALL_REQUIRED_COLUMNS.map(
      (column) => `(${column} IS NULL) = (cost_basis IS NULL)`,
    ).join(' AND ')}),
    -- A price that could not be resolved must never surface as an amount, and a
    -- priced call must carry one. Zero stays legal: it is the only way to say a
    -- call was genuinely free.
    CHECK (cost_basis IS NOT 'priced' OR cost_usd IS NOT NULL),
    CHECK (cost_basis IS NOT 'unpriced' OR cost_usd IS NULL),
    -- "The provider reported no usage" and "it reported zero" are different
    -- facts, so a missing-usage row carries no token counts at all.
    CHECK (usage_basis IS NOT 'missing' OR (${NO_TOKENS}))
  )
`;

export function migrateSqliteUsageDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_llm_calls (
      storage_key TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      ts INTEGER NOT NULL CHECK (ts >= 0),
      record_json TEXT NOT NULL,
      session_id TEXT
    );

    CREATE INDEX IF NOT EXISTS usage_llm_calls_ts
      ON usage_llm_calls(ts DESC, id);

    CREATE TABLE IF NOT EXISTS usage_tool_invocations (
      storage_key TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      ts INTEGER NOT NULL CHECK (ts >= 0),
      record_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS usage_tool_invocations_ts
      ON usage_tool_invocations(ts DESC, id);

    ${MODEL_CALL_TABLE.replace('%TABLE%', 'usage_model_call_attempts')};

    -- The AgentRun sequence is the projection's sole progress authority. A run
    -- is behind exactly when its latest model-call event is newer than this
    -- checkpoint; unreadable evidence is retained without pinning later calls.
    CREATE TABLE IF NOT EXISTS usage_model_call_projection_checkpoints (
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      applied_through_sequence INTEGER NOT NULL CHECK (applied_through_sequence >= 0),
      unreadable_events INTEGER NOT NULL DEFAULT 0 CHECK (unreadable_events >= 0),
      PRIMARY KEY (session_id, run_id),
      FOREIGN KEY (session_id, run_id)
        REFERENCES core_agent_runs(session_id, run_id)
        ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS usage_pricing_authority (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );

    INSERT OR IGNORE INTO usage_pricing_authority(singleton, revision)
    VALUES (1, 0);

    CREATE TABLE IF NOT EXISTS usage_pricing_overrides (
      model_key TEXT PRIMARY KEY,
      record_json TEXT NOT NULL
    );
  `);
  db.exec('DROP TABLE IF EXISTS usage_model_call_reprojection');
  ensureColumn(db, 'usage_llm_calls', 'session_id', 'TEXT');
  db.exec(`
    UPDATE usage_llm_calls
    SET session_id = json_extract(record_json, '$.sessionId')
    WHERE session_id IS NULL AND json_valid(record_json);

    CREATE INDEX IF NOT EXISTS usage_llm_calls_session_ts
      ON usage_llm_calls(session_id, ts DESC, id);
  `);
  // A ledger old enough to predate Session attribution has no column to carry
  // through, and the conversion below reads one.
  ensureColumn(db, 'usage_model_call_attempts', 'session_id', 'TEXT');
  spreadModelCallRecordJson(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS usage_model_call_attempts_completed_at
      ON usage_model_call_attempts(completed_at DESC, attempt_id);

    CREATE INDEX IF NOT EXISTS usage_model_call_attempts_session_completed_at
      ON usage_model_call_attempts(session_id, completed_at DESC, attempt_id);
  `);
}

/**
 * Converts rows that stored the record as one JSON blob into the columns.
 *
 * Not rebuilt from the AgentRun authority, the usual move for a read model:
 * deleting a Session drops its runs and cascades their events while these rows
 * are kept on purpose, so for those calls this table is the last copy and a
 * wipe-and-replay would erase their spend. See the header of
 * `model-call-ledger.ts`.
 *
 * A blob that does not yield a whole record — damaged text, or a row some other
 * schema left behind — keeps its identity and timestamp and loses the rest. That
 * is the same claim the old JSON reader made by counting it as unreadable, and
 * it is why the conversion is all-or-nothing per row: a half-filled row would
 * make the table's own CHECK unsatisfiable and take the whole migration with it.
 */
function spreadModelCallRecordJson(db: DatabaseSync): void {
  if (!hasColumn(db, 'usage_model_call_attempts', 'record_json')) return;
  const extracted = MODEL_CALL_COLUMN_SOURCES.map(
    ([column, path]) =>
      `CASE WHEN json_valid(record_json) THEN json_extract(record_json, '${path}') END AS ${column}`,
  ).join(',\n        ');
  const readable = [
    ...MODEL_CALL_REQUIRED_COLUMNS.map((column) => `${column} IS NOT NULL`),
    "(cost_basis IS NOT 'priced' OR cost_usd IS NOT NULL)",
    "(cost_basis IS NOT 'unpriced' OR cost_usd IS NULL)",
    `(usage_basis IS NOT 'missing' OR (${NO_TOKENS}))`,
  ].join('\n          AND ');
  const pricing = MODEL_CALL_COLUMN_SOURCES.map(
    ([column]) => `CASE WHEN readable THEN ${column} END`,
  ).join(',\n      ');
  // The old table moves aside so the new one is created under its final name:
  // a table renamed into place keeps a rewritten `CREATE` statement, and the
  // schema guard compares those texts.
  db.exec(`
    ALTER TABLE usage_model_call_attempts RENAME TO usage_model_call_attempts_blob;

    ${MODEL_CALL_TABLE.replace('%TABLE%', 'usage_model_call_attempts')};

    INSERT INTO usage_model_call_attempts(${MODEL_CALL_COLUMNS.join(', ')})
    WITH extracted AS (
      SELECT
        attempt_id,
        completed_at,
        -- A tombstone keeps its Session: the row still says a call happened here.
        COALESCE(
          session_id,
          CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.sessionId') END
        ) AS session_id,
        ${extracted}
      FROM usage_model_call_attempts_blob
    ),
    classified AS (
      SELECT *, (${readable}) AS readable FROM extracted
    )
    SELECT
      attempt_id,
      completed_at,
      session_id,
      ${pricing}
    FROM classified;

    DROP TABLE usage_model_call_attempts_blob;
  `);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): void {
  if (hasColumn(db, table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return columns.some((candidate) => candidate.name === column);
}
