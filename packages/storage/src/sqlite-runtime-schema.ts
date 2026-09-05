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
  decodePersistedLegacyRunHeader,
  invocationOpeningFromLegacyRunHeader,
  type LegacyRunHeader,
} from './legacy-run-header.js';
import type { RuntimeEvent } from '@maka/core/runtime-event';
import { encodeCanonicalRuntimeEvent } from '@maka/core/canonical-runtime-event';
import {
  buildInvocationOpenedEvent,
  buildSyntheticTerminalRuntimeEvent,
} from '@maka/core/runtime-invocation';

export const SQLITE_RUNTIME_SCHEMA_VERSION = 16;
export const RUNTIME_RECOVERY_AUTHORITY_CAPABILITY = 'runtime_recovery_authority';
export const RUNTIME_RECOVERY_AUTHORITY_CAPABILITY_VERSION = 1;
export const RUNTIME_CONTINUATION_AUTHORITY_CAPABILITY = 'runtime_continuation_authority';
export const RUNTIME_CONTINUATION_AUTHORITY_CAPABILITY_VERSION = 1;
export const RUNTIME_WORKSPACE_VERSION_AUTHORITY_CAPABILITY = 'runtime_workspace_version_authority';
export const RUNTIME_WORKSPACE_VERSION_AUTHORITY_CAPABILITY_VERSION = 1;
const SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS = 5_000;
const SQLITE_INITIALIZATION_RETRY_DELAY_MS = 10;
const initializationRetryGate = new Int32Array(new SharedArrayBuffer(4));

const MIGRATIONS: ReadonlyMap<number, string> = new Map([
  [
    1,
    `
    CREATE TABLE runtime_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      event_seq INTEGER NOT NULL CHECK (event_seq > 0),
      event_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      committed_at INTEGER NOT NULL,
      UNIQUE (invocation_id, event_seq)
    );

    CREATE INDEX runtime_events_by_run
      ON runtime_events(session_id, run_id, event_seq);

    CREATE INDEX runtime_events_by_session
      ON runtime_events(session_id, committed_at, event_id);

    CREATE TABLE tool_journal_events (
      journal_seq INTEGER PRIMARY KEY AUTOINCREMENT,
      journal_event_id TEXT NOT NULL UNIQUE,
      operation_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      state TEXT NOT NULL,
      runtime_event_id TEXT,
      canonical_args_hash TEXT,
      recovery_mode TEXT,
      external_handle TEXT,
      metadata_json TEXT,
      committed_at INTEGER NOT NULL,
      FOREIGN KEY(runtime_event_id) REFERENCES runtime_events(event_id)
    );

    CREATE INDEX tool_journal_events_by_operation
      ON tool_journal_events(operation_id, journal_seq);

    CREATE TABLE tool_operations (
      operation_id TEXT PRIMARY KEY,
      invocation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      provider_tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      canonical_args_hash TEXT NOT NULL,
      recovery_mode TEXT NOT NULL,
      current_state TEXT NOT NULL,
      call_event_id TEXT NOT NULL,
      result_event_id TEXT,
      version INTEGER NOT NULL CHECK (version > 0),
      FOREIGN KEY(call_event_id) REFERENCES runtime_events(event_id),
      FOREIGN KEY(result_event_id) REFERENCES runtime_events(event_id),
      UNIQUE(invocation_id, provider_tool_call_id)
    );
  `,
  ],
  [
    2,
    `
    CREATE TABLE runtime_partial_snapshots (
      stream_key TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      invocation_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      after_event_id TEXT,
      payload_json TEXT NOT NULL,
      text_content TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX runtime_partial_snapshots_by_run
      ON runtime_partial_snapshots(session_id, run_id, updated_at, stream_key);
  `,
  ],
  [
    3,
    `
    SELECT 1;
  `,
  ],
  [
    4,
    `
    ALTER TABLE tool_operations ADD COLUMN dispatch_event_id TEXT
      REFERENCES runtime_events(event_id);
  `,
  ],
  [
    5,
    `
    CREATE TABLE runtime_capabilities (
      capability TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version > 0)
    );

    INSERT INTO runtime_capabilities(capability, version)
      VALUES ('runtime_recovery_authority', 1);
  `,
  ],
  [
    6,
    `
    CREATE TABLE runtime_continuation_claims (
      claim_id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL,
      source_invocation_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL,
      source_turn_id TEXT NOT NULL,
      source_event_high_water INTEGER NOT NULL CHECK (source_event_high_water > 0),
      source_prefix_digest TEXT NOT NULL,
      boundary_digest TEXT NOT NULL UNIQUE,
      boundary_json TEXT NOT NULL,
      provider_projection_version INTEGER NOT NULL CHECK (provider_projection_version = 1),
      provider_replay_digest TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      target_invocation_id TEXT NOT NULL UNIQUE,
      target_run_id TEXT NOT NULL UNIQUE,
      target_turn_id TEXT NOT NULL,
      target_run_header_json TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      start_event_id TEXT UNIQUE REFERENCES runtime_events(event_id),
      start_kind TEXT CHECK (
        start_kind IS NULL OR start_kind IN ('runtime_admission', 'claim_repair')
      ),
      protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
      UNIQUE (
        source_session_id,
        source_run_id,
        source_event_high_water,
        source_prefix_digest
      ),
      UNIQUE (target_session_id, target_turn_id)
    );

    INSERT INTO runtime_capabilities(capability, version)
      VALUES ('runtime_continuation_authority', 1);
  `,
  ],
  [
    7,
    `
    CREATE TABLE runtime_workspace_epochs (
      workspace_id TEXT NOT NULL,
      workspace_epoch_id TEXT NOT NULL UNIQUE,
      repository_id TEXT NOT NULL,
      workspace_instance_id TEXT NOT NULL UNIQUE,
      mode TEXT NOT NULL CHECK (mode = 'managed_worktree'),
      object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
      source_commit_oid TEXT NOT NULL,
      source_tree_oid TEXT NOT NULL,
      initial_workspace_version_id TEXT NOT NULL UNIQUE,
      materialization_profile_digest TEXT NOT NULL,
      materialization_semantics TEXT NOT NULL
        CHECK (materialization_semantics = 'git_tree_materialized_with_fixed_config_v1'),
      policy_hash TEXT NOT NULL,
      authority_session_id TEXT NOT NULL CHECK (authority_session_id = 'maka_workspace_authority'),
      authority_invocation_id TEXT NOT NULL UNIQUE,
      authority_run_id TEXT NOT NULL UNIQUE,
      authority_turn_id TEXT NOT NULL UNIQUE,
      epoch_opened_event_id TEXT NOT NULL UNIQUE REFERENCES runtime_events(event_id),
      protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
      committed_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, workspace_epoch_id)
    );

    CREATE TABLE runtime_workspace_versions (
      workspace_version_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      workspace_epoch_id TEXT NOT NULL,
      object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
      origin_kind TEXT NOT NULL CHECK (origin_kind = 'baseline'),
      origin_event_id TEXT NOT NULL,
      parents_json TEXT NOT NULL CHECK (parents_json = '[]'),
      commit_oid TEXT NOT NULL,
      tree_oid TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      tree_delta_digest TEXT NOT NULL,
      changed_file_count INTEGER NOT NULL CHECK (changed_file_count >= 0),
      deleted_file_count INTEGER NOT NULL CHECK (deleted_file_count = 0),
      accepted_event_id TEXT NOT NULL UNIQUE REFERENCES runtime_events(event_id),
      protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
      committed_at INTEGER NOT NULL,
      FOREIGN KEY (workspace_id, workspace_epoch_id)
        REFERENCES runtime_workspace_epochs(workspace_id, workspace_epoch_id),
      UNIQUE (
        workspace_id,
        workspace_epoch_id,
        workspace_version_id,
        accepted_event_id
      )
    );

    CREATE TABLE runtime_workspace_heads (
      workspace_id TEXT NOT NULL,
      workspace_epoch_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      workspace_version_id TEXT NOT NULL,
      accepted_event_id TEXT NOT NULL,
      commit_oid TEXT NOT NULL,
      tree_oid TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      PRIMARY KEY (workspace_id, workspace_epoch_id),
      FOREIGN KEY (workspace_id, workspace_epoch_id)
        REFERENCES runtime_workspace_epochs(workspace_id, workspace_epoch_id),
      FOREIGN KEY (
        workspace_id,
        workspace_epoch_id,
        workspace_version_id,
        accepted_event_id
      ) REFERENCES runtime_workspace_versions(
        workspace_id,
        workspace_epoch_id,
        workspace_version_id,
        accepted_event_id
      )
    );

    INSERT INTO runtime_capabilities(capability, version)
      VALUES ('runtime_workspace_version_authority', 1);
  `,
  ],
  [
    8,
    `
    SELECT 1;
  `,
  ],
  [
    9,
    `
    CREATE TABLE runtime_storage_root_binding (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      root_id TEXT NOT NULL CHECK (
        length(root_id) = 64 AND root_id NOT GLOB '*[^0-9a-f]*'
      ),
      protocol_version INTEGER NOT NULL CHECK (protocol_version = 1)
    );
  `,
  ],
  [
    10,
    `
    CREATE TABLE runtime_partial_segments (
      stream_key TEXT NOT NULL,
      segment_seq INTEGER NOT NULL CHECK (segment_seq > 0),
      text_content TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (stream_key, segment_seq),
      FOREIGN KEY (stream_key)
        REFERENCES runtime_partial_snapshots(stream_key)
        ON DELETE CASCADE
    );
  `,
  ],
  [
    11,
    `
    CREATE TABLE runtime_session_event_ordinals (
      session_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL CHECK (ordinal > 0),
      event_id TEXT NOT NULL UNIQUE,
      PRIMARY KEY (session_id, ordinal),
      FOREIGN KEY (event_id) REFERENCES runtime_events(event_id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    INSERT INTO runtime_session_event_ordinals(session_id, ordinal, event_id)
    SELECT
      session_id,
      ROW_NUMBER() OVER (
        PARTITION BY session_id
        ORDER BY rowid ASC
      ),
      event_id
    FROM runtime_events;
  `,
  ],
  [
    12,
    `
    DROP TABLE IF EXISTS headless_task_run_events;
  `,
  ],
  [
    13,
    `
    ALTER TABLE runtime_workspace_heads RENAME TO runtime_workspace_heads_v12;
    ALTER TABLE runtime_workspace_versions RENAME TO runtime_workspace_versions_v12;

    CREATE TABLE runtime_workspace_versions (
      workspace_version_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      workspace_epoch_id TEXT NOT NULL,
      object_format TEXT NOT NULL CHECK (object_format IN ('sha1', 'sha256')),
      origin_kind TEXT NOT NULL CHECK (origin_kind IN ('baseline', 'tool_mutation')),
      origin_event_id TEXT NOT NULL,
      parents_json TEXT NOT NULL,
      operation_id TEXT,
      dispatch_event_id TEXT REFERENCES runtime_events(event_id),
      outcome_event_id TEXT REFERENCES runtime_events(event_id),
      base_head_revision INTEGER CHECK (base_head_revision IS NULL OR base_head_revision > 0),
      execution_profile_digest TEXT,
      commit_oid TEXT NOT NULL,
      tree_oid TEXT NOT NULL,
      policy_hash TEXT NOT NULL,
      tree_delta_digest TEXT NOT NULL,
      changed_file_count INTEGER NOT NULL CHECK (changed_file_count >= 0),
      deleted_file_count INTEGER NOT NULL CHECK (deleted_file_count >= 0),
      accepted_event_id TEXT NOT NULL UNIQUE REFERENCES runtime_events(event_id),
      protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
      committed_at INTEGER NOT NULL,
      FOREIGN KEY (workspace_id, workspace_epoch_id)
        REFERENCES runtime_workspace_epochs(workspace_id, workspace_epoch_id),
      UNIQUE (
        workspace_id,
        workspace_epoch_id,
        workspace_version_id,
        accepted_event_id
      ),
      CHECK (
        (origin_kind = 'baseline' AND parents_json = '[]' AND operation_id IS NULL
          AND dispatch_event_id IS NULL AND outcome_event_id IS NULL
          AND base_head_revision IS NULL AND execution_profile_digest IS NULL)
        OR
        (origin_kind = 'tool_mutation' AND parents_json <> '[]' AND operation_id IS NOT NULL
          AND dispatch_event_id IS NOT NULL AND outcome_event_id IS NOT NULL
          AND base_head_revision IS NOT NULL AND execution_profile_digest IS NOT NULL)
      )
    );

    INSERT INTO runtime_workspace_versions (
      workspace_version_id, repository_id, workspace_id, workspace_epoch_id,
      object_format, origin_kind, origin_event_id, parents_json,
      operation_id, dispatch_event_id, outcome_event_id, base_head_revision,
      execution_profile_digest, commit_oid, tree_oid, policy_hash,
      tree_delta_digest, changed_file_count, deleted_file_count,
      accepted_event_id, protocol_version, committed_at
    )
    SELECT
      workspace_version_id, repository_id, workspace_id, workspace_epoch_id,
      object_format, origin_kind, origin_event_id, parents_json,
      NULL, NULL, NULL, NULL, NULL, commit_oid, tree_oid, policy_hash,
      tree_delta_digest, changed_file_count, deleted_file_count,
      accepted_event_id, protocol_version, committed_at
    FROM runtime_workspace_versions_v12;

    CREATE TABLE runtime_workspace_heads (
      workspace_id TEXT NOT NULL,
      workspace_epoch_id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      workspace_version_id TEXT NOT NULL,
      accepted_event_id TEXT NOT NULL,
      commit_oid TEXT NOT NULL,
      tree_oid TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      PRIMARY KEY (workspace_id, workspace_epoch_id),
      FOREIGN KEY (workspace_id, workspace_epoch_id)
        REFERENCES runtime_workspace_epochs(workspace_id, workspace_epoch_id),
      FOREIGN KEY (
        workspace_id,
        workspace_epoch_id,
        workspace_version_id,
        accepted_event_id
      ) REFERENCES runtime_workspace_versions(
        workspace_id,
        workspace_epoch_id,
        workspace_version_id,
        accepted_event_id
      )
    );

    INSERT INTO runtime_workspace_heads
    SELECT * FROM runtime_workspace_heads_v12;

    DROP TABLE runtime_workspace_heads_v12;
    DROP TABLE runtime_workspace_versions_v12;
    `,
  ],
  [
    14,
    `
    ALTER TABLE runtime_workspace_versions
      ADD COLUMN changed_paths_json TEXT NOT NULL DEFAULT '[]';

    CREATE TABLE runtime_managed_mutation_reservations (
      workspace_instance_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      workspace_epoch_id TEXT NOT NULL,
      operation_id TEXT NOT NULL UNIQUE REFERENCES tool_operations(operation_id),
      dispatch_event_id TEXT NOT NULL UNIQUE REFERENCES runtime_events(event_id),
      base_workspace_version_id TEXT NOT NULL,
      base_accepted_event_id TEXT NOT NULL,
      base_head_revision INTEGER NOT NULL CHECK (base_head_revision > 0),
      base_commit_oid TEXT NOT NULL,
      base_tree_oid TEXT NOT NULL,
      expected_paths_json TEXT NOT NULL,
      execution_profile_digest TEXT NOT NULL,
      protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
      reserved_at INTEGER NOT NULL,
      FOREIGN KEY (workspace_id, workspace_epoch_id)
        REFERENCES runtime_workspace_epochs(workspace_id, workspace_epoch_id)
    );
    `,
  ],
  [
    15,
    `
    CREATE TABLE runtime_continuation_claims_v15 (
      claim_id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL,
      source_invocation_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL,
      source_turn_id TEXT NOT NULL,
      source_event_high_water INTEGER NOT NULL CHECK (source_event_high_water > 0),
      source_prefix_digest TEXT NOT NULL,
      boundary_digest TEXT NOT NULL UNIQUE,
      boundary_json TEXT NOT NULL,
      provider_projection_version INTEGER NOT NULL CHECK (provider_projection_version IN (1, 2)),
      provider_replay_digest TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      target_invocation_id TEXT NOT NULL UNIQUE,
      target_run_id TEXT NOT NULL UNIQUE,
      target_turn_id TEXT NOT NULL,
      target_run_header_json TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      start_event_id TEXT UNIQUE REFERENCES runtime_events(event_id),
      start_kind TEXT CHECK (
        start_kind IS NULL OR start_kind IN ('runtime_admission', 'claim_repair')
      ),
      protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
      UNIQUE (
        source_session_id,
        source_run_id,
        source_event_high_water,
        source_prefix_digest
      ),
      UNIQUE (target_session_id, target_turn_id)
    );

    INSERT INTO runtime_continuation_claims_v15
      SELECT * FROM runtime_continuation_claims;
    DROP TABLE runtime_continuation_claims;
    ALTER TABLE runtime_continuation_claims_v15 RENAME TO runtime_continuation_claims;
    `,
  ],
  [
    16,
    `
    CREATE INDEX runtime_events_by_session_kind
      ON runtime_events(session_id, event_kind, invocation_id);

    CREATE UNIQUE INDEX runtime_events_one_opening_per_invocation
      ON runtime_events(invocation_id)
      WHERE event_kind = 'invocation_opened';

    CREATE TABLE runtime_legacy_invocation_openings (
      invocation_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      opening_json TEXT NOT NULL,
      -- UNIQUE is what indexes this side of the foreign key. SQLite indexes only
      -- the parent, so without it every deleted RuntimeEvent scans this whole
      -- table looking for rows to cascade.
      anchor_event_id TEXT NOT NULL UNIQUE
        REFERENCES runtime_events(event_id) ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE INDEX runtime_legacy_invocation_openings_by_session
      ON runtime_legacy_invocation_openings(session_id, opened_at, invocation_id);

    -- Rebuilt rather than renamed in place, because the column rename is not
    -- the only thing this claim needs. Its start event belongs to the target
    -- Session, and the foreign key had no ON DELETE clause, so purging that
    -- Session was refused outright by the constraint and the whole purge rolled
    -- back. A continuation whose target has been deleted no longer names
    -- anything, so the claim goes with it and the source boundary it held is
    -- free again.
    CREATE TABLE runtime_continuation_claims_v16 (
      claim_id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL,
      source_invocation_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL,
      source_turn_id TEXT NOT NULL,
      source_event_high_water INTEGER NOT NULL CHECK (source_event_high_water > 0),
      source_prefix_digest TEXT NOT NULL,
      boundary_digest TEXT NOT NULL UNIQUE,
      boundary_json TEXT NOT NULL,
      provider_projection_version INTEGER NOT NULL CHECK (provider_projection_version IN (1, 2)),
      provider_replay_digest TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      target_invocation_id TEXT NOT NULL UNIQUE,
      target_run_id TEXT NOT NULL UNIQUE,
      target_turn_id TEXT NOT NULL,
      target_opening_json TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      start_event_id TEXT UNIQUE REFERENCES runtime_events(event_id) ON DELETE CASCADE,
      start_kind TEXT CHECK (
        start_kind IS NULL OR start_kind IN ('runtime_admission', 'claim_repair')
      ),
      protocol_version INTEGER NOT NULL CHECK (protocol_version = 1),
      UNIQUE (
        source_session_id,
        source_run_id,
        source_event_high_water,
        source_prefix_digest
      ),
      UNIQUE (target_session_id, target_turn_id)
    );

    INSERT INTO runtime_continuation_claims_v16 (
      claim_id, source_session_id, source_invocation_id, source_run_id, source_turn_id,
      source_event_high_water, source_prefix_digest, boundary_digest, boundary_json,
      provider_projection_version, provider_replay_digest, target_session_id,
      target_invocation_id, target_run_id, target_turn_id, target_opening_json,
      claimed_at, start_event_id, start_kind, protocol_version
    )
    SELECT
      claim_id, source_session_id, source_invocation_id, source_run_id, source_turn_id,
      source_event_high_water, source_prefix_digest, boundary_digest, boundary_json,
      provider_projection_version, provider_replay_digest, target_session_id,
      target_invocation_id, target_run_id, target_turn_id, target_run_header_json,
      claimed_at, start_event_id, start_kind, protocol_version
    FROM runtime_continuation_claims;
    DROP TABLE runtime_continuation_claims;
    ALTER TABLE runtime_continuation_claims_v16 RENAME TO runtime_continuation_claims;
    `,
  ],
]);

/**
 * Data migrations that a SQL statement cannot express, applied inside the same
 * transaction as their schema step. They project persisted records through the
 * one TypeScript mapping that owns that projection, so a migration and the live
 * writer can never classify a field two different ways.
 */
const DATA_MIGRATIONS: ReadonlyMap<number, (db: DatabaseSync) => void> = new Map([
  [
    16,
    (db) => {
      backfillInvocationOpeningFacts(db);
      projectContinuationClaimOpenings(db);
    },
  ],
]);

/**
 * Replace each open claim's embedded target Run header with the opening fact it
 * always implied.
 *
 * The header was only ever there so the start event could be checked against
 * it, and the check went through the projection anyway. Projecting once, here,
 * leaves one representation instead of a copy plus a derivation.
 *
 * A row this cannot project is dropped rather than left half-migrated: an
 * undecodable claim could not have admitted a start event before this migration
 * either, and keeping it would only block the boundary it holds.
 */
function projectContinuationClaimOpenings(db: DatabaseSync): void {
  const rows = db
    .prepare('SELECT claim_id, target_opening_json FROM runtime_continuation_claims')
    .all() as Array<{ claim_id: string; target_opening_json: string }>;
  const update = db.prepare(
    'UPDATE runtime_continuation_claims SET target_opening_json = ? WHERE claim_id = ?',
  );
  const remove = db.prepare('DELETE FROM runtime_continuation_claims WHERE claim_id = ?');
  for (const row of rows) {
    try {
      const header = decodePersistedLegacyRunHeader(JSON.parse(row.target_opening_json));
      update.run(JSON.stringify(invocationOpeningFromLegacyRunHeader(header)), row.claim_id);
    } catch {
      remove.run(row.claim_id);
    }
  }
}

/**
 * Give every Run header its opening fact, so that after this migration the
 * opening lives in the runtime database rather than on the header.
 *
 * A run that never wrote a RuntimeEvent gets the real thing: the opening fact
 * as event one of its own invocation. A run that already has events cannot,
 * because it owns an immutable sequence whose position 1, digests and coverage
 * other facts already point at; inserting into it would rewrite signed history.
 * Its opening is recorded in `runtime_legacy_invocation_openings` instead,
 * which only this migration ever writes. Readers merge the two, so nothing
 * downstream has to know which shelf a given opening came off.
 *
 * A shelved opening describes a ledger that already exists, so it is anchored to
 * that ledger's first event and dies with it. Without the anchor, deleting a
 * Session's events would leave the opening behind, and the inventory would
 * report the run again with no ending — a completed run coming back as an
 * active one.
 *
 * A header this cannot project fails closed: it is skipped, and its transcript
 * and tool evidence stay exactly as readable as before.
 */
function backfillInvocationOpeningFacts(db: DatabaseSync): void {
  if (!hasTable(db, 'core_agent_runs')) return;
  // The header column is dropped by the core-execution migration that follows
  // this one, so its absence means every header it held is already an opening
  // fact. Nothing left to project, and the two scopes stay independently
  // replayable.
  if (!hasColumn(db, 'core_agent_runs', 'record_json')) return;
  const rows = db
    .prepare(`
      SELECT
        r.session_id,
        r.run_id,
        r.record_json,
        first_event.invocation_id AS existing_invocation_id,
        first_event.event_id AS anchor_event_id
      FROM core_agent_runs r
      LEFT JOIN runtime_events first_event ON first_event.event_id = (
        SELECT e.event_id FROM runtime_events e
        WHERE e.session_id = r.session_id AND e.run_id = r.run_id
        ORDER BY e.event_seq ASC LIMIT 1
      )
      ORDER BY r.created_at ASC, r.run_id ASC
    `)
    .all() as Array<{
    session_id: string;
    run_id: string;
    record_json: string;
    existing_invocation_id: string | null;
    anchor_event_id: string | null;
  }>;
  const insertEvent = db.prepare(`
    INSERT INTO runtime_events (
      event_id, session_id, invocation_id, run_id, turn_id, event_seq,
      event_kind, payload_json, committed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertOrdinal = db.prepare(`
    INSERT INTO runtime_session_event_ordinals(session_id, ordinal, event_id)
    SELECT ?, COALESCE(MAX(ordinal), 0) + 1, ?
    FROM runtime_session_event_ordinals WHERE session_id = ?
  `);
  const insertLegacyOpening = db.prepare(`
    INSERT OR IGNORE INTO runtime_legacy_invocation_openings (
      invocation_id, session_id, run_id, turn_id, opened_at, opening_json,
      anchor_event_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  // The header column is dropped right after this, so a header this cannot read
  // is a run that would silently cease to exist. Refusing the whole migration
  // keeps the database as it was, and the failure names the row instead of
  // hiding it.
  const unreadable = (row: { session_id: string; run_id: string }, cause: unknown): Error =>
    new Error(
      `Cannot migrate the AgentRun header of ${row.session_id}/${row.run_id}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
  for (const row of rows) {
    let header: LegacyRunHeader;
    let opening: string;
    try {
      header = decodePersistedLegacyRunHeader(JSON.parse(row.record_json));
      opening = JSON.stringify(invocationOpeningFromLegacyRunHeader(header));
    } catch (error) {
      throw unreadable(row, error);
    }
    if (row.existing_invocation_id !== null && row.anchor_event_id !== null) {
      // The invocation id its own events already carry is the one every reader
      // joins on, so the legacy row is keyed by that rather than by the header's
      // copy, which older builds minted independently.
      insertLegacyOpening.run(
        row.existing_invocation_id,
        header.sessionId,
        header.runId,
        header.turnId,
        header.createdAt,
        opening,
        row.anchor_event_id,
      );
      continue;
    }
    // A run with no events of its own gets the facts its header held, where
    // facts live now: the opening, and the ending if the header recorded one.
    // A header still marked in flight stays open; recovery settles it the way it
    // settles any run the process died holding.
    const run = {
      sessionId: header.sessionId,
      invocationId: header.invocationId ?? header.runId,
      runId: header.runId,
      turnId: header.turnId,
    };
    const events = [
      buildInvocationOpenedEvent({
        id: `invocation_opened:${header.runId}`,
        run,
        openedAt: header.createdAt,
        opening: invocationOpeningFromLegacyRunHeader(header),
      }),
      ...(header.status === 'completed' ||
      header.status === 'failed' ||
      header.status === 'cancelled'
        ? [
            buildSyntheticTerminalRuntimeEvent({
              id: `invocation_terminal:${header.runId}`,
              invocationId: run.invocationId,
              run,
              status: header.status,
              ts: header.completedAt ?? header.updatedAt,
              ...(header.failureClass !== undefined ? { failureClass: header.failureClass } : {}),
              ...(header.failureMessage !== undefined ? { message: header.failureMessage } : {}),
              ...(header.abortSource !== undefined ? { abortSource: header.abortSource } : {}),
            }),
          ]
        : []),
    ];
    events.forEach((event, index) => {
      let encoded: { event: RuntimeEvent; json: string };
      try {
        encoded = encodeCanonicalRuntimeEvent(event);
      } catch (error) {
        throw unreadable(row, error);
      }
      insertEvent.run(
        event.id,
        event.sessionId,
        event.invocationId,
        event.runId,
        event.turnId,
        index + 1,
        runtimeEventKind(event),
        encoded.json,
        event.ts,
      );
      insertOrdinal.run(event.sessionId, event.id, event.sessionId);
    });
  }
}

/** The `event_kind` column: the one coarse label every reader indexes events by. */
export function runtimeEventKind(event: RuntimeEvent): string {
  return (
    event.content?.kind ??
    event.status ??
    (event.actions?.workspaceFact ? 'workspace_fact' : undefined) ??
    (event.actions?.toolDispatch ? 'tool_dispatch' : undefined) ??
    (event.actions?.endInvocation ? 'invocation_end' : 'runtime_fact')
  );
}

function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return columns.some((candidate) => candidate.name === column);
}

function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { present?: unknown } | undefined;
  return row?.present === 1;
}

export function configureSqliteRuntimeDatabase(db: DatabaseSync): void {
  // Bound lock acquisition before touching persistent journal state. WAL mode is
  // database-persistent, so established workspaces only need to verify it rather
  // than making every concurrent opener execute the setting form of the pragma.
  configureSqliteRuntimeLockWait(db);
  ensureWalJournalMode(db);
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
}

/** Configure connection-local lock waiting without changing persistent database state. */
export function configureSqliteRuntimeLockWait(db: DatabaseSync): void {
  db.exec(`PRAGMA busy_timeout = ${SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS}`);
}

export function migrateSqliteRuntimeDatabase(
  db: DatabaseSync,
  options: { transaction?: 'self' | 'caller' } = {},
): void {
  const observedVersion = readUserVersion(db);
  if (observedVersion > SQLITE_RUNTIME_SCHEMA_VERSION) {
    throw new Error(
      `SQLite runtime schema ${observedVersion} is newer than supported version ${SQLITE_RUNTIME_SCHEMA_VERSION}`,
    );
  }
  if (observedVersion === SQLITE_RUNTIME_SCHEMA_VERSION) return;

  // The optimistic read keeps established databases on a read-only open path.
  // Any pending upgrade is serialized by one write transaction, then re-reads
  // user_version under that lock so a concurrent opener cannot apply a
  // migration another process just committed.
  const ownsTransaction = options.transaction !== 'caller';
  if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    const current = readUserVersion(db);
    if (current > SQLITE_RUNTIME_SCHEMA_VERSION) {
      throw new Error(
        `SQLite runtime schema ${current} is newer than supported version ${SQLITE_RUNTIME_SCHEMA_VERSION}`,
      );
    }
    for (let version = current + 1; version <= SQLITE_RUNTIME_SCHEMA_VERSION; version += 1) {
      const sql = MIGRATIONS.get(version);
      if (!sql) throw new Error(`Missing SQLite runtime migration ${version}`);
      db.exec(sql);
      DATA_MIGRATIONS.get(version)?.(db);
      db.exec(`PRAGMA user_version = ${version}`);
    }
    if (ownsTransaction) db.exec('COMMIT');
  } catch (error) {
    if (ownsTransaction) rollback(db);
    throw error;
  }
}

export function readUserVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: unknown } | undefined;
  const value = row?.user_version;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid SQLite runtime schema version');
  }
  return value;
}

function readJournalMode(db: DatabaseSync): string {
  const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: unknown } | undefined;
  if (typeof row?.journal_mode !== 'string') {
    throw new Error('Invalid SQLite runtime journal mode');
  }
  return row.journal_mode.toLowerCase();
}

function ensureWalJournalMode(db: DatabaseSync): void {
  const deadline = Date.now() + SQLITE_INITIALIZATION_BUSY_TIMEOUT_MS;
  while (true) {
    try {
      const journalMode = readJournalMode(db);
      if (journalMode === 'wal' || journalMode === 'memory') return;
      db.exec('PRAGMA journal_mode = WAL');
      const configuredMode = readJournalMode(db);
      if (configuredMode !== 'wal') {
        throw new Error(`SQLite runtime requires WAL journal mode, received ${configuredMode}`);
      }
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(
        initializationRetryGate,
        0,
        0,
        Math.min(SQLITE_INITIALIZATION_RETRY_DELAY_MS, Math.max(1, deadline - Date.now())),
      );
    }
  }
}

function isSqliteBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const sqliteError = error as Error & {
    code?: unknown;
    errcode?: unknown;
    errstr?: unknown;
  };
  return (
    sqliteError.errcode === 5 ||
    sqliteError.code === 'SQLITE_BUSY' ||
    sqliteError.errstr === 'database is locked' ||
    /database (?:is )?(?:locked|busy)/i.test(sqliteError.message)
  );
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the migration failure that triggered rollback.
  }
}
