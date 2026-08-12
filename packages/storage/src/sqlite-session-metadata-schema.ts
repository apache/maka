import type { DatabaseSync } from 'node:sqlite';

export const SQLITE_SESSION_METADATA_SCHEMA_VERSION = 23;
export const SQLITE_SESSION_MESSAGE_CHUNK_BYTES = 64 * 1024;
export const SQLITE_SESSION_MESSAGE_CHUNK_MARKER = '{"$maka":"session-message-chunks-v1"}';

export const SQLITE_AGENT_GRAPH_CONTROL_TABLES = [
  'agent_graph_intent_claims',
  'agent_graph_schedule_updates',
  'agent_graph_operator_provisions',
  'agent_graph_client_projections',
  'agent_graph_client_operator_projections',
  'agent_graph_client_terminal_activity',
  'agent_graph_client_applied_records',
  'agent_graph_supervisor_wakes',
  'agent_graph_supervisor_wake_attempts',
] as const;

const MIGRATIONS: ReadonlyMap<number, string> = new Map([
  [
    1,
    `
    CREATE TABLE session_metadata (
      session_id TEXT PRIMARY KEY,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL,
      last_message_at INTEGER,
      name TEXT NOT NULL,
      is_flagged INTEGER NOT NULL CHECK (is_flagged IN (0, 1)),
      is_archived INTEGER NOT NULL CHECK (is_archived IN (0, 1)),
      status TEXT NOT NULL,
      status_updated_at INTEGER,
      parent_session_id TEXT,
      revision_root_session_id TEXT,
      revision_index INTEGER,
      has_unread INTEGER NOT NULL CHECK (has_unread IN (0, 1)),
      backend TEXT NOT NULL,
      llm_connection_slug TEXT NOT NULL,
      model TEXT NOT NULL,
      metadata_version INTEGER NOT NULL CHECK (metadata_version > 0),
      committed_at INTEGER NOT NULL
    );

    CREATE INDEX session_metadata_by_recency
      ON session_metadata(is_archived, last_message_at DESC, last_used_at DESC, session_id);

    CREATE INDEX session_metadata_by_flag
      ON session_metadata(is_flagged, is_archived, session_id);

    CREATE INDEX session_metadata_by_status
      ON session_metadata(status, status_updated_at DESC, session_id);

    CREATE INDEX session_metadata_by_parent
      ON session_metadata(parent_session_id, session_id);

    CREATE INDEX session_metadata_by_revision
      ON session_metadata(revision_root_session_id, revision_index, session_id);

    CREATE TABLE session_metadata_labels (
      session_id TEXT NOT NULL,
      label_index INTEGER NOT NULL CHECK (label_index >= 0),
      label TEXT NOT NULL,
      PRIMARY KEY(session_id, label_index),
      FOREIGN KEY(session_id) REFERENCES session_metadata(session_id) ON DELETE CASCADE
    );

    CREATE INDEX session_metadata_labels_by_label
      ON session_metadata_labels(label, session_id);

  `,
  ],
  [
    2,
    `
    CREATE TABLE session_metadata_tombstones (
      session_id TEXT PRIMARY KEY,
      deleted_at INTEGER NOT NULL
    );
  `,
  ],
  [
    3,
    `
    ALTER TABLE session_metadata ADD COLUMN subagent_parent_session_id TEXT;

    UPDATE session_metadata
    SET subagent_parent_session_id =
      json_extract(payload_json, '$.subagentParent.parentSessionId')
    WHERE json_type(payload_json, '$.subagentParent.parentSessionId') = 'text';

    CREATE INDEX session_metadata_by_subagent_parent
      ON session_metadata(subagent_parent_session_id, session_id);
  `,
  ],
  [
    4,
    `
    ALTER TABLE session_metadata ADD COLUMN subagent_parent_run_id TEXT;
    ALTER TABLE session_metadata ADD COLUMN subagent_tool_call_id TEXT;
    ALTER TABLE session_metadata ADD COLUMN subagent_swarm_id TEXT;
    ALTER TABLE session_metadata ADD COLUMN subagent_item_id TEXT;
    ALTER TABLE session_metadata ADD COLUMN subagent_request_fingerprint TEXT;
    ALTER TABLE session_metadata ADD COLUMN subagent_initial_turn_id TEXT;
    ALTER TABLE session_metadata ADD COLUMN subagent_initial_run_id TEXT;

    UPDATE session_metadata
    SET
      subagent_parent_run_id =
        json_extract(payload_json, '$.subagentParent.spawnedBy.parentRunId'),
      subagent_tool_call_id =
        json_extract(payload_json, '$.subagentParent.spawnedBy.toolCallId'),
      subagent_swarm_id =
        json_extract(payload_json, '$.subagentParent.swarm.swarmId'),
      subagent_item_id =
        json_extract(payload_json, '$.subagentParent.swarm.itemId'),
      subagent_request_fingerprint =
        json_extract(payload_json, '$.subagentSpawn.requestFingerprint'),
      subagent_initial_turn_id =
        json_extract(payload_json, '$.subagentSpawn.initialTurnId'),
      subagent_initial_run_id =
        json_extract(payload_json, '$.subagentSpawn.initialRunId')
    WHERE subagent_parent_session_id IS NOT NULL;

    CREATE UNIQUE INDEX session_metadata_by_subagent_spawn
      ON session_metadata(
        subagent_parent_session_id,
        subagent_parent_run_id,
        subagent_tool_call_id,
        COALESCE(subagent_swarm_id, ''),
        COALESCE(subagent_item_id, '')
      )
      WHERE
        subagent_parent_session_id IS NOT NULL
        AND subagent_parent_run_id IS NOT NULL
        AND subagent_tool_call_id IS NOT NULL
        AND subagent_request_fingerprint IS NOT NULL;
  `,
  ],
  [
    5,
    `
    CREATE TABLE subagent_spawns (
      parent_session_id TEXT NOT NULL,
      parent_run_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      swarm_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL,
      child_session_id TEXT NOT NULL UNIQUE,
      initial_turn_id TEXT NOT NULL,
      initial_run_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      PRIMARY KEY(parent_session_id, parent_run_id, tool_call_id, swarm_id, item_id)
    );

    INSERT INTO subagent_spawns(
      parent_session_id,
      parent_run_id,
      tool_call_id,
      swarm_id,
      item_id,
      request_fingerprint,
      child_session_id,
      initial_turn_id,
      initial_run_id,
      claimed_at
    )
    SELECT
      subagent_parent_session_id,
      subagent_parent_run_id,
      subagent_tool_call_id,
      COALESCE(subagent_swarm_id, ''),
      COALESCE(subagent_item_id, ''),
      subagent_request_fingerprint,
      session_id,
      subagent_initial_turn_id,
      subagent_initial_run_id,
      committed_at
    FROM session_metadata
    WHERE
      subagent_parent_session_id IS NOT NULL
      AND subagent_parent_run_id IS NOT NULL
      AND subagent_tool_call_id IS NOT NULL
      AND subagent_request_fingerprint IS NOT NULL
      AND subagent_initial_turn_id IS NOT NULL
      AND subagent_initial_run_id IS NOT NULL;

    DROP INDEX session_metadata_by_subagent_spawn;
  `,
  ],
  [
    6,
    `
    CREATE TABLE agent_graph_intent_claims (
      claim_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      graph_id TEXT NOT NULL,
      intent_id TEXT NOT NULL,
      intent_fingerprint TEXT NOT NULL,
      readiness_context_fingerprint TEXT NOT NULL,
      target_operator_id TEXT NOT NULL,
      target_session_id TEXT NOT NULL,
      target_turn_id TEXT NOT NULL,
      target_run_id TEXT NOT NULL,
      claimed_at INTEGER NOT NULL,
      UNIQUE(graph_id, intent_id),
      UNIQUE(target_session_id, target_turn_id),
      UNIQUE(target_session_id, target_run_id)
    );

    CREATE INDEX agent_graph_intent_claims_by_graph
      ON agent_graph_intent_claims(graph_id, claimed_at, intent_id);
  `,
  ],
  [
    7,
    `
    CREATE TABLE agent_graph_schedule_updates (
      graph_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision > 0),
      update_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      update_fingerprint TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      source_run_id TEXT NOT NULL,
      source_turn_id TEXT NOT NULL,
      source_tool_call_id TEXT NOT NULL,
      closes_graph INTEGER NOT NULL CHECK (closes_graph IN (0, 1)),
      payload_json TEXT NOT NULL,
      committed_at INTEGER NOT NULL CHECK (committed_at >= 0),
      PRIMARY KEY(graph_id, revision),
      UNIQUE(source_session_id, source_run_id, source_tool_call_id)
    );

    CREATE INDEX agent_graph_schedule_updates_by_graph
      ON agent_graph_schedule_updates(graph_id, committed_at, update_id);
  `,
  ],
  [
    8,
    `
    ALTER TABLE agent_graph_intent_claims
      ADD COLUMN admission_status TEXT NOT NULL DEFAULT 'executing'
      CHECK (admission_status IN ('claimed', 'executing', 'cancelled'));
    ALTER TABLE agent_graph_intent_claims
      ADD COLUMN admission_updated_at INTEGER NOT NULL DEFAULT 0
      CHECK (admission_updated_at >= 0);
    ALTER TABLE agent_graph_intent_claims
      ADD COLUMN cancellation_reason TEXT;

    UPDATE agent_graph_intent_claims
    SET admission_updated_at = claimed_at;
  `,
  ],
  [
    9,
    `
    CREATE TABLE agent_graph_operator_provisions (
      graph_id TEXT NOT NULL,
      work_id TEXT NOT NULL,
      provision_id TEXT NOT NULL UNIQUE,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      provision_fingerprint TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      target_session_id TEXT NOT NULL UNIQUE,
      payload_json TEXT NOT NULL,
      provisioned_at INTEGER NOT NULL CHECK (provisioned_at >= 0),
      PRIMARY KEY(graph_id, work_id),
      UNIQUE(graph_id, operator_id)
    );

    CREATE INDEX agent_graph_operator_provisions_by_graph
      ON agent_graph_operator_provisions(graph_id, provisioned_at, operator_id);
  `,
  ],
  [
    10,
    `
    CREATE TABLE agent_graph_client_projections (
      graph_id TEXT PRIMARY KEY,
      root_session_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      snapshot_version TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      materialized_at INTEGER NOT NULL CHECK (materialized_at >= 0)
    );

    CREATE TABLE agent_graph_client_operator_projections (
      graph_id TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      snapshot_version TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      materialized_at INTEGER NOT NULL CHECK (materialized_at >= 0),
      PRIMARY KEY(graph_id, operator_id)
    );

    CREATE TABLE agent_graph_client_terminal_activity (
      graph_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      event_time INTEGER NOT NULL CHECK (event_time >= 0),
      payload_json TEXT NOT NULL,
      PRIMARY KEY(graph_id, record_id)
    );

    CREATE TABLE agent_graph_client_applied_records (
      graph_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      event_time INTEGER NOT NULL CHECK (event_time >= 0),
      PRIMARY KEY(graph_id, record_id)
    );

    CREATE INDEX agent_graph_client_terminal_activity_page
      ON agent_graph_client_terminal_activity(
        graph_id,
        event_time DESC,
        record_id DESC
      );
  `,
  ],
  [
    11,
    `
    CREATE TABLE agent_graph_supervisor_wakes (
      graph_id TEXT NOT NULL,
      wake_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      snapshot_version TEXT NOT NULL,
      root_session_id TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('pending', 'running', 'delivered', 'retryable_failed')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      current_attempt_id TEXT,
      current_turn_id TEXT,
      failure_reason TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY(graph_id, wake_id)
    );

    CREATE TABLE agent_graph_supervisor_wake_attempts (
      graph_id TEXT NOT NULL,
      wake_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('running', 'delivered', 'retryable_failed')),
      failure_reason TEXT,
      started_at INTEGER NOT NULL CHECK (started_at >= 0),
      completed_at INTEGER,
      PRIMARY KEY(graph_id, wake_id, attempt_id),
      FOREIGN KEY(graph_id, wake_id)
        REFERENCES agent_graph_supervisor_wakes(graph_id, wake_id)
        ON DELETE CASCADE
    );

    CREATE INDEX agent_graph_supervisor_wakes_by_status
      ON agent_graph_supervisor_wakes(status, updated_at, graph_id, wake_id);
  `,
  ],
  [
    12,
    `
    DROP INDEX agent_graph_supervisor_wakes_by_status;

    CREATE TABLE agent_graph_supervisor_wakes_v12 (
      graph_id TEXT NOT NULL,
      wake_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      snapshot_version TEXT NOT NULL,
      root_session_id TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (
          status IN (
            'pending',
            'running',
            'waiting_permission',
            'delivered',
            'retryable_failed'
          )
        ),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      current_attempt_id TEXT,
      current_turn_id TEXT,
      failure_reason TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY(graph_id, wake_id)
    );

    CREATE TABLE agent_graph_supervisor_wake_attempts_v12 (
      graph_id TEXT NOT NULL,
      wake_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (
          status IN (
            'running',
            'waiting_permission',
            'delivered',
            'retryable_failed'
          )
        ),
      failure_reason TEXT,
      started_at INTEGER NOT NULL CHECK (started_at >= 0),
      completed_at INTEGER,
      PRIMARY KEY(graph_id, wake_id, attempt_id),
      FOREIGN KEY(graph_id, wake_id)
        REFERENCES agent_graph_supervisor_wakes_v12(graph_id, wake_id)
        ON DELETE CASCADE
    );

    INSERT INTO agent_graph_supervisor_wakes_v12
    SELECT * FROM agent_graph_supervisor_wakes;

    INSERT INTO agent_graph_supervisor_wake_attempts_v12
    SELECT * FROM agent_graph_supervisor_wake_attempts;

    DROP TABLE agent_graph_supervisor_wake_attempts;
    DROP TABLE agent_graph_supervisor_wakes;

    ALTER TABLE agent_graph_supervisor_wakes_v12
      RENAME TO agent_graph_supervisor_wakes;
    ALTER TABLE agent_graph_supervisor_wake_attempts_v12
      RENAME TO agent_graph_supervisor_wake_attempts;

    CREATE INDEX agent_graph_supervisor_wakes_by_status
      ON agent_graph_supervisor_wakes(status, updated_at, graph_id, wake_id);
  `,
  ],
  [
    13,
    `
    CREATE TABLE sandbox_boundary_log (
      session_id TEXT NOT NULL,
      entry_id TEXT NOT NULL,
      entry_kind TEXT NOT NULL
        CHECK (entry_kind IN ('genesis', 'expansion_request', 'user_change')),
      request_id TEXT,
      status TEXT NOT NULL
        CHECK (status IN ('applied', 'pending', 'approved', 'denied', 'conflict')),
      base_revision INTEGER CHECK (base_revision >= 0),
      applied_revision INTEGER CHECK (applied_revision >= 0),
      boundary_json TEXT,
      expansion_json TEXT,
      justification TEXT,
      outcome_reason TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      settled_at INTEGER CHECK (settled_at >= 0),
      PRIMARY KEY(session_id, entry_id),
      UNIQUE(session_id, request_id),
      FOREIGN KEY(session_id) REFERENCES session_metadata(session_id) ON DELETE CASCADE
    );

    CREATE UNIQUE INDEX sandbox_boundary_log_applied_revision
      ON sandbox_boundary_log(session_id, applied_revision)
      WHERE applied_revision IS NOT NULL;

    CREATE INDEX sandbox_boundary_log_pending_requests
      ON sandbox_boundary_log(session_id, status, created_at, entry_id);
  `,
  ],
  [
    14,
    `
    ALTER TABLE sandbox_boundary_log ADD COLUMN turn_id TEXT;
    ALTER TABLE sandbox_boundary_log ADD COLUMN run_id TEXT;

    CREATE INDEX sandbox_boundary_log_settled_closures
      ON sandbox_boundary_log(session_id, outcome_reason, created_at, entry_id)
      WHERE outcome_reason IS NOT NULL;
  `,
  ],
  [
    15,
    `
    CREATE TABLE session_create_claims (
      session_id TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      claimed_at INTEGER NOT NULL CHECK (claimed_at >= 0)
    );
  `,
  ],
  [
    16,
    `
    CREATE TABLE IF NOT EXISTS session_catalog_state (
      scope TEXT PRIMARY KEY CHECK (scope = 'catalog'),
      epoch TEXT NOT NULL CHECK (length(epoch) = 32),
      generation INTEGER NOT NULL CHECK (generation >= 0),
      pending_writes INTEGER NOT NULL CHECK (pending_writes >= 0)
    );

    INSERT OR IGNORE INTO session_catalog_state(scope, epoch, generation, pending_writes)
    SELECT
      'catalog',
      lower(hex(randomblob(16))),
      0,
      CASE WHEN EXISTS (SELECT 1 FROM session_metadata) THEN 1 ELSE 0 END;

    CREATE TABLE IF NOT EXISTS session_catalog_projection (
      session_id TEXT PRIMARY KEY,
      activity_at INTEGER NOT NULL CHECK (activity_at >= 0),
      last_message_at INTEGER,
      last_message_preview TEXT
        CHECK (last_message_preview IS NULL OR length(last_message_preview) <= 96),
      is_archived INTEGER NOT NULL CHECK (is_archived IN (0, 1)),
      is_flagged INTEGER NOT NULL CHECK (is_flagged IN (0, 1)),
      subagent_parent_session_id TEXT,
      FOREIGN KEY(session_id) REFERENCES session_metadata(session_id) ON DELETE CASCADE
    );

    INSERT OR IGNORE INTO session_catalog_projection(
      session_id,
      activity_at,
      last_message_at,
      last_message_preview,
      is_archived,
      is_flagged,
      subagent_parent_session_id
    )
    SELECT
      session_id,
      COALESCE(last_message_at, last_used_at, created_at),
      last_message_at,
      NULL,
      is_archived,
      is_flagged,
      subagent_parent_session_id
    FROM session_metadata;

    CREATE INDEX IF NOT EXISTS session_catalog_by_activity
      ON session_catalog_projection(activity_at DESC, session_id ASC);

    CREATE INDEX IF NOT EXISTS session_catalog_by_archived_activity
      ON session_catalog_projection(is_archived, activity_at DESC, session_id ASC);

    CREATE INDEX IF NOT EXISTS session_catalog_by_flagged_activity
      ON session_catalog_projection(is_flagged, activity_at DESC, session_id ASC);

    CREATE INDEX IF NOT EXISTS session_catalog_by_archived_flagged_activity
      ON session_catalog_projection(
        is_archived,
        is_flagged,
        activity_at DESC,
        session_id ASC
      );

    CREATE INDEX IF NOT EXISTS session_catalog_by_subagent_activity
      ON session_catalog_projection(
        subagent_parent_session_id,
        activity_at DESC,
        session_id ASC
      );

    CREATE TABLE IF NOT EXISTS session_catalog_label_projection (
      session_id TEXT NOT NULL,
      label TEXT NOT NULL,
      activity_at INTEGER NOT NULL CHECK (activity_at >= 0),
      PRIMARY KEY(session_id, label),
      FOREIGN KEY(session_id) REFERENCES session_metadata(session_id) ON DELETE CASCADE
    );

    INSERT OR IGNORE INTO session_catalog_label_projection(session_id, label, activity_at)
    SELECT labels.session_id, labels.label, projection.activity_at
    FROM session_metadata_labels labels
    JOIN session_catalog_projection projection
      ON projection.session_id = labels.session_id;

    CREATE INDEX IF NOT EXISTS session_catalog_labels_by_label_activity
      ON session_catalog_label_projection(label, activity_at DESC, session_id ASC);

    CREATE TRIGGER IF NOT EXISTS session_catalog_after_insert
    AFTER INSERT ON session_metadata
    BEGIN
      INSERT INTO session_catalog_projection(
        session_id,
        activity_at,
        last_message_at,
        last_message_preview,
        is_archived,
        is_flagged,
        subagent_parent_session_id
      ) VALUES (
        NEW.session_id,
        COALESCE(NEW.last_message_at, NEW.last_used_at, NEW.created_at),
        NEW.last_message_at,
        NULL,
        NEW.is_archived,
        NEW.is_flagged,
        NEW.subagent_parent_session_id
      );

      UPDATE session_catalog_state
      SET generation = generation + 1
      WHERE scope = 'catalog';
    END;

    CREATE TRIGGER IF NOT EXISTS session_catalog_after_update
    AFTER UPDATE ON session_metadata
    BEGIN
      UPDATE session_catalog_projection
      SET
        activity_at = COALESCE(NEW.last_message_at, NEW.last_used_at, NEW.created_at),
        last_message_at = NEW.last_message_at,
        is_archived = NEW.is_archived,
        is_flagged = NEW.is_flagged,
        subagent_parent_session_id = NEW.subagent_parent_session_id
      WHERE session_id = NEW.session_id;

      UPDATE session_catalog_label_projection
      SET activity_at = COALESCE(NEW.last_message_at, NEW.last_used_at, NEW.created_at)
      WHERE session_id = NEW.session_id;

      UPDATE session_catalog_state
      SET generation = generation + 1
      WHERE scope = 'catalog';
    END;

    CREATE TRIGGER IF NOT EXISTS session_catalog_after_delete
    AFTER DELETE ON session_metadata
    BEGIN
      UPDATE session_catalog_state
      SET generation = generation + 1
      WHERE scope = 'catalog';
    END;

    CREATE TRIGGER IF NOT EXISTS session_catalog_label_after_insert
    AFTER INSERT ON session_metadata_labels
    BEGIN
      INSERT OR IGNORE INTO session_catalog_label_projection(session_id, label, activity_at)
      SELECT NEW.session_id, NEW.label, projection.activity_at
      FROM session_catalog_projection projection
      WHERE projection.session_id = NEW.session_id;

      UPDATE session_catalog_state
      SET generation = generation + 1
      WHERE scope = 'catalog';
    END;

    CREATE TRIGGER IF NOT EXISTS session_catalog_label_after_delete
    AFTER DELETE ON session_metadata_labels
    BEGIN
      DELETE FROM session_catalog_label_projection
      WHERE
        session_id = OLD.session_id
        AND label = OLD.label
        AND NOT EXISTS (
          SELECT 1
          FROM session_metadata_labels labels
          WHERE labels.session_id = OLD.session_id
            AND labels.label = OLD.label
        );

      UPDATE session_catalog_state
      SET generation = generation + 1
      WHERE scope = 'catalog';
    END;
  `,
  ],
  [
    17,
    `
    DROP TRIGGER IF EXISTS session_catalog_label_after_insert;
    DROP TRIGGER IF EXISTS session_catalog_label_after_delete;

    CREATE TRIGGER session_catalog_label_after_insert
    AFTER INSERT ON session_metadata_labels
    BEGIN
      INSERT OR IGNORE INTO session_catalog_label_projection(session_id, label, activity_at)
      SELECT NEW.session_id, NEW.label, projection.activity_at
      FROM session_catalog_projection projection
      WHERE projection.session_id = NEW.session_id;
    END;

    CREATE TRIGGER session_catalog_label_after_delete
    AFTER DELETE ON session_metadata_labels
    BEGIN
      DELETE FROM session_catalog_label_projection
      WHERE
        session_id = OLD.session_id
        AND label = OLD.label
        AND NOT EXISTS (
          SELECT 1
          FROM session_metadata_labels labels
          WHERE labels.session_id = OLD.session_id
            AND labels.label = OLD.label
        );
    END;
  `,
  ],
  [
    18,
    `
    ALTER TABLE session_metadata_tombstones ADD COLUMN retirement_unit_id TEXT;
    ALTER TABLE session_metadata_tombstones
      ADD COLUMN cleanup_pending INTEGER NOT NULL DEFAULT 0
      CHECK (cleanup_pending IN (0, 1));

    UPDATE session_metadata_tombstones
    SET retirement_unit_id = session_id, cleanup_pending = 1;

    CREATE INDEX session_metadata_tombstones_by_retirement_unit
      ON session_metadata_tombstones(retirement_unit_id, cleanup_pending, session_id);
  `,
  ],
  [
    19,
    `
    DROP INDEX agent_graph_supervisor_wakes_by_status;

    CREATE TABLE agent_graph_supervisor_wakes_v19 (
      graph_id TEXT NOT NULL,
      wake_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      snapshot_version TEXT NOT NULL,
      root_session_id TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (
          status IN (
            'pending',
            'running',
            'waiting_permission',
            'delivered',
            'superseded',
            'retryable_failed'
          )
        ),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
      current_attempt_id TEXT,
      current_turn_id TEXT,
      failure_reason TEXT,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
      PRIMARY KEY(graph_id, wake_id)
    );

    CREATE TABLE agent_graph_supervisor_wake_attempts_v19 (
      graph_id TEXT NOT NULL,
      wake_id TEXT NOT NULL,
      attempt_id TEXT NOT NULL UNIQUE,
      turn_id TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (
          status IN (
            'running',
            'waiting_permission',
            'delivered',
            'superseded',
            'retryable_failed'
          )
        ),
      failure_reason TEXT,
      started_at INTEGER NOT NULL CHECK (started_at >= 0),
      completed_at INTEGER,
      PRIMARY KEY(graph_id, wake_id, attempt_id),
      FOREIGN KEY(graph_id, wake_id)
        REFERENCES agent_graph_supervisor_wakes_v19(graph_id, wake_id)
        ON DELETE CASCADE
    );

    INSERT INTO agent_graph_supervisor_wakes_v19
    SELECT * FROM agent_graph_supervisor_wakes;

    INSERT INTO agent_graph_supervisor_wake_attempts_v19
    SELECT * FROM agent_graph_supervisor_wake_attempts;

    DROP TABLE agent_graph_supervisor_wake_attempts;
    DROP TABLE agent_graph_supervisor_wakes;

    ALTER TABLE agent_graph_supervisor_wakes_v19
      RENAME TO agent_graph_supervisor_wakes;
    ALTER TABLE agent_graph_supervisor_wake_attempts_v19
      RENAME TO agent_graph_supervisor_wake_attempts;

    CREATE INDEX agent_graph_supervisor_wakes_by_status
      ON agent_graph_supervisor_wakes(status, updated_at, graph_id, wake_id);
  `,
  ],
  [
    20,
    `
    CREATE TABLE session_messages (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      message_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      message_ts INTEGER NOT NULL CHECK (message_ts >= 0),
      record_json TEXT NOT NULL,
      PRIMARY KEY(session_id, sequence),
      FOREIGN KEY(session_id) REFERENCES session_metadata(session_id) ON DELETE CASCADE
    );

    CREATE INDEX session_messages_by_identity
      ON session_messages(session_id, message_id);

    CREATE INDEX session_messages_by_time
      ON session_messages(session_id, message_ts, sequence);
  `,
  ],
  [
    21,
    `
    CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      identity TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      last_used_at INTEGER NOT NULL,
      archived_at INTEGER
    );

    CREATE TABLE project_locations (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      is_worktree INTEGER NOT NULL CHECK (is_worktree IN (0, 1)),
      last_used_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, path),
      FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE
    );

    CREATE TABLE project_aliases (
      alias TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE
    );

    CREATE INDEX project_aliases_by_project
      ON project_aliases(project_id, alias);
  `,
  ],
  [
    22,
    `
    UPDATE session_metadata
    SET
      payload_json = json_set(payload_json, '$.connectionLocked', json('true')),
      metadata_version = metadata_version + 1,
      committed_at = MAX(
        committed_at,
        CAST(strftime('%s', 'now') AS INTEGER) * 1000
      )
    WHERE
      json_extract(payload_json, '$.connectionLocked') = 0
      AND EXISTS (
        SELECT 1
        FROM session_messages messages
        WHERE
          messages.session_id = session_metadata.session_id
          AND messages.message_type = 'user'
      );
  `,
  ],
  [
    23,
    `
    CREATE TABLE session_message_payloads (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      record_bytes INTEGER NOT NULL CHECK (record_bytes > ${SQLITE_SESSION_MESSAGE_CHUNK_BYTES}),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      PRIMARY KEY(session_id, sequence),
      FOREIGN KEY(session_id, sequence)
        REFERENCES session_messages(session_id, sequence)
        ON DELETE CASCADE
    ) WITHOUT ROWID;

    CREATE TABLE session_message_chunks (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
      data BLOB NOT NULL CHECK (length(data) BETWEEN 1 AND ${SQLITE_SESSION_MESSAGE_CHUNK_BYTES}),
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      PRIMARY KEY(session_id, sequence, chunk_index),
      FOREIGN KEY(session_id, sequence)
        REFERENCES session_message_payloads(session_id, sequence)
        ON DELETE CASCADE
    ) WITHOUT ROWID;

  `,
  ],
]);

export function configureSqliteSessionMetadataDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
}

export function migrateSqliteSessionMetadataDatabase(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_metadata_schema (
      scope TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version >= 0)
    )
  `);
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = readSqliteSessionMetadataSchemaVersion(db);
    if (current > SQLITE_SESSION_METADATA_SCHEMA_VERSION) {
      throw new Error(
        `SQLite session metadata schema ${current} is newer than supported version ${SQLITE_SESSION_METADATA_SCHEMA_VERSION}`,
      );
    }
    for (
      let version = current + 1;
      version <= SQLITE_SESSION_METADATA_SCHEMA_VERSION;
      version += 1
    ) {
      const sql = MIGRATIONS.get(version);
      if (!sql) throw new Error(`Missing SQLite session metadata migration ${version}`);
      db.exec(sql);
      db.prepare(`
        INSERT INTO session_metadata_schema(scope, version)
        VALUES ('session_metadata', ?)
        ON CONFLICT(scope) DO UPDATE SET version = excluded.version
      `).run(version);
    }
    db.exec('COMMIT');
  } catch (error) {
    rollback(db);
    throw error;
  }
}

export function readSqliteSessionMetadataSchemaVersion(db: DatabaseSync): number {
  const row = db
    .prepare(`
      SELECT version
      FROM session_metadata_schema
      WHERE scope = 'session_metadata'
    `)
    .get() as { version?: unknown } | undefined;
  if (!row) return 0;
  const value = row.version;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Invalid SQLite session metadata schema version');
  }
  return value;
}

function rollback(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Preserve the migration failure that triggered rollback.
  }
}
