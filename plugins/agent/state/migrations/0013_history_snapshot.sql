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

-- The immutable manifest is the source. Inventory rows only index references
-- into it; no copied execution event, permission or independent result ledger.
CREATE TABLE agent_history_snapshots (
 snapshot TEXT PRIMARY KEY,
 owner TEXT NOT NULL, session TEXT NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 manifest_content_id INTEGER NOT NULL UNIQUE REFERENCES contents(id)
);
CREATE TABLE agent_history_snapshot_pins (
 snapshot TEXT NOT NULL REFERENCES agent_history_snapshots(snapshot) DEFERRABLE INITIALLY DEFERRED,
 content_id INTEGER NOT NULL REFERENCES contents(id),
 PRIMARY KEY(snapshot,content_id)
) WITHOUT ROWID;
CREATE INDEX agent_history_snapshot_pinned ON agent_history_snapshot_pins(content_id);
CREATE TABLE agent_history_snapshot_entries (
 snapshot TEXT NOT NULL REFERENCES agent_history_snapshots(snapshot) DEFERRABLE INITIALLY DEFERRED,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0), kind TEXT NOT NULL,
 run TEXT, sequence INTEGER, position INTEGER,
 entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
 PRIMARY KEY(snapshot,ordinal)
) WITHOUT ROWID;
CREATE INDEX agent_history_snapshot_run ON agent_history_snapshot_entries(snapshot,kind,run,sequence,ordinal);
CREATE INDEX agent_history_snapshot_source ON agent_history_snapshot_entries(snapshot,kind,sequence,position);
CREATE UNIQUE INDEX agent_history_snapshot_fact ON agent_history_snapshot_entries(snapshot,sequence) WHERE kind='fact';
CREATE INDEX agent_history_snapshot_revision ON agent_history_snapshot_entries(snapshot,kind,run,json_extract(entry_json,'$.revision'));
CREATE INDEX agent_history_snapshot_step ON agent_history_snapshot_entries(snapshot,kind,run,json_extract(entry_json,'$.step'),sequence);
CREATE INDEX agent_history_snapshot_artifact ON agent_history_snapshot_entries(snapshot,kind,json_extract(entry_json,'$.owner'),json_extract(entry_json,'$.session'),json_extract(entry_json,'$.record.artifact.id'),run,sequence);
CREATE TABLE agent_history_snapshot_run_refs (
 snapshot TEXT NOT NULL REFERENCES agent_history_snapshots(snapshot) DEFERRABLE INITIALLY DEFERRED,
 run TEXT NOT NULL, content_id INTEGER NOT NULL REFERENCES contents(id),
 PRIMARY KEY(snapshot,run,content_id)
) WITHOUT ROWID;
CREATE TABLE agent_history_snapshot_adoptions (
 run TEXT PRIMARY KEY REFERENCES agent_run_specs(run),
 snapshot TEXT NOT NULL REFERENCES agent_history_snapshots(snapshot),
 fact TEXT NOT NULL REFERENCES agent_facts(id)
);

DROP VIEW content_references;
CREATE VIEW content_references AS
    SELECT content_id FROM application_package_files
    UNION ALL SELECT outcome_content_id FROM application_operations WHERE outcome_content_id IS NOT NULL
    UNION ALL SELECT spec_content_id FROM agent_run_specs
    UNION ALL SELECT content_id FROM agent_request_specs
    UNION ALL SELECT content_id FROM agent_answer_parts
    UNION ALL SELECT body_content_id FROM agent_facts
    UNION ALL SELECT content_id FROM agent_content_pins
    UNION ALL SELECT body_content_id FROM agent_queue_events
    UNION ALL SELECT content_id FROM agent_queue_content_pins
    UNION ALL SELECT body_content_id FROM agent_session_artifact_registrations
    UNION ALL SELECT content_id FROM agent_session_artifact_registrations
    UNION ALL SELECT provenance_content_id FROM agent_session_artifact_registrations WHERE provenance_content_id IS NOT NULL
    UNION ALL SELECT content_id FROM agent_artifacts
    UNION ALL SELECT body_content_id FROM agent_standalone_cell_events
    UNION ALL SELECT content_id FROM agent_standalone_cell_pins
    UNION ALL SELECT spec_content_id FROM agent_usage_aux_specs
    UNION ALL SELECT body_content_id FROM agent_usage_aux_events
    UNION ALL SELECT manifest_content_id FROM agent_history_snapshots
    UNION ALL SELECT content_id FROM agent_history_snapshot_pins;

CREATE INDEX agent_history_snapshot_fact_identity ON agent_history_snapshot_entries(snapshot,json_extract(entry_json,'$.id')) WHERE kind='fact';

CREATE INDEX agent_history_snapshot_tool_source ON agent_history_snapshot_entries(snapshot,json_extract(entry_json,'$.tool_use_id'),sequence) WHERE kind='fact';
