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

-- Current initial schema. Canonical writes maintain durable projections atomically.

CREATE TABLE event_log (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT CHECK(sequence > 0),
    event_id TEXT NOT NULL UNIQUE,
    invocation_id TEXT,
    kind TEXT NOT NULL,
    operation_id TEXT,
    -- Keep compact accounting fields before potentially large JSON overflow
    -- pages. SQLite derives them from canonical bytes; they cannot be edited.
    accounting_at REAL GENERATED ALWAYS AS (
        CASE WHEN kind IN ('model_requested', 'model_completed', 'model_interrupted',
                           'invocation_ended', 'auxiliary_model_started', 'auxiliary_model_settled',
                           'tool_dispatched', 'tool_settled', 'tool_rejected')
        THEN COALESCE(json_extract(COALESCE(event_json, retained_json), '$.recorded_at.secs_since_epoch'),
                      json_extract(COALESCE(event_json, retained_json), '$.started_at.secs_since_epoch'),
                      json_extract(COALESCE(event_json, retained_json), '$.completed_at.secs_since_epoch')) * 1000.0
            + COALESCE(json_extract(COALESCE(event_json, retained_json), '$.recorded_at.nanos_since_epoch'),
                       json_extract(COALESCE(event_json, retained_json), '$.started_at.nanos_since_epoch'),
                       json_extract(COALESCE(event_json, retained_json), '$.completed_at.nanos_since_epoch')) / 1000000.0
        END
    ) STORED,
    accounting_usage TEXT GENERATED ALWAYS AS (
        CASE
            WHEN kind = 'model_completed' THEN json_extract(COALESCE(event_json, retained_json), '$.fact.output.usage')
            WHEN kind = 'model_observed' AND json_extract(COALESCE(event_json, retained_json), '$.fact.event.kind') = 'finished'
                THEN json_extract(COALESCE(event_json, retained_json), '$.fact.event.data.usage')
            WHEN kind = 'auxiliary_model_usage' THEN json_extract(COALESCE(event_json, retained_json), '$.usage')
        END
    ) STORED,
    invocation_model TEXT GENERATED ALWAYS AS (
        CASE WHEN kind = 'invocation_opened' THEN json_extract(COALESCE(event_json, retained_json), '$.fact.configuration.model') END
    ) STORED,
    accounting_tool TEXT GENERATED ALWAYS AS (
        CASE
            WHEN kind IN ('tool_dispatched', 'tool_rejected') THEN json_object(
                'invocation', json_extract(COALESCE(event_json, retained_json), '$.invocation'),
                'call', json_extract(COALESCE(event_json, retained_json), '$.fact.call'),
                'name', json_extract(COALESCE(event_json, retained_json), '$.fact.name'),
                'rejection', json_extract(COALESCE(event_json, retained_json), '$.fact.reason.kind'))
            WHEN kind = 'tool_settled' THEN json_object(
                'outcome', json_extract(COALESCE(event_json, retained_json), '$.fact.outcome.kind'))
        END
    ) STORED,
    event_json TEXT,
    -- A collected body is absent, never a synthetic replayable RuntimeEvent.
    retained_json TEXT CHECK(retained_json IS NULL OR json_valid(retained_json)),
    body_digest TEXT,
    event_session TEXT GENERATED ALWAYS AS (
        json_extract(COALESCE(event_json, retained_json), '$.invocation.session_id')
    ) STORED,
    CHECK((event_json IS NOT NULL AND retained_json IS NULL AND body_digest IS NULL)
       OR (event_json IS NULL AND retained_json IS NOT NULL AND body_digest IS NOT NULL)),
    CHECK(invocation_id IS NOT NULL OR operation_id IS NULL)
);

CREATE TABLE session_control (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived INTEGER NOT NULL CHECK(archived IN (0, 1)),
    configuration TEXT NOT NULL
);

CREATE TABLE session_catalog_revision (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    revision INTEGER NOT NULL CHECK(revision >= 0)
);

CREATE TABLE session_imports (
    session_id TEXT PRIMARY KEY,
    source_json TEXT NOT NULL CHECK(json_valid(source_json)),
    configuration TEXT NOT NULL CHECK(json_valid(configuration)),
    created_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('collecting','published','abandoned')),
    records INTEGER NOT NULL CHECK(records >= 0),
    bytes INTEGER NOT NULL CHECK(bytes >= 0),
    conversation INTEGER NOT NULL CHECK(conversation BETWEEN 0 AND records)
);

CREATE TABLE session_retirements (
    session_id TEXT PRIMARY KEY,
    remove_session INTEGER NOT NULL DEFAULT 1 CHECK(remove_session IN (0, 1)),
    completed INTEGER NOT NULL DEFAULT 0 CHECK(completed IN (0, 1))
);

CREATE TABLE session_removal_receipts (
    session_id TEXT PRIMARY KEY,
    plan_json TEXT NOT NULL
);

CREATE TABLE session_processes (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    cleaned INTEGER NOT NULL DEFAULT 0 CHECK(cleaned IN (0, 1))
);

CREATE TABLE session_read_state (
    session_id TEXT PRIMARY KEY REFERENCES session_control(id),
    has_unread INTEGER NOT NULL CHECK(has_unread IN (0, 1)),
    last_read_message_id TEXT
);

CREATE TABLE artifact_catalog (
    session_id TEXT PRIMARY KEY REFERENCES session_control(id),
    revision INTEGER NOT NULL CHECK(revision > 0 AND revision <= 9007199254740991)
);

CREATE TABLE message_admissions (
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    position INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY(session_id, message_id)
);

CREATE TABLE message_queue_state (
    session_id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK(revision >= 0)
);

CREATE TABLE message_cancellations (
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    cancellation_id TEXT NOT NULL,
    PRIMARY KEY(session_id, message_id)
);

CREATE TABLE queue_command_receipts (
    host_epoch TEXT NOT NULL,
    session_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    command_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    PRIMARY KEY(host_epoch, session_id, operation, command_id)
);

CREATE TABLE message_submit_receipts (
    host_epoch TEXT NOT NULL,
    session_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    PRIMARY KEY(host_epoch, session_id, message_id)
);

CREATE TABLE message_interrupt_receipts (
    host_epoch TEXT NOT NULL,
    session_id TEXT NOT NULL,
    interrupt_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    fence_json TEXT,
    PRIMARY KEY(host_epoch, session_id, interrupt_id)
);

CREATE TABLE "tool_result_payloads" (
    event_id TEXT PRIMARY KEY NOT NULL REFERENCES event_log(event_id),
    payload BLOB NOT NULL CHECK(length(payload) <= 67108864)
);

CREATE TABLE session_history_copies (
    session_id TEXT PRIMARY KEY,
    source_session_id TEXT NOT NULL,
    source_revision INTEGER NOT NULL CHECK(source_revision > 0),
    through_sequence INTEGER NOT NULL CHECK(through_sequence >= 0),
    observed_through INTEGER NOT NULL CHECK(observed_through >= through_sequence),
    request_json TEXT NOT NULL,
    lineage_json TEXT NOT NULL CHECK(json_valid(lineage_json)),
    state TEXT NOT NULL CHECK(state IN ('preparing', 'committed', 'abandoned')), bundle_digest TEXT
    CHECK(bundle_digest IS NULL OR length(bundle_digest)=71),
    CHECK(state = 'committed' OR json_extract(lineage_json, '$.kind') = 'revision'),
    CHECK(session_id != source_session_id)
);

CREATE TABLE session_history_members (
    session_id TEXT NOT NULL REFERENCES session_history_copies(session_id),
    sequence INTEGER NOT NULL REFERENCES event_log(sequence),
    archive_sequence INTEGER REFERENCES event_log(sequence),
    PRIMARY KEY(session_id, sequence)
);

CREATE TABLE session_revision_sources (
    session_id TEXT NOT NULL REFERENCES session_history_copies(session_id),
    sequence INTEGER NOT NULL REFERENCES event_log(sequence),
    PRIMARY KEY(session_id, sequence)
);

CREATE TABLE model_accounting (
    request_id TEXT PRIMARY KEY REFERENCES event_log(event_id),
    quote_json TEXT NOT NULL CHECK(json_valid(quote_json) AND length(CAST(quote_json AS BLOB)) <= 8192)
);

CREATE TABLE model_valuations (
    request_id TEXT PRIMARY KEY REFERENCES model_accounting(request_id),
    usage_json TEXT NOT NULL CHECK(json_valid(usage_json)),
    usd REAL CHECK(usd IS NULL OR usd >= 0)
);

CREATE TABLE plugin_composition (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    ledger_json TEXT NOT NULL CHECK (json_valid(ledger_json))
);

CREATE TABLE plugin_package_blobs (
    digest TEXT PRIMARY KEY
);

CREATE TABLE plugin_package_files (
    digest TEXT NOT NULL REFERENCES plugin_package_blobs(digest) ON DELETE CASCADE,
    path TEXT NOT NULL,
    payload BLOB NOT NULL,
    PRIMARY KEY (digest, path)
);

CREATE TABLE plugin_packages (
    id TEXT PRIMARY KEY,
    digest TEXT NOT NULL REFERENCES plugin_package_blobs(digest)
);

CREATE TABLE plugin_data (
    package_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
    PRIMARY KEY (package_id, scope_id, key)
);

CREATE TABLE request_compositions (
    digest TEXT PRIMARY KEY NOT NULL,
    surface BLOB NOT NULL CHECK(length(surface) <= 4194304)
);

CREATE TABLE model_request_compositions (
    event_id TEXT PRIMARY KEY NOT NULL REFERENCES event_log(event_id),
    digest TEXT NOT NULL REFERENCES request_compositions(digest)
);

CREATE TABLE plugin_sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    package_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    managed INTEGER NOT NULL CHECK(managed IN (0, 1)),
    authority_session_id TEXT,
    CHECK(authority_session_id IS NULL OR authority_session_id != session_id)
);

CREATE TABLE host_effects (
    id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    request TEXT NOT NULL CHECK(json_valid(request) AND length(CAST(request AS BLOB)) <= 8388608),
    outcome TEXT CHECK(outcome IS NULL OR (json_valid(outcome) AND length(CAST(outcome AS BLOB)) <= 8388608)),
    payload BLOB CHECK(payload IS NULL OR length(payload) <= 5242880),
    CHECK(outcome IS NOT NULL OR payload IS NULL)
) STRICT;

CREATE TABLE message_sources (
    session_id TEXT NOT NULL, message_id TEXT NOT NULL, event_id TEXT NOT NULL,
    PRIMARY KEY(session_id, message_id)
);

CREATE TABLE catalog_messages (
    sequence INTEGER NOT NULL, ordinal INTEGER NOT NULL, session_id TEXT NOT NULL,
    message_at INTEGER NOT NULL, preview TEXT, message_id TEXT NOT NULL,
    PRIMARY KEY (sequence, ordinal)
);

CREATE TABLE catalog_message_watermark(
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1), sequence INTEGER NOT NULL
);

CREATE TABLE application_sources (
    deployment TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
    input_json TEXT NOT NULL CHECK(json_valid(input_json)),
    remote_exports_json TEXT NOT NULL CHECK(json_valid(remote_exports_json)),
    PRIMARY KEY(deployment, revision)
);

CREATE TABLE application_deployments (
    id TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL,
    FOREIGN KEY(id, revision) REFERENCES application_sources(deployment, revision)
);

CREATE TABLE application_packages (
    id TEXT NOT NULL,
    revision TEXT NOT NULL,
    PRIMARY KEY(id, revision)
);

CREATE TABLE application_package_files (
    id TEXT NOT NULL,
    revision TEXT NOT NULL,
    path TEXT NOT NULL,
    payload BLOB NOT NULL,
    PRIMARY KEY(id, revision, path),
    FOREIGN KEY(id, revision) REFERENCES application_packages(id, revision) ON DELETE CASCADE
);

CREATE TABLE application_source_packages (
    deployment TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    id TEXT NOT NULL,
    revision TEXT NOT NULL,
    PRIMARY KEY(deployment, source_revision, id, revision),
    FOREIGN KEY(deployment, source_revision) REFERENCES application_sources(deployment, revision),
    FOREIGN KEY(id, revision) REFERENCES application_packages(id, revision)
);

CREATE TABLE imported_invocations (
    invocation_id TEXT PRIMARY KEY,
    bundle_digest TEXT NOT NULL CHECK(length(bundle_digest) = 71)
);

CREATE TABLE session_bundle_imports (
    digest TEXT PRIMARY KEY CHECK(length(digest)=71),
    binding_digest TEXT NOT NULL CHECK(length(binding_digest)=71),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
);

CREATE TABLE session_bundle_members (
    session_id TEXT PRIMARY KEY,
    bundle_digest TEXT NOT NULL REFERENCES session_bundle_imports(digest),
    parent_session_id TEXT,
    CHECK(parent_session_id IS NULL OR parent_session_id!=session_id)
);

CREATE TABLE application_launch (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    deployment TEXT NOT NULL,
    configuration TEXT NOT NULL CHECK(json_valid(configuration)),
    pending BLOB
, product TEXT CHECK(product IS NULL OR json_valid(product)));

CREATE TABLE application_operation_contracts (
    digest TEXT PRIMARY KEY NOT NULL,
    contract_json TEXT NOT NULL CHECK(json_valid(contract_json))
);

CREATE TABLE transcript_directory (
 session_id TEXT NOT NULL, source_sequence INTEGER NOT NULL CHECK(source_sequence >= 1),
 item_index INTEGER NOT NULL CHECK(item_index >= 0), turn_id TEXT NOT NULL, message_id TEXT NOT NULL,
 timestamp INTEGER NOT NULL, role TEXT NOT NULL, has_thinking INTEGER NOT NULL CHECK(has_thinking IN (0,1)),
 user_origin TEXT, state_status TEXT, tool_use_id TEXT, tool_name TEXT, tool_origin TEXT,
 parent_tool_call_id TEXT, parent_operation_id TEXT, has_args INTEGER, result_valid INTEGER,
 settlement TEXT, is_error INTEGER, content_kind TEXT, tool_title TEXT, presentation TEXT, duration_ms INTEGER,
 PRIMARY KEY(session_id,source_sequence,item_index), UNIQUE(session_id,message_id)
);

CREATE TABLE transcript_failures (
 session_id TEXT NOT NULL, source_sequence INTEGER NOT NULL, category TEXT NOT NULL,
 message_id TEXT, claimant_source_sequence INTEGER, claimant_item_index INTEGER, attempted_item_index INTEGER, reason TEXT,
 PRIMARY KEY(session_id,source_sequence)
);

CREATE TABLE recall_documents (
    id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    source_sequence INTEGER NOT NULL,
    item_index INTEGER NOT NULL,
    message_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    role TEXT NOT NULL,
    body TEXT NOT NULL,
    folded TEXT NOT NULL,
    attachments TEXT NOT NULL,
    UNIQUE(session_id, source_sequence, item_index),
    UNIQUE(session_id, message_id),
    FOREIGN KEY(session_id, source_sequence, item_index)
        REFERENCES transcript_directory(session_id, source_sequence, item_index) ON DELETE CASCADE
);
CREATE INDEX recall_document_turn ON recall_documents(session_id, turn_id, source_sequence, item_index);
CREATE INDEX recall_document_context ON recall_documents(session_id, source_sequence, item_index)
    WHERE body<>'' OR role IN ('tool_call','tool_result');
CREATE VIRTUAL TABLE recall_terms USING fts5(grams, content='', contentless_delete=1, detail=full);
CREATE TRIGGER recall_document_deleted AFTER DELETE ON recall_documents BEGIN
    DELETE FROM recall_terms WHERE rowid=old.id;
END;

CREATE TABLE "shell_runs" (
    session_id TEXT NOT NULL REFERENCES session_control(id),
    id TEXT NOT NULL,
    started_at INTEGER NOT NULL CHECK(started_at >= 0),
    active INTEGER NOT NULL CHECK(active IN (0, 1)),
    record_json TEXT NOT NULL,
    PRIMARY KEY (session_id, id),
    CHECK(json_extract(record_json, '$.sessionId') IS session_id),
    CHECK(json_extract(record_json, '$.id') IS id),
    CHECK(json_extract(record_json, '$.startedAt') IS started_at),
    CHECK(active IS (json_extract(record_json, '$.state.kind') IN ('starting', 'running')))
);

CREATE TABLE "interaction_requests" (
    request_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    record_json TEXT NOT NULL
);

CREATE TABLE "interaction_outcomes" (
    request_id TEXT PRIMARY KEY REFERENCES "interaction_requests"(request_id),
    outcome_json TEXT NOT NULL
);

CREATE TABLE "client_capability_session_grants" (
    authority_key TEXT PRIMARY KEY,
    record_json TEXT NOT NULL
);

-- App consent uses the existing append-only interaction facts. Only profile
-- persistence needs mutable authority: revocation advances its revision so a
-- delayed response cannot restore the previously revoked Always grant.
CREATE TABLE computer_app_profile_authority (
    target_key TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
    source_request TEXT REFERENCES interaction_requests(request_id)
) STRICT;

-- An observed app remains selectable between completed native calls in the same
-- logical Turn. Its first source T1 is an immutable, host-resolved selection.
CREATE TABLE computer_app_turn_activity (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    app_key TEXT NOT NULL,
    source_event TEXT NOT NULL REFERENCES event_log(event_id),
    operation_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY(session_id,turn_id,app_key),
    UNIQUE(session_id,operation_id)
) STRICT;

CREATE TABLE computer_app_turn_stops (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    app_key TEXT NOT NULL,
    stopped_at INTEGER NOT NULL CHECK(stopped_at BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(session_id,turn_id,app_key),
    FOREIGN KEY(session_id,turn_id,app_key)
        REFERENCES computer_app_turn_activity(session_id,turn_id,app_key) ON DELETE CASCADE
) STRICT;

CREATE TABLE "projects" (
    id TEXT PRIMARY KEY NOT NULL,
    identity TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL CHECK(length(CAST(name AS BLOB)) >= 1),
    last_used_at INTEGER NOT NULL CHECK(last_used_at BETWEEN 0 AND 9007199254740991),
    archived_at INTEGER CHECK(archived_at BETWEEN 0 AND 9007199254740991)
) STRICT;

CREATE TABLE "project_identities" (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES "projects"(id) ON DELETE CASCADE
) STRICT;

CREATE TABLE "project_locations" (
    project_id TEXT NOT NULL REFERENCES "projects"(id) ON DELETE CASCADE,
    path TEXT NOT NULL CHECK(length(CAST(path AS BLOB)) >= 1),
    is_worktree INTEGER NOT NULL CHECK(is_worktree IN (0, 1)),
    last_used_at INTEGER NOT NULL CHECK(last_used_at BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(project_id, path)
) STRICT;

CREATE TABLE "artifacts" (
    session_id TEXT NOT NULL REFERENCES session_control(id),
    id TEXT NOT NULL,
    created_at INTEGER NOT NULL CHECK(created_at >= 0),
    record_json TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    payload BLOB NOT NULL,
    canonical_at INTEGER CHECK(canonical_at IS NULL OR canonical_at > 0),
    PRIMARY KEY (session_id, id),
    CHECK(json_extract(record_json, '$.sessionId') = session_id),
    CHECK(json_extract(record_json, '$.id') = id),
    CHECK(json_extract(record_json, '$.createdAt') = created_at),
    CHECK(json_extract(record_json, '$.sizeBytes') = length(payload))
);

CREATE TABLE "session_history_artifacts" (
    session_id TEXT NOT NULL REFERENCES session_history_copies(session_id),
    source_session_id TEXT NOT NULL,
    source_artifact_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    PRIMARY KEY(session_id, source_session_id, source_artifact_id),
    FOREIGN KEY(session_id, artifact_id) REFERENCES "artifacts"(session_id, id)
);

CREATE TABLE context_source_prefixes (
    kind TEXT NOT NULL,
    owner TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    hash BLOB NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY(kind,owner,sequence)
) WITHOUT ROWID;

CREATE TABLE context_source_copies (
    owner TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    through_sequence INTEGER NOT NULL,
    base_high INTEGER,
    base_hash BLOB
) WITHOUT ROWID;

CREATE TABLE context_source_lineages (
    invocation_id TEXT PRIMARY KEY,
    parent_invocation_id TEXT,
    base_sequence INTEGER NOT NULL,
    ancestor_through INTEGER NOT NULL,
    ancestry_hash BLOB NOT NULL,
    opening_sequence INTEGER NOT NULL,
    identity_json TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE context_archive_records (
    sequence INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    target_sequence INTEGER NOT NULL,
    target_invocation_id TEXT NOT NULL,
    target_event_id TEXT NOT NULL,
    hash BLOB NOT NULL,
    placeholder_json TEXT NOT NULL,
    target_invocation_json TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    is_error INTEGER NOT NULL
);

CREATE TABLE context_archive_copy_prefixes (
    owner TEXT NOT NULL,
    target_sequence INTEGER NOT NULL,
    hash BLOB NOT NULL,
    PRIMARY KEY(owner,target_sequence)
) WITHOUT ROWID;

CREATE TABLE context_semantic_heads (
    session_id TEXT PRIMARY KEY,
    unavailable_at INTEGER,
    unavailable_reason TEXT
) WITHOUT ROWID;

CREATE TABLE context_semantic_frontiers (
    invocation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    through_sequence INTEGER NOT NULL,
    frontier_json TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE context_semantic_copies (
    session_id TEXT PRIMARY KEY
) WITHOUT ROWID;

CREATE TABLE context_semantic_rows (
    owner_session_id TEXT NOT NULL,
    source_sequence INTEGER NOT NULL,
    source_index INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    order_sequence INTEGER NOT NULL,
    order_index INTEGER NOT NULL,
    invocation_id TEXT NOT NULL,
    revision_invocation TEXT NOT NULL,
    event_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    archived INTEGER NOT NULL,
    inherited INTEGER NOT NULL,
    visible INTEGER NOT NULL,
    unknown_only INTEGER NOT NULL,
    row_json TEXT NOT NULL,
    PRIMARY KEY(owner_session_id,source_sequence,source_index,revision)
) WITHOUT ROWID;

CREATE TABLE context_semantic_fragments (
    source_sequence INTEGER NOT NULL,
    source_index INTEGER NOT NULL,
    part_sequence INTEGER NOT NULL,
    part_index INTEGER NOT NULL,
    PRIMARY KEY(source_sequence,source_index)
) WITHOUT ROWID;

CREATE TABLE context_semantic_fragment_pieces (
    source_sequence INTEGER NOT NULL,
    source_index INTEGER NOT NULL,
    piece_index INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    PRIMARY KEY(source_sequence,source_index,piece_index)
) WITHOUT ROWID;

CREATE TABLE context_semantic_cuts (
    owner_session_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    cut_sequence INTEGER NOT NULL,
    cut_index INTEGER NOT NULL,
    PRIMARY KEY(owner_session_id,invocation_id,revision)
) WITHOUT ROWID;

CREATE TABLE context_semantic_checkpoints (
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    checkpoint_json TEXT NOT NULL,
    PRIMARY KEY(session_id,sequence)
) WITHOUT ROWID;

CREATE TABLE context_semantic_changes (
    change_id INTEGER PRIMARY KEY,
    owner_session_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    source_sequence INTEGER NOT NULL,
    source_index INTEGER NOT NULL,
    order_sequence INTEGER NOT NULL,
    order_index INTEGER NOT NULL,
    invocation_id TEXT NOT NULL,
    revision_invocation TEXT NOT NULL,
    archived INTEGER NOT NULL,
    inherited INTEGER NOT NULL,
    deleted INTEGER NOT NULL
);

CREATE TABLE context_obligations (
    session_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('invocation','tool','model','call','completed_provider','interrupted_provider')),
    operation_id TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    sealed_unknown INTEGER NOT NULL CHECK(sealed_unknown IN (0,1)),
    PRIMARY KEY(invocation_id, kind, operation_id)
) WITHOUT ROWID;

CREATE TABLE context_safety_heads (
    session_id TEXT PRIMARY KEY,
    through_sequence INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE context_lineage_depths (
 invocation_id TEXT PRIMARY KEY, depth INTEGER NOT NULL CHECK(depth>=0)
) WITHOUT ROWID;

CREATE TABLE context_lineage_jumps (
 invocation_id TEXT NOT NULL, level INTEGER NOT NULL, ancestor_id TEXT NOT NULL,
 PRIMARY KEY(invocation_id,level)
) WITHOUT ROWID;

CREATE TABLE plugin_message_receipts (
    package_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
        CHECK(json_extract(receipt_json, '$.invocation.session_id') IS target_session_id),
    PRIMARY KEY(package_id, scope_id, target_session_id, operation_id)
) WITHOUT ROWID;

CREATE TABLE plugin_execution_receipts (
    package_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
        CHECK(json_extract(receipt_json, '$.invocation.session_id') IS target_session_id),
    PRIMARY KEY(package_id, scope_id, target_session_id, operation_id)
) WITHOUT ROWID;

CREATE TABLE workspace_bindings (
    id TEXT PRIMARY KEY,
    owner_scope TEXT NOT NULL,
    selection_digest TEXT NOT NULL,
    workspace_json TEXT NOT NULL CHECK(json_valid(workspace_json)),
    permission_epoch INTEGER NOT NULL CHECK(permission_epoch BETWEEN 0 AND 9007199254740991),
    metadata_epoch INTEGER NOT NULL CHECK(metadata_epoch BETWEEN 0 AND 9007199254740991)
) WITHOUT ROWID;

CREATE TABLE "application_operations" (
    deployment TEXT NOT NULL,
    namespace TEXT NOT NULL,
    operation TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json)),
    cleanup_json TEXT NOT NULL CHECK(json_valid(cleanup_json)),
    contract_digest TEXT NOT NULL REFERENCES application_operation_contracts(digest),
    PRIMARY KEY(deployment, namespace, operation)
);

CREATE TABLE "application_intents" (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment TEXT NOT NULL,
    consumer TEXT NOT NULL CHECK(json_valid(consumer)),
    operation TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    reference_json TEXT NOT NULL CHECK(json_valid(reference_json)),
    recovery_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(recovery_json)),
    UNIQUE(deployment, consumer, operation)
);

CREATE TABLE session_usage_totals (
    session_id TEXT PRIMARY KEY NOT NULL,
    input_known INTEGER NOT NULL CHECK(input_known BETWEEN 0 AND 9007199254740992),
    input_missing INTEGER NOT NULL CHECK(input_missing BETWEEN 0 AND 9007199254740992),
    output_known INTEGER NOT NULL CHECK(output_known BETWEEN 0 AND 9007199254740992),
    output_missing INTEGER NOT NULL CHECK(output_missing BETWEEN 0 AND 9007199254740992)
) STRICT;

CREATE TABLE session_usage_pending (
    request_id TEXT PRIMARY KEY NOT NULL REFERENCES event_log(event_id),
    invocation_id TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL
) STRICT;

CREATE TABLE interaction_pending (
    request_id TEXT PRIMARY KEY NOT NULL REFERENCES interaction_requests(request_id) ON DELETE CASCADE,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE context_execution_work (
    invocation_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('tool','model','call','interrupted','accepted_provider','completed_provider')),
    operation_id TEXT NOT NULL,
    call_id TEXT NOT NULL DEFAULT '',
    call_name TEXT NOT NULL DEFAULT '',
    opened_at INTEGER NOT NULL,
    closed_at INTEGER,
    PRIMARY KEY(invocation_id, kind, operation_id, call_id, call_name)
) WITHOUT ROWID;

CREATE TABLE context_execution_steps (
    invocation_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    purpose TEXT,
    item_acceptance INTEGER NOT NULL,
    observed_at INTEGER,
    tool_observed_at INTEGER,
    barrier_at INTEGER,
    accepted_at INTEGER,
    terminal_at INTEGER,
    terminal_kind TEXT,
    terminal_status TEXT,
    PRIMARY KEY(invocation_id, operation_id)
) WITHOUT ROWID;

CREATE TABLE context_independent_tools (
    invocation_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    opened_at INTEGER NOT NULL,
    PRIMARY KEY(invocation_id, operation_id)
) WITHOUT ROWID;

CREATE INDEX session_processes_pending ON session_processes(session_id) WHERE cleaned=0;

CREATE INDEX message_admission_order ON message_admissions(session_id, position, message_id);

CREATE INDEX message_interrupt_run ON message_interrupt_receipts(session_id, run_id)
    WHERE fence_json IS NOT NULL;

CREATE UNIQUE INDEX pending_root_invocation ON message_admissions (
    json_extract(record_json, '$.invocation.invocation_id')
) WHERE json_extract(record_json, '$.source.disposition') = 'turn_started';

CREATE INDEX event_material_owner ON event_log(event_session, sequence)
    WHERE event_json IS NOT NULL;

CREATE UNIQUE INDEX session_revision_family ON session_history_copies(
    CAST(json_extract(lineage_json, '$.root_session_id') AS TEXT),
    CAST(json_extract(lineage_json, '$.index') AS INTEGER)
) WHERE json_extract(lineage_json, '$.kind') = 'revision';

CREATE INDEX history_source_owners ON session_history_members(sequence, session_id);

CREATE INDEX archive_source_owners ON session_history_members(archive_sequence, session_id)
    WHERE archive_sequence IS NOT NULL;

CREATE INDEX revision_source_owners ON session_revision_sources(sequence, session_id);

CREATE INDEX invocation_sequence ON event_log(invocation_id, sequence);

CREATE UNIQUE INDEX archived_tool_result ON event_log(
    CAST(json_extract(event_json, '$.fact.placeholder.identity.runtime_event_id') AS TEXT),
    json_extract(event_json, '$.invocation.session_id')
) WHERE kind = 'tool_result_archived';

CREATE INDEX turn_opening_lookup ON event_log(
    json_extract(event_json, '$.invocation.session_id'),
    json_extract(event_json, '$.invocation.turn_id'), sequence DESC
) WHERE kind = 'invocation_opened';

CREATE UNIQUE INDEX operation_fact ON event_log(operation_id, kind)
    WHERE operation_id IS NOT NULL;

CREATE INDEX model_usage_requests ON event_log(sequence) WHERE kind = 'model_requested';

CREATE INDEX model_usage_observation ON event_log(
    invocation_id, json_extract(COALESCE(event_json, retained_json), '$.fact.step_id'), sequence DESC
) WHERE kind = 'model_observed' AND json_extract(COALESCE(event_json, retained_json), '$.fact.event.kind') = 'finished';

CREATE UNIQUE INDEX auxiliary_model_source ON event_log(json_extract(event_json, '$.source'))
    WHERE kind = 'auxiliary_model_started';

CREATE UNIQUE INDEX auxiliary_model_outcome ON event_log(
    json_extract(event_json, '$.request_id'), kind
) WHERE kind IN ('auxiliary_model_settled', 'auxiliary_model_usage');

CREATE INDEX tool_usage_requests ON event_log(sequence)
    WHERE kind IN ('tool_dispatched', 'tool_rejected');

CREATE UNIQUE INDEX message_steering_identity ON event_log(
    json_extract(event_json, '$.invocation.session_id'),
    json_extract(event_json, '$.fact.message.message_id')
) WHERE kind = 'message_steered';

CREATE UNIQUE INDEX continuation_claim_id ON event_log(
    json_extract(event_json, '$.fact.input.claim.id')
) WHERE kind = 'invocation_opened' AND json_extract(event_json, '$.fact.input.kind') IN ('continuation','handoff');

CREATE UNIQUE INDEX continuation_source_boundary ON event_log(
    json_extract(event_json, '$.invocation.session_id'),
    json_extract(event_json, '$.fact.input.claim.source.invocation.run_id'),
    json_extract(event_json, '$.fact.input.claim.source.high_water')
) WHERE kind = 'invocation_opened' AND json_extract(event_json, '$.fact.input.kind') IN ('continuation','handoff');

CREATE UNIQUE INDEX handoff_successor_run ON event_log(
    json_extract(event_json, '$.fact.outcome.pause.intent.successor_run_id')
) WHERE kind = 'invocation_ended' AND json_extract(event_json, '$.fact.outcome.kind') = 'handoff_paused';

CREATE UNIQUE INDEX handoff_successor_invocation ON event_log(
    json_extract(event_json, '$.fact.outcome.pause.intent.successor_invocation_id')
) WHERE kind = 'invocation_ended' AND json_extract(event_json, '$.fact.outcome.kind') = 'handoff_paused';

CREATE UNIQUE INDEX handoff_claim ON event_log(
    json_extract(event_json, '$.fact.outcome.pause.intent.claim_id')
) WHERE kind = 'invocation_ended' AND json_extract(event_json, '$.fact.outcome.kind') = 'handoff_paused';

CREATE INDEX model_request_composition_digest ON model_request_compositions(digest);

CREATE INDEX host_effects_namespace ON host_effects(package_id, scope_id);

CREATE INDEX message_source_identity ON message_sources(message_id, event_id);

CREATE INDEX message_openings_by_turn ON event_log(
    CAST(json_extract(event_json, '$.invocation.turn_id') AS TEXT), sequence
) WHERE kind = 'invocation_opened' AND json_extract(event_json, '$.fact.input.kind') = 'message';

CREATE INDEX catalog_message_facts ON event_log(
    json_extract(event_json, '$.invocation.session_id'), kind, sequence
) WHERE kind IN ('invocation_opened', 'model_completed');

CREATE INDEX catalog_part_starts ON event_log(
    json_extract(event_json, '$.invocation.session_id'), invocation_id,
    json_extract(event_json, '$.fact.step_id'), sequence
) WHERE kind = 'model_observed'
    AND json_extract(event_json, '$.fact.event.kind') = 'part_started';

CREATE INDEX catalog_visible_tail ON catalog_messages(
    session_id, sequence DESC, ordinal DESC
);

CREATE INDEX catalog_latest_message ON catalog_messages(
    session_id, message_at DESC, sequence DESC, ordinal DESC
);

CREATE INDEX catalog_latest_preview ON catalog_messages(
    session_id, message_at DESC, sequence DESC, ordinal DESC
) WHERE preview IS NOT NULL;

CREATE INDEX catalog_partial_deltas ON event_log(
    invocation_id, json_extract(event_json, '$.fact.step_id'),
    json_extract(event_json, '$.fact.event.data.id'), sequence
) WHERE kind = 'model_observed'
    AND json_extract(event_json, '$.fact.event.kind') = 'part_delta';

CREATE INDEX navigation_boundaries ON event_log(
    json_extract(event_json, '$.invocation.session_id'), kind, sequence
) WHERE kind IN ('invocation_opened', 'invocation_ended');

CREATE INDEX application_package_references ON application_source_packages(id, revision);

CREATE INDEX session_history_parent ON session_history_copies(source_session_id, session_id);

CREATE INDEX plugin_session_parent ON plugin_sessions(authority_session_id, session_id)
    WHERE authority_session_id IS NOT NULL;

CREATE INDEX bundle_parent_sessions ON session_bundle_members(parent_session_id, session_id);

CREATE INDEX tool_settled_session_sequence ON event_log(
    json_extract(event_json, '$.invocation.session_id'), sequence
) WHERE kind = 'tool_settled';

CREATE INDEX model_observed_step ON event_log(
    invocation_id, CAST(json_extract(event_json, '$.fact.step_id') AS TEXT), sequence
) WHERE kind = 'model_observed';

CREATE INDEX checkpoint_session_sequence ON event_log(
    json_extract(event_json, '$.invocation.session_id'), sequence
) WHERE kind = 'context_checkpoint_recorded';

CREATE INDEX archive_session_sequence ON event_log(
    json_extract(event_json, '$.invocation.session_id'), sequence
) WHERE kind = 'tool_result_archived';

CREATE UNIQUE INDEX invocation_boundary ON event_log(invocation_id, kind)
WHERE kind = 'invocation_opened' OR kind = 'invocation_ended';

CREATE INDEX safety_session_kind_sequence ON event_log(
    json_extract(event_json, '$.invocation.session_id'), kind, sequence
) WHERE kind = 'invocation_opened' OR kind = 'tool_dispatched'
    OR kind = 'model_requested' OR kind = 'model_completed'
    OR kind = 'model_interrupted';

CREATE INDEX admission_openings ON event_log(
    json_extract(event_json, '$.invocation.session_id'), invocation_id
) WHERE kind = 'invocation_opened' AND event_json IS NOT NULL;

CREATE UNIQUE INDEX admission_terminals ON event_log(invocation_id, kind)
WHERE kind = 'invocation_ended' AND event_json IS NOT NULL;

CREATE INDEX catalog_model_boundaries ON event_log(invocation_id, kind, sequence)
WHERE kind = 'model_requested' OR kind = 'model_completed'
   OR kind = 'model_interrupted' OR kind = 'executor_started' OR kind = 'executor_completed';

CREATE INDEX model_step_terminals ON event_log(invocation_id, operation_id, sequence)
WHERE kind IN ('model_completed', 'model_interrupted') AND event_json IS NOT NULL;

CREATE INDEX executor_tool_observations ON event_log (
    invocation_id, json_extract(event_json, '$.fact.output.toolCallId'), sequence
) WHERE kind IN ('executor_observed', 'executor_completed');

CREATE INDEX model_response_identity ON event_log(
    invocation_id,
    CAST(json_extract(event_json, '$.fact.step_id') AS TEXT),
    sequence
) WHERE kind = 'model_observed'
  AND event_json IS NOT NULL
  AND json_extract(event_json, '$.fact.event.kind') = 'response_metadata'
  AND json_type(event_json, '$.fact.event.data.model') = 'text';

CREATE INDEX diagnostic_session_sequence ON event_log(
    CASE WHEN kind='title_failure' THEN json_extract(event_json,'$.opening.session_id') ELSE json_extract(event_json,'$.invocation.session_id') END, sequence
) WHERE (kind='title_failure' OR (kind='invocation_ended' AND json_extract(event_json,'$.fact.outcome.kind')='failed') OR (kind='model_interrupted' AND json_extract(event_json,'$.fact.status')!='cancelled'));

CREATE INDEX directory_turn ON transcript_directory(session_id,turn_id,source_sequence,item_index);

CREATE INDEX directory_results ON transcript_directory(session_id,turn_id,tool_use_id,source_sequence,item_index) WHERE role='tool_result';

CREATE INDEX directory_activity ON transcript_directory(session_id,turn_id,tool_use_id,source_sequence,item_index) WHERE role='tool_activity';

CREATE INDEX directory_state ON transcript_directory(session_id,turn_id,source_sequence,item_index) WHERE role='turn_state';

CREATE INDEX directory_user ON transcript_directory(session_id,source_sequence,item_index) WHERE role='user';

CREATE INDEX message_source_openings ON event_log(kind)
WHERE invocation_id IS NOT NULL AND event_json IS NOT NULL
    AND kind = 'invocation_opened'
    AND json_extract(event_json, '$.fact.input.kind') = 'message'
    AND json_array_length(event_json, '$.fact.input.source_messages') > 0;

CREATE INDEX shell_runs_session_order ON shell_runs(session_id, started_at, id);

CREATE INDEX shell_runs_active ON shell_runs(active) WHERE active = 1;

CREATE INDEX interaction_session_pending ON interaction_requests(session_id, created_at, request_id);

CREATE UNIQUE INDEX computer_app_native_effect ON interaction_requests(
    session_id,
    json_extract(record_json, '$.request.nativeOperationId')
) WHERE json_extract(record_json, '$.request.kind') = 'computer_app';

CREATE INDEX interaction_browser_origin_decision ON interaction_requests(
    session_id,
    json_extract(record_json,'$.request.target.capability'),
    json_extract(record_json,'$.request.target.providerId'),
    json_extract(record_json,'$.request.target.contractId'),
    json_extract(record_json,'$.request.target.serverId'),
    json_extract(record_json,'$.request.target.toolName'),
    json_extract(record_json,'$.request.target.scope.origin'),
    json_extract(record_json,'$.request.basis.boundaryRevision'),
    json_extract(record_json,'$.request.basis.binding.id'),
    json_extract(record_json,'$.request.basis.binding.permissionEpoch'),
    request_id
) WHERE json_extract(record_json,'$.request.kind')='client_capability'
    AND json_extract(record_json,'$.request.target.capability') IN ('browser','browser_download')
    AND json_extract(record_json,'$.request.target.scope.kind')='browser_origin';

CREATE INDEX interaction_permission_basis ON interaction_requests(
    session_id, json_extract(record_json, '$.request.baseRevision'), created_at, request_id
) WHERE json_extract(record_json, '$.request.kind') = 'permissions';

CREATE INDEX project_identity_owner ON project_identities(project_id, id);

CREATE INDEX artifacts_session_order ON artifacts(session_id, created_at DESC, id);

CREATE UNIQUE INDEX context_source_ordinals ON context_source_prefixes(owner,ordinal) WHERE kind='invocation';

CREATE INDEX context_run_opening ON event_log(
    json_extract(event_json,'$.invocation.session_id'),
    json_extract(event_json,'$.invocation.run_id'),invocation_id
) WHERE kind='invocation_opened' AND event_json IS NOT NULL;

CREATE UNIQUE INDEX context_archive_target ON context_archive_records(session_id,target_event_id);

CREATE INDEX context_archive_owner_sequence ON context_archive_records(session_id,sequence);

CREATE INDEX context_semantic_frontier_session ON context_semantic_frontiers(session_id,invocation_id);

CREATE INDEX context_semantic_row_order ON context_semantic_rows(owner_session_id,order_sequence,order_index,source_sequence,source_index,revision);

CREATE INDEX context_semantic_invocation_rows ON context_semantic_rows(owner_session_id,invocation_id,kind,source_sequence,source_index,revision);

CREATE INDEX context_semantic_unknown_rows ON context_semantic_rows(owner_session_id,unknown_only,source_sequence,order_sequence) WHERE unknown_only=1;

CREATE INDEX context_semantic_notifications ON context_semantic_rows(owner_session_id,invocation_id,source_sequence,source_index,revision) WHERE kind='notification';

CREATE INDEX context_semantic_part_fragments ON context_semantic_fragments(part_sequence,part_index,source_sequence,source_index);

CREATE INDEX context_semantic_cut_revision ON context_semantic_cuts(owner_session_id,revision);

CREATE INDEX context_semantic_change_revision ON context_semantic_changes(owner_session_id,revision,change_id);

CREATE INDEX context_obligations_session ON context_obligations(session_id, kind, invocation_id);

CREATE INDEX context_obligations_openings ON context_obligations(opened_at) WHERE kind='invocation';

CREATE INDEX workspace_bindings_selection ON workspace_bindings(owner_scope,selection_digest,id);

CREATE INDEX workspace_bindings_project ON workspace_bindings(owner_scope,json_extract(workspace_json,'$.projectId'),id);

CREATE INDEX workspace_bindings_path ON workspace_bindings(json_extract(workspace_json,'$.path'),id);

CREATE INDEX workspace_bindings_identity ON workspace_bindings(json_extract(workspace_json,'$.identity'),id);

CREATE INDEX session_workspace_binding ON session_control(json_extract(configuration,'$.workspace.id'),id);

CREATE INDEX session_binding_metadata_headroom ON session_control(
    json_extract(configuration,'$.workspace.id'),
    revision-json_extract(configuration,'$.workspace.metadataEpochAtAttach') DESC
);

CREATE INDEX session_binding_permission_headroom ON session_control(
    json_extract(configuration,'$.workspace.id'),
    json_extract(configuration,'$.boundary_revision')-json_extract(configuration,'$.workspace.permissionEpochAtAttach') DESC
);

CREATE INDEX application_intent_history ON application_intents(deployment, consumer, cursor);

CREATE INDEX session_usage_pending_invocation ON session_usage_pending(invocation_id, request_id);

CREATE INDEX auxiliary_usage_meter_observation ON event_log(
    json_extract(COALESCE(event_json, retained_json), '$.request_id')
) WHERE kind = 'auxiliary_model_usage';

CREATE INDEX interaction_pending_order ON interaction_pending(session_id, created_at, request_id);

CREATE INDEX interaction_pending_session_cursor ON interaction_pending(session_id, request_id);

CREATE INDEX context_semantic_row_event
    ON context_semantic_rows(owner_session_id, event_id, revision)
    WHERE kind = 'tool_result';

CREATE INDEX context_execution_live ON context_execution_work(invocation_id, opened_at) WHERE closed_at IS NULL;

CREATE INDEX context_execution_closed ON context_execution_work(invocation_id, closed_at) WHERE closed_at IS NOT NULL;

CREATE INDEX context_summary_tool_observed ON context_execution_steps(invocation_id, tool_observed_at)
    WHERE purpose='summary' AND tool_observed_at IS NOT NULL;

CREATE INDEX context_summary_round ON event_log(invocation_id,
    json_extract(event_json,'$.fact.source_high_water'),
    json_extract(event_json,'$.fact.source_scope'), sequence)
    WHERE kind='model_requested' AND json_extract(event_json,'$.fact.purpose')='summary';

CREATE INDEX context_summary_sequence ON event_log(invocation_id,sequence)
    WHERE kind='model_requested' AND json_extract(event_json,'$.fact.purpose')='summary';

CREATE INDEX context_compaction_waiting ON event_log(invocation_id,sequence)
    WHERE kind='context_compaction_waiting';

CREATE INDEX tool_call_identity ON event_log(invocation_id,
    json_extract(event_json,'$.fact.call.tool_call_id'),
    CASE WHEN json_extract(event_json,'$.fact.call.origin.kind')='provider'
         THEN json_extract(event_json,'$.fact.call.origin.step_id') END)
    WHERE kind IN ('tool_dispatched','tool_rejected');

CREATE VIEW runtime_events AS
    SELECT * FROM event_log WHERE invocation_id IS NOT NULL AND event_json IS NOT NULL;

CREATE VIEW accounting_events AS
    SELECT sequence, event_id, invocation_id, kind, operation_id,
        accounting_at, accounting_usage, invocation_model, accounting_tool,
        COALESCE(event_json, retained_json) AS event_json
    FROM event_log;

CREATE VIEW agent_model_usage AS
WITH attempts AS (
    SELECT request.sequence, request.event_id,
        json_extract(request.event_json, '$.invocation') AS invocation,
        opening.invocation_model AS binding,
        json_extract(request.event_json, '$.fact.model_id') AS model_id,
        json_extract(request.event_json, '$.fact.purpose') AS purpose,
        request.accounting_at AS started_at,
        COALESCE(completed.accounting_at, interrupted.accounting_at, terminal.accounting_at) AS completed_at,
        COALESCE(completed.sequence, interrupted.sequence, terminal.sequence) AS completed_sequence,
        CASE
            WHEN completed.sequence IS NOT NULL THEN 'success'
            WHEN json_extract(interrupted.event_json, '$.fact.status') = 'cancelled' THEN 'aborted'
            WHEN interrupted.sequence IS NOT NULL THEN 'error'
            WHEN json_extract(terminal.event_json, '$.fact.outcome.kind') = 'cancelled' THEN 'aborted'
            WHEN terminal.sequence IS NOT NULL THEN 'unknown'
        END AS outcome,
        COALESCE(completed.accounting_usage, (
            SELECT observed.accounting_usage
            FROM event_log observed INDEXED BY model_usage_observation
            WHERE observed.kind = 'model_observed'
              AND json_extract(COALESCE(observed.event_json, observed.retained_json), '$.fact.event.kind') = 'finished'
              AND observed.invocation_id = request.invocation_id
              AND json_extract(COALESCE(observed.event_json, observed.retained_json), '$.fact.step_id') = request.operation_id
            ORDER BY observed.sequence DESC LIMIT 1
        ), '{}') AS usage
    FROM accounting_events request
    JOIN accounting_events opening ON opening.invocation_id = request.invocation_id
        AND opening.kind = 'invocation_opened'
    LEFT JOIN accounting_events completed ON completed.operation_id = request.operation_id
        AND completed.kind = 'model_completed'
    LEFT JOIN accounting_events interrupted ON interrupted.operation_id = request.operation_id
        AND interrupted.kind = 'model_interrupted'
    LEFT JOIN accounting_events terminal ON terminal.invocation_id = request.invocation_id
        AND terminal.kind = 'invocation_ended'
    WHERE request.kind = 'model_requested'
)
SELECT sequence, event_id,
    json_object('kind', 'agent', 'invocation', json(invocation), 'purpose', purpose) AS origin,
    binding, model_id, outcome, usage,
    json_extract(invocation, '$.session_id') AS session_id,
    started_at, completed_at,
    completed_sequence
FROM attempts;

CREATE VIEW auxiliary_model_usage AS
SELECT started.sequence, started.event_id,
    json_object('kind', 'auxiliary', 'source', json_extract(started.event_json, '$.source')) AS origin,
    json_extract(started.event_json, '$.binding') AS binding,
    json_extract(started.event_json, '$.binding.model') AS model_id,
    json_extract(settled.event_json, '$.outcome') AS outcome,
    COALESCE(observed.accounting_usage, '{}') AS usage,
    json_extract(started.event_json, '$.session_id') AS session_id,
    started.accounting_at AS started_at, settled.accounting_at AS completed_at,
    settled.sequence AS completed_sequence
FROM event_log started
LEFT JOIN event_log settled ON settled.kind = 'auxiliary_model_settled'
    AND json_extract(settled.event_json, '$.request_id') = started.event_id
LEFT JOIN event_log observed ON observed.kind = 'auxiliary_model_usage'
    AND json_extract(COALESCE(observed.event_json, observed.retained_json), '$.request_id') = started.event_id
WHERE started.kind = 'auxiliary_model_started';

CREATE VIEW model_usage AS
SELECT calls.*, accounting.quote_json, valuation.usd
FROM (SELECT * FROM agent_model_usage UNION ALL SELECT * FROM auxiliary_model_usage) calls
LEFT JOIN model_accounting accounting ON accounting.request_id = calls.event_id
LEFT JOIN model_valuations valuation ON valuation.request_id = calls.event_id;

CREATE VIEW tool_usage AS
SELECT request.sequence, request.event_id,
    json_extract(request.accounting_tool, '$.invocation') AS invocation,
    json_extract(request.accounting_tool, '$.invocation.session_id') AS session_id,
    json_extract(request.accounting_tool, '$.call') AS call,
    json_extract(request.accounting_tool, '$.name') AS name,
    opening.invocation_model AS binding,
    CASE WHEN request.kind = 'tool_rejected' THEN request.accounting_at
        ELSE COALESCE(settled.accounting_at, terminal.accounting_at) END AS completed_at,
    CASE WHEN request.kind = 'tool_rejected' THEN request.sequence
        ELSE COALESCE(settled.sequence, terminal.sequence) END AS completed_sequence,
    CASE WHEN request.kind = 'tool_rejected' THEN json_object(
        'kind', 'rejected', 'reason', json_extract(request.accounting_tool, '$.rejection'))
    ELSE json_object('kind', 'settled', 'startedAt', request.accounting_at,
        'outcome', CASE json_extract(settled.accounting_tool, '$.outcome')
            WHEN 'succeeded' THEN 'success' WHEN 'failed' THEN 'error' ELSE 'unknown' END)
    END AS result
FROM accounting_events request
JOIN accounting_events opening ON opening.invocation_id = request.invocation_id
    AND opening.kind = 'invocation_opened'
LEFT JOIN accounting_events settled ON settled.invocation_id = request.invocation_id
    AND settled.operation_id = request.operation_id AND settled.kind = 'tool_settled'
LEFT JOIN accounting_events terminal ON terminal.invocation_id = request.invocation_id
    AND terminal.kind = 'invocation_ended'
WHERE request.kind IN ('tool_dispatched', 'tool_rejected');

CREATE VIEW usage_activity AS
SELECT 'model' AS kind, sequence, event_id, session_id, completed_sequence,
    binding, completed_at, origin, model_id, started_at, outcome, usage, quote_json, usd,
    NULL AS invocation, NULL AS call, NULL AS name, NULL AS result,
    outcome AS status,
    COALESCE(session_id, '') || ' ' || model_id || ' ' ||
        COALESCE(json_extract(binding, '$.connection_slug'), '') || ' ' ||
        COALESCE(json_extract(quote_json, '$.providerId'), '') AS search
FROM model_usage
UNION ALL
SELECT 'tool', sequence, event_id, session_id, completed_sequence,
    binding, completed_at, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    invocation, call, name, result,
    CASE WHEN json_extract(result, '$.kind') = 'rejected' THEN 'rejected'
        ELSE json_extract(result, '$.outcome') END,
    session_id || ' ' || name || ' ' ||
        COALESCE(json_extract(binding, '$.connection_slug'), '') || ' ' ||
        COALESCE(json_extract(binding, '$.model'), '')
FROM tool_usage;

CREATE VIEW session_message_sources AS
    SELECT session_id AS owner_session_id, session_id AS source_session_id, message_id, event_id
    FROM message_sources
    UNION ALL
    SELECT h.session_id, s.session_id, s.message_id, s.event_id FROM session_history_members h
    JOIN runtime_events e ON e.sequence=h.sequence JOIN message_sources s ON s.event_id=e.event_id
    UNION ALL
    SELECT r.session_id, s.session_id, s.message_id, s.event_id FROM session_revision_sources r
    JOIN runtime_events e ON e.sequence=r.sequence JOIN message_sources s ON s.event_id=e.event_id;

CREATE VIEW local_runtime_events AS
    SELECT e.* FROM runtime_events e
    WHERE NOT EXISTS(SELECT 1 FROM imported_invocations i WHERE i.invocation_id=e.invocation_id);

CREATE VIEW session_history_events AS
    SELECT e.event_session AS owner_session_id,
           0 AS inherited, NULL AS archive_sequence, e.* FROM runtime_events e
    UNION ALL
    SELECT h.session_id, 1, h.archive_sequence, e.*
    FROM session_history_members h JOIN runtime_events e ON e.sequence = h.sequence;

CREATE TRIGGER context_source_copy AFTER INSERT ON session_history_copies
BEGIN
    INSERT INTO context_source_copies(owner,source,through_sequence)
    VALUES(NEW.session_id,NEW.source_session_id,NEW.through_sequence)
    ON CONFLICT(owner) DO NOTHING;
END;

CREATE TRIGGER context_obligations_append AFTER INSERT ON event_log
WHEN NEW.invocation_id IS NOT NULL AND NEW.event_json IS NOT NULL AND (
    NEW.kind IN ('invocation_opened','invocation_ended','tool_dispatched','tool_rejected','tool_settled','model_requested','model_completed','model_interrupted')
    OR (NEW.kind='model_observed' AND json_extract(NEW.event_json,'$.fact.event.kind')='tool_call'))
BEGIN
    INSERT INTO context_safety_heads VALUES(NEW.event_session, NEW.sequence)
      ON CONFLICT(session_id) DO UPDATE SET through_sequence=MAX(through_sequence, excluded.through_sequence);

    DELETE FROM context_obligations WHERE invocation_id=NEW.invocation_id AND (
      (NEW.kind='invocation_ended' AND kind='invocation')
      OR (NEW.kind='tool_settled' AND kind='tool' AND operation_id=NEW.operation_id)
      OR (NEW.kind IN ('model_completed','model_interrupted') AND kind='model' AND operation_id=NEW.operation_id)
      OR (NEW.kind IN ('tool_dispatched','tool_rejected') AND kind='call' AND operation_id=NEW.operation_id));

    -- A manual message can observe a sealed unknown dispatch; replay cannot.
    UPDATE context_obligations SET sealed_unknown=1
      WHERE NEW.kind='invocation_ended' AND json_extract(NEW.event_json,'$.fact.outcome.class')='outcome_unknown'
        AND invocation_id=NEW.invocation_id AND kind='tool';

    INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'invocation', '', e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=NEW.sequence AND e.kind='invocation_opened'
      AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.kind='invocation_ended');

    INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'tool', e.operation_id, e.sequence,
           EXISTS(SELECT 1 FROM runtime_events terminal
             WHERE terminal.invocation_id=e.invocation_id AND terminal.kind='invocation_ended'
               AND json_extract(terminal.event_json,'$.fact.outcome.class')='outcome_unknown')
    FROM runtime_events e
    WHERE e.sequence=NEW.sequence AND e.kind='tool_dispatched'
      AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.operation_id=e.operation_id AND t.kind='tool_settled');

    INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'model', e.operation_id, e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=NEW.sequence AND e.kind='model_requested'
      AND NOT EXISTS(SELECT 1 FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.operation_id=e.operation_id AND t.kind IN ('model_completed','model_interrupted'));

    INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'call', e.operation_id || ':' || json_extract(p.value,'$.call.id'), e.sequence,
           0
    FROM runtime_events e, json_each(e.event_json,'$.fact.output.parts') p
    WHERE e.sequence=NEW.sequence AND e.kind='model_completed' AND json_extract(p.value,'$.kind')='tool_call'
      AND json_extract(p.value,'$.call.provider_executed')=0
      AND NOT EXISTS(SELECT 1 FROM runtime_events r WHERE r.invocation_id=e.invocation_id AND r.operation_id=e.operation_id AND r.kind='model_requested' AND json_extract(r.event_json,'$.fact.item_acceptance')=1)
      AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id=e.invocation_id
        AND d.operation_id=e.operation_id || ':' || json_extract(p.value,'$.call.id') AND d.kind IN ('tool_dispatched','tool_rejected'));

    INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'call', json_extract(e.event_json,'$.fact.step_id') || ':' || json_extract(e.event_json,'$.fact.event.data.id'), e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=NEW.sequence AND e.kind='model_observed' AND json_extract(e.event_json,'$.fact.event.kind')='tool_call'
      AND json_extract(e.event_json,'$.fact.event.data.provider_executed')=0
      AND EXISTS(SELECT 1 FROM runtime_events r WHERE r.invocation_id=e.invocation_id
        AND r.operation_id=json_extract(e.event_json,'$.fact.step_id') AND r.kind='model_requested' AND json_extract(r.event_json,'$.fact.item_acceptance')=1)
      AND NOT EXISTS(SELECT 1 FROM runtime_events d WHERE d.invocation_id=e.invocation_id
        AND d.operation_id=json_extract(e.event_json,'$.fact.step_id') || ':' || json_extract(e.event_json,'$.fact.event.data.id') AND d.kind IN ('tool_dispatched','tool_rejected'));

    INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'completed_provider', e.operation_id, e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=NEW.sequence AND e.kind='model_completed'
      AND EXISTS(SELECT 1 FROM json_each(e.event_json,'$.fact.output.parts') p
        WHERE json_extract(p.value,'$.kind')='tool_call' AND json_extract(p.value,'$.call.provider_executed')=1
        AND NOT EXISTS(SELECT 1 FROM json_each(e.event_json,'$.fact.output.parts') result
          WHERE json_extract(result.value,'$.kind')='tool_result'
            AND json_extract(result.value,'$.id')=json_extract(p.value,'$.call.id')
            AND json_extract(result.value,'$.name')=json_extract(p.value,'$.call.name')));

    INSERT INTO context_obligations
    SELECT e.event_session, e.invocation_id, 'interrupted_provider', e.operation_id, e.sequence,
           0
    FROM runtime_events e
    WHERE e.sequence=NEW.sequence AND e.kind='model_interrupted'
      AND EXISTS(SELECT 1 FROM runtime_events call WHERE call.invocation_id=e.invocation_id AND call.kind='model_observed'
        AND CAST(json_extract(call.event_json,'$.fact.step_id') AS TEXT)=e.operation_id
        AND call.sequence<e.sequence AND json_extract(call.event_json,'$.fact.event.kind')='tool_call'
        AND json_extract(call.event_json,'$.fact.event.data.provider_executed')=1
        AND NOT EXISTS(SELECT 1 FROM runtime_events result WHERE result.invocation_id=call.invocation_id
          AND result.kind='model_observed' AND result.sequence>call.sequence AND result.sequence<e.sequence
          AND CAST(json_extract(result.event_json,'$.fact.step_id') AS TEXT)=e.operation_id
          AND json_extract(result.event_json,'$.fact.event.kind')='provider_tool_result'
          AND json_extract(result.event_json,'$.fact.event.data.id')=json_extract(call.event_json,'$.fact.event.data.id')
          AND json_extract(result.event_json,'$.fact.event.data.name')=json_extract(call.event_json,'$.fact.event.data.name')));

END;

CREATE TRIGGER context_lineage_index_depth AFTER INSERT ON context_lineage_depths
BEGIN
 INSERT INTO context_lineage_jumps(invocation_id,level,ancestor_id)
 WITH RECURSIVE jumps(level,ancestor_id) AS (
   SELECT 0,parent_invocation_id FROM context_source_lineages
    WHERE invocation_id=NEW.invocation_id AND parent_invocation_id IS NOT NULL
   UNION ALL
   SELECT p.level+1,j.ancestor_id FROM jumps p JOIN context_lineage_jumps j
    ON j.invocation_id=p.ancestor_id AND j.level=p.level
 ) SELECT NEW.invocation_id,level,ancestor_id FROM jumps;
END;

CREATE TRIGGER context_lineage_index_opening AFTER INSERT ON context_source_lineages
BEGIN
 INSERT INTO context_lineage_depths(invocation_id,depth)
 VALUES(NEW.invocation_id,CASE WHEN NEW.parent_invocation_id IS NULL THEN 0
   ELSE (SELECT depth+1 FROM context_lineage_depths WHERE invocation_id=NEW.parent_invocation_id) END);
END;

CREATE TRIGGER interaction_pending_request_insert AFTER INSERT ON interaction_requests
BEGIN
    INSERT INTO interaction_pending(request_id, session_id, created_at)
    SELECT NEW.request_id, NEW.session_id, NEW.created_at
    WHERE NOT EXISTS (SELECT 1 FROM interaction_outcomes WHERE request_id=NEW.request_id);
END;

CREATE TRIGGER interaction_pending_outcome_insert AFTER INSERT ON interaction_outcomes
BEGIN
    DELETE FROM interaction_pending WHERE request_id=NEW.request_id;
END;

CREATE TRIGGER interaction_pending_outcome_delete AFTER DELETE ON interaction_outcomes
BEGIN
    INSERT INTO interaction_pending(request_id, session_id, created_at)
    SELECT request_id, session_id, created_at FROM interaction_requests
    WHERE request_id=OLD.request_id
      AND NOT EXISTS (SELECT 1 FROM interaction_outcomes WHERE request_id=OLD.request_id)
    ON CONFLICT(request_id) DO NOTHING;
END;

CREATE TRIGGER context_execution_append AFTER INSERT ON event_log
WHEN NEW.invocation_id IS NOT NULL AND NEW.event_json IS NOT NULL
  AND NEW.kind IN ('model_requested','model_observed','model_completed','model_interrupted','tool_dispatched','tool_rejected','tool_settled')
  AND (NEW.kind != 'model_observed'
    OR json_extract(NEW.event_json,'$.fact.event.kind') IN ('tool_call','provider_tool_result')
    OR EXISTS(SELECT 1 FROM context_execution_steps
      WHERE invocation_id=NEW.invocation_id
        AND operation_id=CAST(json_extract(NEW.event_json,'$.fact.step_id') AS TEXT)
        AND (observed_at IS NULL OR terminal_kind='model_interrupted'
          OR (barrier_at IS NULL AND (json_extract(NEW.event_json,'$.fact.event.kind')='finished'
            OR (json_extract(NEW.event_json,'$.fact.event.data.provider_options') IS NOT NULL
              AND json_extract(NEW.event_json,'$.fact.event.data.provider_options')!='{}')))
          OR (accepted_at IS NULL AND json_extract(NEW.event_json,'$.fact.event.kind') IN ('source','part_finished')))))
BEGIN
    INSERT INTO context_execution_steps(invocation_id,operation_id,requested_at,purpose,item_acceptance)
    SELECT NEW.invocation_id,NEW.operation_id,NEW.sequence,json_extract(NEW.event_json,'$.fact.purpose'),
        COALESCE(json_extract(NEW.event_json,'$.fact.item_acceptance'),0)
    WHERE NEW.kind='model_requested';

    UPDATE context_execution_steps SET
        observed_at=COALESCE(observed_at,NEW.sequence),
        tool_observed_at=COALESCE(tool_observed_at,CASE WHEN json_extract(NEW.event_json,'$.fact.event.kind') IN ('tool_call','provider_tool_result') THEN NEW.sequence END),
        barrier_at=COALESCE(barrier_at,CASE WHEN (json_extract(NEW.event_json,'$.fact.event.kind') IN ('provider_tool_result','finished')
    OR (json_extract(NEW.event_json,'$.fact.event.kind')='tool_call' AND json_extract(NEW.event_json,'$.fact.event.data.provider_executed')=1)
    OR (json_extract(NEW.event_json,'$.fact.event.data.provider_options') IS NOT NULL
        AND json_extract(NEW.event_json,'$.fact.event.data.provider_options')!='{}')) THEN NEW.sequence END),
        accepted_at=COALESCE(accepted_at,CASE WHEN json_extract(NEW.event_json,'$.fact.event.kind') IN ('source','part_finished','tool_call','provider_tool_result') THEN NEW.sequence END)
    WHERE NEW.kind='model_observed' AND invocation_id=NEW.invocation_id
      AND operation_id=CAST(json_extract(NEW.event_json,'$.fact.step_id') AS TEXT)
      AND (observed_at IS NULL OR (tool_observed_at IS NULL AND json_extract(NEW.event_json,'$.fact.event.kind') IN ('tool_call','provider_tool_result'))
        OR (barrier_at IS NULL AND (json_extract(NEW.event_json,'$.fact.event.kind') IN ('provider_tool_result','finished')
    OR (json_extract(NEW.event_json,'$.fact.event.kind')='tool_call' AND json_extract(NEW.event_json,'$.fact.event.data.provider_executed')=1)
    OR (json_extract(NEW.event_json,'$.fact.event.data.provider_options') IS NOT NULL
        AND json_extract(NEW.event_json,'$.fact.event.data.provider_options')!='{}'))) OR (accepted_at IS NULL AND json_extract(NEW.event_json,'$.fact.event.kind') IN ('source','part_finished','tool_call','provider_tool_result')));

    UPDATE context_execution_steps SET terminal_at=NEW.sequence,terminal_kind=NEW.kind,
        terminal_status=json_extract(NEW.event_json,'$.fact.status')
    WHERE NEW.kind IN ('model_completed','model_interrupted')
      AND invocation_id=NEW.invocation_id AND operation_id=NEW.operation_id;

    INSERT INTO context_independent_tools
    SELECT NEW.invocation_id,NEW.operation_id,NEW.sequence
    WHERE NEW.kind IN ('tool_dispatched','tool_rejected')
      AND ((NEW.kind='tool_dispatched' AND (
          json_extract(NEW.event_json,'$.fact.call.origin.kind')='code_cell'
          OR (json_extract(NEW.event_json,'$.fact.call.origin.kind')='host_sdk'
            AND json_extract(NEW.event_json,'$.fact.call.origin.parent_relationship.kind')='evaluation_observer')))
        OR EXISTS(SELECT 1 FROM context_independent_tools p WHERE p.invocation_id=NEW.invocation_id
          AND p.operation_id=json_extract(NEW.event_json,'$.fact.call.origin.parent_operation_id')));

    UPDATE context_execution_work SET closed_at=NEW.sequence
    WHERE NEW.kind='tool_settled' AND invocation_id=NEW.invocation_id AND kind='tool'
      AND operation_id=NEW.operation_id AND closed_at IS NULL;
    UPDATE context_execution_work SET closed_at=NEW.sequence
    WHERE NEW.kind IN ('model_completed','model_interrupted') AND invocation_id=NEW.invocation_id AND kind='model'
      AND operation_id=NEW.operation_id AND closed_at IS NULL;
    UPDATE context_execution_work SET closed_at=NEW.sequence
    WHERE NEW.kind IN ('tool_dispatched','tool_rejected') AND invocation_id=NEW.invocation_id AND kind='call'
      AND operation_id=NEW.operation_id AND closed_at IS NULL;
    UPDATE context_execution_work SET closed_at=NEW.sequence
    WHERE NEW.kind='model_observed' AND json_extract(NEW.event_json,'$.fact.event.kind')='provider_tool_result'
      AND invocation_id=NEW.invocation_id AND kind='accepted_provider'
      AND operation_id=CAST(json_extract(NEW.event_json,'$.fact.step_id') AS TEXT)
      AND call_id=json_extract(NEW.event_json,'$.fact.event.data.id')
      AND call_name=json_extract(NEW.event_json,'$.fact.event.data.name') AND closed_at IS NULL;

INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
SELECT e.invocation_id,'tool',e.operation_id,e.sequence,
    (SELECT MIN(t.sequence) FROM runtime_events t WHERE t.invocation_id=e.invocation_id
       AND t.operation_id=e.operation_id AND t.kind='tool_settled')
FROM runtime_events e WHERE e.kind='tool_dispatched' AND e.sequence=NEW.sequence;

INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
SELECT e.invocation_id,'model',e.operation_id,e.sequence,
    (SELECT MIN(t.sequence) FROM runtime_events t WHERE t.invocation_id=e.invocation_id
       AND t.operation_id=e.operation_id AND t.kind IN ('model_completed','model_interrupted'))
FROM runtime_events e WHERE e.kind='model_requested' AND e.sequence=NEW.sequence;

INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
SELECT e.invocation_id,'call',e.operation_id || ':' || json_extract(p.value,'$.call.id'),e.sequence,
    (SELECT MIN(d.sequence) FROM runtime_events d WHERE d.invocation_id=e.invocation_id
       AND d.operation_id=e.operation_id || ':' || json_extract(p.value,'$.call.id')
       AND d.kind IN ('tool_dispatched','tool_rejected'))
FROM runtime_events e,json_each(e.event_json,'$.fact.output.parts') p
WHERE e.kind='model_completed' AND e.sequence=NEW.sequence AND json_extract(p.value,'$.kind')='tool_call'
  AND json_extract(p.value,'$.call.provider_executed')=0
  AND NOT EXISTS(SELECT 1 FROM context_execution_steps s WHERE s.invocation_id=e.invocation_id
    AND s.operation_id=e.operation_id AND s.item_acceptance=1);

INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at,closed_at)
SELECT e.invocation_id,'call',s.operation_id || ':' || json_extract(e.event_json,'$.fact.event.data.id'),e.sequence,
    (SELECT MIN(d.sequence) FROM runtime_events d WHERE d.invocation_id=e.invocation_id
       AND d.operation_id=s.operation_id || ':' || json_extract(e.event_json,'$.fact.event.data.id')
       AND d.kind IN ('tool_dispatched','tool_rejected'))
FROM runtime_events e JOIN context_execution_steps s ON s.invocation_id=e.invocation_id
    AND s.operation_id=CAST(json_extract(e.event_json,'$.fact.step_id') AS TEXT) AND s.item_acceptance=1
WHERE e.kind='model_observed' AND e.sequence=NEW.sequence AND json_extract(e.event_json,'$.fact.event.kind')='tool_call'
  AND json_extract(e.event_json,'$.fact.event.data.provider_executed')=0;

INSERT INTO context_execution_work(invocation_id,kind,operation_id,call_id,call_name,opened_at,closed_at)
SELECT e.invocation_id,'accepted_provider',s.operation_id,
    json_extract(e.event_json,'$.fact.event.data.id'),json_extract(e.event_json,'$.fact.event.data.name'),e.sequence,
    (SELECT MIN(t.sequence) FROM runtime_events t WHERE t.invocation_id=e.invocation_id AND t.kind='model_observed'
       AND CAST(json_extract(t.event_json,'$.fact.step_id') AS TEXT)=s.operation_id
       AND json_extract(t.event_json,'$.fact.event.kind')='provider_tool_result'
       AND json_extract(t.event_json,'$.fact.event.data.id')=json_extract(e.event_json,'$.fact.event.data.id')
       AND json_extract(t.event_json,'$.fact.event.data.name')=json_extract(e.event_json,'$.fact.event.data.name'))
FROM runtime_events e JOIN context_execution_steps s ON s.invocation_id=e.invocation_id
    AND s.operation_id=CAST(json_extract(e.event_json,'$.fact.step_id') AS TEXT) AND s.item_acceptance=1
WHERE e.kind='model_observed' AND e.sequence=NEW.sequence AND json_extract(e.event_json,'$.fact.event.kind')='tool_call'
  AND json_extract(e.event_json,'$.fact.event.data.provider_executed')=1;

INSERT INTO context_execution_work(invocation_id,kind,operation_id,opened_at)
SELECT e.invocation_id,'completed_provider',e.operation_id,e.sequence
FROM runtime_events e WHERE e.kind='model_completed' AND e.sequence=NEW.sequence
  AND EXISTS(SELECT 1 FROM json_each(e.event_json,'$.fact.output.parts') p
    WHERE json_extract(p.value,'$.kind')='tool_call' AND json_extract(p.value,'$.call.provider_executed')=1
      AND NOT EXISTS(SELECT 1 FROM json_each(e.event_json,'$.fact.output.parts') result
        WHERE json_extract(result.value,'$.kind')='tool_result'
          AND json_extract(result.value,'$.id')=json_extract(p.value,'$.call.id')
          AND json_extract(result.value,'$.name')=json_extract(p.value,'$.call.name')));

INSERT OR IGNORE INTO context_execution_work(invocation_id,kind,operation_id,opened_at)
SELECT s.invocation_id,'interrupted',s.operation_id,
    MAX(s.terminal_at,s.observed_at,CASE WHEN s.terminal_status='retryable_failure' THEN s.barrier_at ELSE s.observed_at END)
FROM context_execution_steps s WHERE s.terminal_kind='model_interrupted' AND s.observed_at IS NOT NULL
  AND (s.terminal_status!='retryable_failure' OR (s.item_acceptance!=1 AND s.barrier_at IS NOT NULL))
  AND NOT COALESCE(s.purpose='summary' AND s.tool_observed_at IS NULL,0) AND s.invocation_id=NEW.invocation_id AND s.operation_id=CAST(json_extract(NEW.event_json,'$.fact.step_id') AS TEXT);
END;

INSERT INTO session_catalog_revision VALUES(1,0);
INSERT INTO plugin_composition VALUES(1,'{"generation":0,"packageLayers":[],"overlays":[]}');

PRAGMA user_version = 1;
