-- Licensed to the Apache Software Foundation (ASF) under one
-- or more contributor license agreements.  See the NOTICE file
-- distributed with this work for additional information
-- regarding copyright ownership.  The ASF licenses this file
-- to you under the Apache License, Version 2.0 (the
-- "License"); you may not use this file except in compliance
-- with the License.  You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing,
-- software distributed under the License is distributed on an
-- "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
-- KIND, either express or implied.  See the License for the
-- specific language governing permissions and limitations
-- under the License.

CREATE TABLE discovery_dossiers (
    owner TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    title TEXT NOT NULL,
    signal TEXT NOT NULL CHECK(signal IN ('red','yellow','green','done')),
    priority_weight REAL NOT NULL DEFAULT 0.0,
    window_at INTEGER,
    revision INTEGER NOT NULL DEFAULT 1,
    summary_md TEXT NOT NULL,
    artifacts_json TEXT NOT NULL DEFAULT '[]',
    linked_task_ids_json TEXT NOT NULL DEFAULT '[]',
    thread_session_id TEXT REFERENCES session_control(id) ON DELETE SET NULL,
    muted INTEGER NOT NULL DEFAULT 0 CHECK(muted IN (0,1)),
    last_checked_at INTEGER NOT NULL,
    last_material_change_at INTEGER NOT NULL,
    last_notified_revision INTEGER NOT NULL DEFAULT 0,
    last_interrupt_reason TEXT,
    last_interrupt_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, topic_id)
) WITHOUT ROWID;

CREATE INDEX discovery_dossiers_priority
    ON discovery_dossiers(owner, signal, priority_weight DESC, last_material_change_at DESC);
CREATE UNIQUE INDEX discovery_dossiers_thread
    ON discovery_dossiers(thread_session_id) WHERE thread_session_id IS NOT NULL;
CREATE INDEX discovery_dossiers_interrupt
    ON discovery_dossiers(owner, last_interrupt_at DESC) WHERE last_interrupt_at IS NOT NULL;

CREATE TABLE discovery_source_cursors (
    owner TEXT NOT NULL,
    source_uri TEXT NOT NULL,
    last_mtime_ms INTEGER NOT NULL DEFAULT 0,
    last_hash TEXT,
    write_burst_count INTEGER NOT NULL DEFAULT 0,
    cooldown_until INTEGER NOT NULL DEFAULT 0,
    last_explored_at INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, source_uri)
) WITHOUT ROWID;

CREATE INDEX discovery_source_cursors_explored ON discovery_source_cursors(owner, last_explored_at ASC);

CREATE TABLE discovery_watches (
    owner TEXT NOT NULL,
    watch_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('file_hash','http_check','deadline')),
    target TEXT NOT NULL,
    predicate_json TEXT NOT NULL,
    on_trigger TEXT NOT NULL CHECK(on_trigger IN ('notify_direct','invalidate_action','enqueue_followup')),
    last_state_hash TEXT,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, watch_id),
    FOREIGN KEY (owner, topic_id) REFERENCES discovery_dossiers(owner, topic_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX discovery_watches_topic ON discovery_watches(owner, topic_id);

CREATE TABLE discovery_pending_actions (
    owner TEXT NOT NULL,
    action_id TEXT NOT NULL,
    topic_id TEXT NOT NULL,
    connector_tool TEXT NOT NULL,
    params_json TEXT NOT NULL,
    input_hashes_json TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('awaiting_confirm','stale','executing','done','unknown_pending_receipt')),
    receipt_json TEXT,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (owner, action_id),
    UNIQUE (owner, idempotency_key),
    FOREIGN KEY (owner, topic_id) REFERENCES discovery_dossiers(owner, topic_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE INDEX discovery_pending_actions_topic ON discovery_pending_actions(owner, topic_id);

CREATE TABLE discovery_preferences (
    owner TEXT PRIMARY KEY,
    notifications_enabled INTEGER NOT NULL DEFAULT 1 CHECK(notifications_enabled IN (0,1)),
    updated_at INTEGER NOT NULL
) WITHOUT ROWID;
