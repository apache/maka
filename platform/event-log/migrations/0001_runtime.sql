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

CREATE TABLE contents (
    id INTEGER PRIMARY KEY,
    content_sha256 TEXT NOT NULL UNIQUE,
    payload BLOB NOT NULL
);

CREATE VIEW content_references AS
    SELECT content_id FROM application_package_files
    UNION ALL SELECT outcome_content_id FROM application_operations WHERE outcome_content_id IS NOT NULL;

CREATE TABLE session_control (
    id TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived INTEGER NOT NULL CHECK(archived IN (0, 1)),
    configuration TEXT NOT NULL,
    catalog_unpinned INTEGER
    GENERATED ALWAYS AS (
        CASE WHEN json_extract(configuration, '$.pinned') = 1 THEN 0 ELSE 1 END
    ) VIRTUAL
, catalog_activity_at INTEGER NOT NULL DEFAULT 0, catalog_recency INTEGER
    GENERATED ALWAYS AS (-max(created_at, catalog_activity_at)) VIRTUAL);

CREATE TABLE session_catalog_revision (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    revision INTEGER NOT NULL CHECK(revision >= 0)
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

CREATE TABLE plugin_data (
    package_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    key TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    value_json TEXT CHECK (value_json IS NULL OR json_valid(value_json)),
    PRIMARY KEY (package_id, scope_id, key)
);

CREATE TABLE plugin_sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    package_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    authority_session_id TEXT,
    CHECK(authority_session_id IS NULL OR authority_session_id != session_id)
);

CREATE TABLE host_effects (
    id TEXT PRIMARY KEY,
    package_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    request TEXT NOT NULL CHECK(json_valid(request)),
    outcome TEXT CHECK(outcome IS NULL OR (json_valid(outcome))),
    payload BLOB,
    CHECK(outcome IS NOT NULL OR payload IS NULL)
) STRICT;

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
    content_id INTEGER NOT NULL REFERENCES contents(id),
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
    outcome_content_id INTEGER REFERENCES contents(id),
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

CREATE TABLE history_checkpoint_bindings (
    session_id TEXT PRIMARY KEY NOT NULL,
    scope_json TEXT NOT NULL CHECK(json_valid(scope_json))
);

CREATE TABLE history_checkpoint_heads (
    session_id TEXT PRIMARY KEY NOT NULL REFERENCES history_checkpoint_bindings(session_id),
    head_json TEXT NOT NULL CHECK(json_valid(head_json))
);

CREATE TABLE history_checkpoint_publications (
    request_key TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES history_checkpoint_bindings(session_id),
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    publication_json TEXT NOT NULL CHECK(json_valid(publication_json))
);

CREATE TABLE history_checkpoint_loads (
    load_key TEXT PRIMARY KEY NOT NULL,
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    result_json TEXT NOT NULL CHECK(json_valid(result_json))
);

CREATE TABLE checkpoint_workspace_restores (
    restore_key TEXT PRIMARY KEY NOT NULL,
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    prepared_json TEXT NOT NULL CHECK(json_valid(prepared_json)),
    directory_identity_json TEXT CHECK(directory_identity_json IS NULL OR json_valid(directory_identity_json)),
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))
);

CREATE TABLE session_creations (
    session_id TEXT PRIMARY KEY,
    creation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    command TEXT,
    ready INTEGER NOT NULL CHECK(ready IN(0,1,2)),
    failure TEXT,
    visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN(0,1)),
    CHECK((session_id=creation_id)=(command IS NOT NULL)),
    CHECK((ready=2)=(failure IS NOT NULL))
) WITHOUT ROWID;

CREATE INDEX session_processes_pending ON session_processes(session_id) WHERE cleaned=0;

CREATE INDEX host_effects_namespace ON host_effects(package_id, scope_id);

CREATE INDEX application_package_references ON application_source_packages(id, revision);

CREATE INDEX plugin_session_parent ON plugin_sessions(authority_session_id, session_id)
    WHERE authority_session_id IS NOT NULL;

CREATE INDEX shell_runs_session_order ON shell_runs(session_id, started_at, id);

CREATE INDEX shell_runs_active ON shell_runs(active) WHERE active = 1;

CREATE INDEX project_identity_owner ON project_identities(project_id, id);

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

CREATE INDEX session_catalog_pin_order
    ON session_control(catalog_unpinned, catalog_recency, id);

CREATE INDEX history_checkpoint_recovery ON history_checkpoint_publications(request_key)
WHERE json_extract(publication_json,'$.state.kind') IN ('capturing','prepared')
   OR json_extract(publication_json,'$.cleanup_pending')=1;

CREATE INDEX session_catalog_children
    ON session_control(json_extract(configuration, '$.parentSessionId'),
        catalog_unpinned, catalog_recency, id);

CREATE INDEX history_checkpoint_load_recovery ON history_checkpoint_loads(load_key)
WHERE json_extract(result_json,'$.state.kind')='preparing';

CREATE INDEX pending_session_creations ON session_creations(session_id) WHERE ready=0;

CREATE INDEX session_creation_families ON session_creations(creation_id);

INSERT INTO "session_catalog_revision" VALUES(1,1);

CREATE TRIGGER content_immutable BEFORE UPDATE ON contents BEGIN SELECT RAISE(ABORT,'content is immutable'); END;

CREATE TRIGGER package_content_released AFTER DELETE ON application_package_files  BEGIN
    DELETE FROM contents WHERE id=OLD.content_id AND NOT EXISTS(SELECT 1 FROM content_references r WHERE r.content_id=contents.id);
END;
PRAGMA application_id = 1296124754;
PRAGMA user_version = 1;

CREATE INDEX operation_content_refs ON application_operations(outcome_content_id) WHERE outcome_content_id IS NOT NULL;
CREATE INDEX package_content_refs ON application_package_files(content_id);
CREATE TRIGGER operation_content_released AFTER DELETE ON application_operations WHEN OLD.outcome_content_id IS NOT NULL BEGIN
    DELETE FROM contents WHERE id=OLD.outcome_content_id AND NOT EXISTS(SELECT 1 FROM content_references r WHERE r.content_id=contents.id);
END;
