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

-- Pre-Run uploads/copies are session-owned canonical registrations. Tool
-- descriptors are canonical only in ToolReturn; the tables below index them.
CREATE TABLE agent_session_artifact_registrations (
 session TEXT NOT NULL, artifact TEXT NOT NULL, owner TEXT NOT NULL,
 operation TEXT NOT NULL, body_content_id INTEGER NOT NULL REFERENCES contents(id),
 content_id INTEGER NOT NULL REFERENCES contents(id),
 provenance_content_id INTEGER REFERENCES contents(id),
 PRIMARY KEY(session,artifact), UNIQUE(session,operation)
);
CREATE INDEX agent_session_artifact_content ON agent_session_artifact_registrations(content_id);
CREATE TABLE agent_artifacts (
 session TEXT NOT NULL, artifact TEXT NOT NULL, owner TEXT NOT NULL,
 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 content_id INTEGER NOT NULL REFERENCES contents(id),
 PRIMARY KEY(session,artifact)
);
CREATE INDEX agent_artifacts_owner ON agent_artifacts(owner,session,artifact);
CREATE TABLE agent_artifact_run_bindings (
 run TEXT NOT NULL REFERENCES agent_run_specs(run), session TEXT NOT NULL, artifact TEXT NOT NULL,
 fact TEXT NOT NULL REFERENCES agent_facts(id), revision INTEGER NOT NULL CHECK(revision>0),
 origin TEXT NOT NULL CHECK(origin IN ('tool','cell','input','steering')),
 tool_json TEXT CHECK(tool_json IS NULL OR json_valid(tool_json)),
 cell_json TEXT CHECK(cell_json IS NULL OR json_valid(cell_json)), source_digest TEXT NOT NULL, source_bytes INTEGER NOT NULL,
 CHECK((origin='tool')=(tool_json IS NOT NULL)),
 CHECK((origin='cell')=(cell_json IS NOT NULL)),
 PRIMARY KEY(run,artifact,fact),
 FOREIGN KEY(session,artifact) REFERENCES agent_artifacts(session,artifact) ON DELETE CASCADE
);
CREATE INDEX agent_artifact_bindings_fact ON agent_artifact_run_bindings(run,fact,artifact);
CREATE INDEX agent_artifact_bindings_session ON agent_artifact_run_bindings(session,artifact,run);
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
    UNION ALL SELECT content_id FROM agent_artifacts;
