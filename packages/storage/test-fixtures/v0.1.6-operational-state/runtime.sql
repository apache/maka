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

PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE agent_graph_client_applied_records (
      graph_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      event_time INTEGER NOT NULL CHECK (event_time >= 0),
      PRIMARY KEY(graph_id, record_id)
    );
CREATE TABLE agent_graph_client_operator_projections (
      graph_id TEXT NOT NULL,
      operator_id TEXT NOT NULL,
      snapshot_version TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      materialized_at INTEGER NOT NULL CHECK (materialized_at >= 0),
      PRIMARY KEY(graph_id, operator_id)
    );
CREATE TABLE agent_graph_client_projections (
      graph_id TEXT PRIMARY KEY,
      root_session_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      snapshot_version TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      materialized_at INTEGER NOT NULL CHECK (materialized_at >= 0)
    );
CREATE TABLE agent_graph_client_terminal_activity (
      graph_id TEXT NOT NULL,
      record_id TEXT NOT NULL,
      event_time INTEGER NOT NULL CHECK (event_time >= 0),
      payload_json TEXT NOT NULL,
      PRIMARY KEY(graph_id, record_id)
    );
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
      claimed_at INTEGER NOT NULL, admission_status TEXT NOT NULL DEFAULT 'executing'
      CHECK (admission_status IN ('claimed', 'executing', 'cancelled')), admission_updated_at INTEGER NOT NULL DEFAULT 0
      CHECK (admission_updated_at >= 0), cancellation_reason TEXT,
      UNIQUE(graph_id, intent_id),
      UNIQUE(target_session_id, target_turn_id),
      UNIQUE(target_session_id, target_run_id)
    );
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
CREATE TABLE "agent_graph_supervisor_wake_attempts" (
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
        REFERENCES "agent_graph_supervisor_wakes"(graph_id, wake_id)
        ON DELETE CASCADE
    );
CREATE TABLE "agent_graph_supervisor_wakes" (
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
CREATE TABLE artifact_records (
      storage_key TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      status TEXT NOT NULL CHECK (status IN ('live', 'deleted')),
      relative_path TEXT NOT NULL,
      record_json TEXT NOT NULL
    );
INSERT INTO "artifact_records" VALUES('d4fa51d84e36419fc515a89b2e0aa48f219708ef9c6fd4cdf78d1a3dea98eada','artifact-v016','8774e02b-1cff-4d50-90b8-97f78cceaa2a',100,'live','8774e02b-1cff-4d50-90b8-97f78cceaa2a/artifact-v016-sentinel.txt','{"id":"artifact-v016","sessionId":"8774e02b-1cff-4d50-90b8-97f78cceaa2a","turnId":"turn-v016","createdAt":100,"name":"sentinel.txt","kind":"file","relativePath":"8774e02b-1cff-4d50-90b8-97f78cceaa2a/artifact-v016-sentinel.txt","source":"fixture","status":"live","sizeBytes":15}');
CREATE TABLE automation_authority_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );
INSERT INTO "automation_authority_state" VALUES(1,1);
CREATE TABLE automation_definitions (
      automation_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL CHECK (created_at >= 0),
      status TEXT NOT NULL,
      durable INTEGER NOT NULL CHECK (durable IN (0, 1)),
      record_json TEXT NOT NULL
    );
INSERT INTO "automation_definitions" VALUES('cron-v016','8774e02b-1cff-4d50-90b8-97f78cceaa2a',100,'active',1,'{"id":"cron-v016","kind":"cron","name":"Cron v0.1.6","status":"active","prompt":"preserve cron","sessionId":"8774e02b-1cff-4d50-90b8-97f78cceaa2a","schedule":{"type":"cron","expression":"0 9 * * *"},"createdAt":100,"updatedAt":100,"nextFireAt":10000,"lastFireAt":null,"lastRunId":null,"fireCount":0,"maxFires":null,"expiresAt":null,"lastError":null,"consecutiveFailures":0,"durable":true,"execution":{"cwd":"/workspace/v016","projectId":"project-v016","backend":"fake","llmConnectionSlug":"fake","model":"fake-model","collaborationMode":"agent","orchestrationMode":"default"}}');
CREATE TABLE automation_pending_fires (
      fire_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL UNIQUE,
      target_session_id TEXT NOT NULL,
      admitted_at INTEGER NOT NULL CHECK (admitted_at >= 0),
      record_json TEXT NOT NULL
    );
CREATE TABLE core_agent_run_events (
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      event_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_ts INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, run_id, sequence),
      FOREIGN KEY (session_id, run_id)
        REFERENCES core_agent_runs(session_id, run_id)
        ON DELETE CASCADE
    );
CREATE TABLE core_agent_run_projections (
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      event_json TEXT,
      PRIMARY KEY (session_id, event_type)
    );
CREATE TABLE core_agent_runs (
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, run_id)
    );
CREATE TABLE core_interaction_outcomes (
      request_id TEXT PRIMARY KEY,
      record_json TEXT NOT NULL,
      FOREIGN KEY (request_id)
        REFERENCES core_interaction_requests(request_id)
        ON DELETE CASCADE
    );
CREATE TABLE core_interaction_requests (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      request_kind TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
CREATE TABLE core_message_host_epochs (
      host_epoch TEXT PRIMARY KEY
    );
CREATE TABLE core_message_receipts (
      host_epoch TEXT NOT NULL,
      operation TEXT NOT NULL,
      session_id TEXT NOT NULL,
      operation_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      result_json TEXT NOT NULL,
      PRIMARY KEY (host_epoch, operation, session_id, operation_id),
      FOREIGN KEY (host_epoch)
        REFERENCES core_message_host_epochs(host_epoch)
        ON DELETE CASCADE
    );
CREATE TABLE core_root_source_message_proofs (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      PRIMARY KEY (session_id, message_id),
      FOREIGN KEY (session_id, turn_id)
        REFERENCES core_root_turn_admissions(session_id, turn_id)
        ON DELETE CASCADE
    );
CREATE TABLE core_root_turn_admissions (
      session_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      admitted_at INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, turn_id)
    );
CREATE TABLE core_shell_runs (
      session_id TEXT NOT NULL,
      shell_run_id TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, shell_run_id)
    );
CREATE TABLE headless_task_run_events (
      task_run_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      event_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (task_run_id, sequence)
    );
CREATE TABLE operational_schema_migrations (
        scope TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 0),
        applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
      );
INSERT INTO "operational_schema_migrations" VALUES('runtime',10,1786389172943);
INSERT INTO "operational_schema_migrations" VALUES('session_metadata',21,1786389172943);
INSERT INTO "operational_schema_migrations" VALUES('core_execution',1,1786389172943);
INSERT INTO "operational_schema_migrations" VALUES('workflow',3,1786389172943);
INSERT INTO "operational_schema_migrations" VALUES('usage',3,1786389172943);
INSERT INTO "operational_schema_migrations" VALUES('artifact',1,1786389172943);
INSERT INTO "operational_schema_migrations" VALUES('automation',1,1786389172943);
INSERT INTO "operational_schema_migrations" VALUES('operational',1,1786389172943);
CREATE TABLE project_aliases (
      alias TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE
    );
CREATE TABLE project_locations (
      project_id TEXT NOT NULL,
      path TEXT NOT NULL,
      is_worktree INTEGER NOT NULL CHECK (is_worktree IN (0, 1)),
      last_used_at INTEGER NOT NULL,
      PRIMARY KEY(project_id, path),
      FOREIGN KEY(project_id) REFERENCES projects(project_id) ON DELETE CASCADE
    );
CREATE TABLE projects (
      project_id TEXT PRIMARY KEY,
      identity TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      last_used_at INTEGER NOT NULL,
      archived_at INTEGER
    );
CREATE TABLE runtime_capabilities (
      capability TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version > 0)
    );
INSERT INTO "runtime_capabilities" VALUES('runtime_recovery_authority',1);
INSERT INTO "runtime_capabilities" VALUES('runtime_continuation_authority',1);
INSERT INTO "runtime_capabilities" VALUES('runtime_workspace_version_authority',1);
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
CREATE TABLE runtime_storage_root_binding (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      root_id TEXT NOT NULL CHECK (
        length(root_id) = 64 AND root_id NOT GLOB '*[^0-9a-f]*'
      ),
      protocol_version INTEGER NOT NULL CHECK (protocol_version = 1)
    );
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
      settled_at INTEGER CHECK (settled_at >= 0), turn_id TEXT, run_id TEXT,
      PRIMARY KEY(session_id, entry_id),
      UNIQUE(session_id, request_id),
      FOREIGN KEY(session_id) REFERENCES session_metadata(session_id) ON DELETE CASCADE
    );
INSERT INTO "sandbox_boundary_log" VALUES('8774e02b-1cff-4d50-90b8-97f78cceaa2a','genesis','genesis',NULL,'applied',NULL,0,'{"kind":"managed","profile":{"type":"managed","name":"workspace-write","fileSystem":{"kind":"restricted","entries":[{"kind":"special","access":"write","special":":workspace_roots"},{"kind":"special","access":"write","special":":tmpdir"},{"kind":"special","access":"write","special":":slash_tmp"}]},"network":{"kind":"restricted"}},"revision":0}',NULL,NULL,NULL,1786389172944,1786389172944,NULL,NULL);
CREATE TABLE session_catalog_label_projection (
      session_id TEXT NOT NULL,
      label TEXT NOT NULL,
      activity_at INTEGER NOT NULL CHECK (activity_at >= 0),
      PRIMARY KEY(session_id, label),
      FOREIGN KEY(session_id) REFERENCES session_metadata(session_id) ON DELETE CASCADE
    );
INSERT INTO "session_catalog_label_projection" VALUES('8774e02b-1cff-4d50-90b8-97f78cceaa2a','release-fixture',100);
CREATE TABLE session_catalog_projection (
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
INSERT INTO "session_catalog_projection" VALUES('8774e02b-1cff-4d50-90b8-97f78cceaa2a',100,100,'survives v0.1.6 migration',0,0,NULL);
CREATE TABLE session_catalog_state (
      scope TEXT PRIMARY KEY CHECK (scope = 'catalog'),
      epoch TEXT NOT NULL CHECK (length(epoch) = 32),
      generation INTEGER NOT NULL CHECK (generation >= 0),
      pending_writes INTEGER NOT NULL CHECK (pending_writes >= 0)
    );
INSERT INTO "session_catalog_state" VALUES('catalog','d7bd81e750ea242343c9aae8f881b4fa',2,0);
CREATE TABLE session_create_claims (
      session_id TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      claimed_at INTEGER NOT NULL CHECK (claimed_at >= 0)
    );
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
INSERT INTO "session_messages" VALUES('8774e02b-1cff-4d50-90b8-97f78cceaa2a',0,'message-v016','user',100,'{"type":"user","id":"message-v016","turnId":"turn-v016","ts":100,"text":"survives v0.1.6 migration"}');
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
    , subagent_parent_session_id TEXT, subagent_parent_run_id TEXT, subagent_tool_call_id TEXT, subagent_swarm_id TEXT, subagent_item_id TEXT, subagent_request_fingerprint TEXT, subagent_initial_turn_id TEXT, subagent_initial_run_id TEXT);
INSERT INTO "session_metadata" VALUES('8774e02b-1cff-4d50-90b8-97f78cceaa2a','{"id":"8774e02b-1cff-4d50-90b8-97f78cceaa2a","workspaceRoot":"/tmp/maka-v016-fixture.McBvWd/generated/state","cwd":"/workspace/v016","projectId":"project-v016","createdAt":1786389172944,"lastUsedAt":1786389172944,"name":"v0.1.6 fixture","titleIsManual":false,"isFlagged":false,"labels":["release-fixture"],"isArchived":false,"status":"active","statusUpdatedAt":1786389172944,"hasUnread":false,"backend":"fake","llmConnectionSlug":"fake","connectionLocked":false,"model":"fake-model","permissionMode":"ask","collaborationMode":"agent","orchestrationMode":"default","schemaVersion":1,"lastMessageAt":100}',1786389172944,1786389172944,100,'v0.1.6 fixture',0,0,'active',1786389172944,NULL,NULL,NULL,0,'fake','fake','fake-model',2,1786389172946,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
CREATE TABLE session_metadata_labels (
      session_id TEXT NOT NULL,
      label_index INTEGER NOT NULL CHECK (label_index >= 0),
      label TEXT NOT NULL,
      PRIMARY KEY(session_id, label_index),
      FOREIGN KEY(session_id) REFERENCES session_metadata(session_id) ON DELETE CASCADE
    );
INSERT INTO "session_metadata_labels" VALUES('8774e02b-1cff-4d50-90b8-97f78cceaa2a',0,'release-fixture');
CREATE TABLE session_metadata_schema (
      scope TEXT PRIMARY KEY,
      version INTEGER NOT NULL CHECK (version >= 0)
    );
INSERT INTO "session_metadata_schema" VALUES('session_metadata',21);
CREATE TABLE session_metadata_tombstones (
      session_id TEXT PRIMARY KEY,
      deleted_at INTEGER NOT NULL
    , retirement_unit_id TEXT, cleanup_pending INTEGER NOT NULL DEFAULT 0
      CHECK (cleanup_pending IN (0, 1)));
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
      version INTEGER NOT NULL CHECK (version > 0), dispatch_event_id TEXT
      REFERENCES runtime_events(event_id),
      FOREIGN KEY(call_event_id) REFERENCES runtime_events(event_id),
      FOREIGN KEY(result_event_id) REFERENCES runtime_events(event_id),
      UNIQUE(invocation_id, provider_tool_call_id)
    );
CREATE TABLE usage_llm_calls (
      storage_key TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      ts INTEGER NOT NULL CHECK (ts >= 0),
      record_json TEXT NOT NULL
    );
CREATE TABLE usage_model_call_attempts (
      attempt_id TEXT PRIMARY KEY,
      completed_at INTEGER NOT NULL CHECK (completed_at >= 0),
      record_json TEXT NOT NULL
    );
CREATE TABLE usage_model_call_reprojection (
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      marked_at INTEGER NOT NULL CHECK (marked_at >= 0),
      PRIMARY KEY (session_id, run_id)
    );
CREATE TABLE usage_pricing_authority (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );
INSERT INTO "usage_pricing_authority" VALUES(1,0);
CREATE TABLE usage_pricing_overrides (
      model_key TEXT PRIMARY KEY,
      record_json TEXT NOT NULL
    );
CREATE TABLE usage_tool_invocations (
      storage_key TEXT PRIMARY KEY,
      id TEXT NOT NULL,
      ts INTEGER NOT NULL CHECK (ts >= 0),
      record_json TEXT NOT NULL
    );
CREATE TABLE workflow_daily_review_archives (
      archive_id TEXT PRIMARY KEY,
      generated_at INTEGER NOT NULL,
      day_from_ms INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
CREATE TABLE workflow_daily_review_authority_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      revision INTEGER NOT NULL CHECK (revision >= 0)
    );
CREATE TABLE workflow_daily_review_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      config_json TEXT NOT NULL
    );
CREATE TABLE workflow_deep_research_events (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      event_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence),
      UNIQUE (session_id, event_id)
    );
CREATE TABLE workflow_plan_events (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      event_id TEXT NOT NULL,
      store_version INTEGER NOT NULL CHECK (store_version > 0),
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence),
      UNIQUE (session_id, event_id),
      UNIQUE (session_id, store_version)
    );
CREATE TABLE workflow_plan_projections (
      session_id TEXT PRIMARY KEY,
      store_version INTEGER NOT NULL CHECK (store_version >= 0),
      record_json TEXT NOT NULL
    );
CREATE TABLE workflow_plan_reminders (
      reminder_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
INSERT INTO "workflow_plan_reminders" VALUES('60999192-d3b2-45b6-affb-e76355d4cf85',100,100,'{"id":"60999192-d3b2-45b6-affb-e76355d4cf85","title":"Reminder v0.1.6","note":"preserve reminder","schedule":{"kind":"once","runAt":10000},"delivery":{"channel":"local"},"status":"scheduled","enabled":true,"createdAt":100,"updatedAt":100,"nextRunAt":10000,"runs":[],"runCount":0}');
CREATE TABLE workflow_quote_companion_cleanup (
      session_id TEXT PRIMARY KEY,
      tracked_at INTEGER NOT NULL
    );
CREATE TABLE workflow_task_ledger_events (
      session_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      event_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY (session_id, sequence),
      UNIQUE (session_id, event_id)
    );
CREATE TABLE workflow_task_ledger_projections (
      session_id TEXT PRIMARY KEY,
      record_json TEXT NOT NULL
    );
CREATE INDEX runtime_events_by_run
      ON runtime_events(session_id, run_id, event_seq);
CREATE INDEX runtime_events_by_session
      ON runtime_events(session_id, committed_at, event_id);
CREATE INDEX tool_journal_events_by_operation
      ON tool_journal_events(operation_id, journal_seq);
CREATE INDEX runtime_partial_snapshots_by_run
      ON runtime_partial_snapshots(session_id, run_id, updated_at, stream_key);
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
CREATE INDEX session_metadata_labels_by_label
      ON session_metadata_labels(label, session_id);
CREATE INDEX session_metadata_by_subagent_parent
      ON session_metadata(subagent_parent_session_id, session_id);
CREATE INDEX agent_graph_intent_claims_by_graph
      ON agent_graph_intent_claims(graph_id, claimed_at, intent_id);
CREATE INDEX agent_graph_schedule_updates_by_graph
      ON agent_graph_schedule_updates(graph_id, committed_at, update_id);
CREATE INDEX agent_graph_operator_provisions_by_graph
      ON agent_graph_operator_provisions(graph_id, provisioned_at, operator_id);
CREATE INDEX agent_graph_client_terminal_activity_page
      ON agent_graph_client_terminal_activity(
        graph_id,
        event_time DESC,
        record_id DESC
      );
CREATE UNIQUE INDEX sandbox_boundary_log_applied_revision
      ON sandbox_boundary_log(session_id, applied_revision)
      WHERE applied_revision IS NOT NULL;
CREATE INDEX sandbox_boundary_log_pending_requests
      ON sandbox_boundary_log(session_id, status, created_at, entry_id);
CREATE INDEX sandbox_boundary_log_settled_closures
      ON sandbox_boundary_log(session_id, outcome_reason, created_at, entry_id)
      WHERE outcome_reason IS NOT NULL;
CREATE INDEX session_catalog_by_activity
      ON session_catalog_projection(activity_at DESC, session_id ASC);
CREATE INDEX session_catalog_by_archived_activity
      ON session_catalog_projection(is_archived, activity_at DESC, session_id ASC);
CREATE INDEX session_catalog_by_flagged_activity
      ON session_catalog_projection(is_flagged, activity_at DESC, session_id ASC);
CREATE INDEX session_catalog_by_archived_flagged_activity
      ON session_catalog_projection(
        is_archived,
        is_flagged,
        activity_at DESC,
        session_id ASC
      );
CREATE INDEX session_catalog_by_subagent_activity
      ON session_catalog_projection(
        subagent_parent_session_id,
        activity_at DESC,
        session_id ASC
      );
CREATE INDEX session_catalog_labels_by_label_activity
      ON session_catalog_label_projection(label, activity_at DESC, session_id ASC);
CREATE TRIGGER session_catalog_after_insert
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
CREATE TRIGGER session_catalog_after_update
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
CREATE TRIGGER session_catalog_after_delete
    AFTER DELETE ON session_metadata
    BEGIN
      UPDATE session_catalog_state
      SET generation = generation + 1
      WHERE scope = 'catalog';
    END;
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
CREATE INDEX session_metadata_tombstones_by_retirement_unit
      ON session_metadata_tombstones(retirement_unit_id, cleanup_pending, session_id);
CREATE INDEX agent_graph_supervisor_wakes_by_status
      ON agent_graph_supervisor_wakes(status, updated_at, graph_id, wake_id);
CREATE INDEX session_messages_by_identity
      ON session_messages(session_id, message_id);
CREATE INDEX session_messages_by_time
      ON session_messages(session_id, message_ts, sequence);
CREATE INDEX project_aliases_by_project
      ON project_aliases(project_id, alias);
CREATE INDEX core_agent_runs_session_order
      ON core_agent_runs(session_id, created_at, run_id);
CREATE INDEX core_agent_runs_identity
      ON core_agent_runs(run_id, session_id);
CREATE INDEX core_agent_run_events_identity
      ON core_agent_run_events(session_id, run_id, event_id);
CREATE INDEX core_root_turn_admissions_order
      ON core_root_turn_admissions(session_id, admitted_at, turn_id);
CREATE INDEX core_interaction_pending
      ON core_interaction_requests(session_id, created_at, request_id);
CREATE INDEX core_shell_runs_session_order
      ON core_shell_runs(session_id, started_at, shell_run_id);
CREATE INDEX workflow_plan_reminders_order
      ON workflow_plan_reminders(created_at, reminder_id);
CREATE INDEX workflow_daily_review_archives_order
      ON workflow_daily_review_archives(generated_at DESC, day_from_ms DESC, archive_id);
CREATE INDEX usage_llm_calls_ts
      ON usage_llm_calls(ts DESC, id);
CREATE INDEX usage_tool_invocations_ts
      ON usage_tool_invocations(ts DESC, id);
CREATE INDEX usage_model_call_attempts_completed_at
      ON usage_model_call_attempts(completed_at DESC, attempt_id);
CREATE INDEX artifact_records_session_order
      ON artifact_records(session_id, created_at, storage_key);
CREATE UNIQUE INDEX artifact_records_relative_path
      ON artifact_records(relative_path);
CREATE INDEX automation_definitions_session_order
      ON automation_definitions(session_id, created_at, automation_id);
CREATE INDEX automation_definitions_active_schedule
      ON automation_definitions(status, created_at, automation_id);
CREATE INDEX automation_pending_fires_order
      ON automation_pending_fires(admitted_at, fire_id);
DELETE FROM "sqlite_sequence";
COMMIT;
PRAGMA user_version=10;
PRAGMA foreign_keys=ON;
