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

CREATE TABLE agent_cells (
 cell TEXT PRIMARY KEY, session TEXT NOT NULL, run TEXT,
 pending INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body))
);
CREATE INDEX agent_cells_pending ON agent_cells(run,pending,cell);
CREATE INDEX agent_cells_session ON agent_cells(session,cell);
CREATE UNIQUE INDEX agent_cell_parent ON agent_cells(run,json_extract(body,'$.owner.link.attempt'),json_extract(body,'$.owner.call')) WHERE run IS NOT NULL;

CREATE TABLE agent_cell_operation_pins (
 cell TEXT NOT NULL, operation TEXT NOT NULL, reference_json TEXT NOT NULL CHECK(json_valid(reference_json)),
 PRIMARY KEY(cell,operation)
);
CREATE TABLE agent_session_values (
 session TEXT NOT NULL, key TEXT NOT NULL,
 value_content_id INTEGER NOT NULL REFERENCES contents(id),
 fact_id TEXT NOT NULL, PRIMARY KEY(session,key)
);
CREATE TABLE agent_session_loaded_tools (
 session TEXT PRIMARY KEY, body TEXT NOT NULL CHECK(json_valid(body)), fact_id TEXT NOT NULL
);
CREATE TABLE agent_cell_notifications (
 notification TEXT PRIMARY KEY, cell TEXT NOT NULL, session TEXT NOT NULL, run TEXT,
 content_id INTEGER NOT NULL REFERENCES contents(id), consumed_step TEXT,
 queued_fact TEXT NOT NULL, queued_sequence INTEGER NOT NULL, consumed_fact TEXT
);
CREATE INDEX agent_cell_notifications_pending ON agent_cell_notifications(run,consumed_step,queued_sequence);
-- Only standalone sessions use this source. Agent Cell evidence lives exclusively in agent_facts.
CREATE TABLE agent_standalone_cell_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 cell TEXT NOT NULL, session TEXT NOT NULL, at INTEGER NOT NULL,
 agent_cursor INTEGER NOT NULL,
 body_content_id INTEGER NOT NULL REFERENCES contents(id)
);
CREATE INDEX agent_standalone_cell_history ON agent_standalone_cell_events(session,sequence);
CREATE TABLE agent_standalone_cell_pins (
 cell TEXT NOT NULL, content_id INTEGER NOT NULL REFERENCES contents(id),
 PRIMARY KEY(cell,content_id)
);
CREATE INDEX agent_standalone_cell_pins_content ON agent_standalone_cell_pins(content_id);
DROP VIEW content_references;

CREATE VIEW content_references AS
    SELECT body_id AS content_id FROM event_log WHERE body_id IS NOT NULL
    UNION ALL SELECT c.id FROM artifacts a JOIN contents c USING(content_sha256)
    UNION ALL SELECT content_id FROM tool_result_payloads
    UNION ALL SELECT content_id FROM tool_result_parts
    UNION ALL SELECT content_id FROM application_package_files
    UNION ALL SELECT system_content_id FROM request_compositions WHERE system_content_id IS NOT NULL
    UNION ALL SELECT content_id FROM composition_tools
    UNION ALL SELECT outcome_content_id FROM application_operations WHERE outcome_content_id IS NOT NULL
    UNION ALL SELECT c.id FROM history_snapshot_artifacts a JOIN contents c USING(content_sha256) UNION ALL SELECT metadata_content_id FROM history_snapshot_captures
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
 UNION ALL SELECT content_id FROM agent_standalone_cell_pins;
