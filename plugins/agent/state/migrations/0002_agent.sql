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

CREATE TABLE agent_run_specs (
 run TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, owner TEXT NOT NULL,
 session TEXT NOT NULL, spec_content_id INTEGER NOT NULL REFERENCES contents(id)
);
CREATE INDEX agent_run_specs_session ON agent_run_specs(session,run);
CREATE TABLE agent_request_specs (
 step TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES agent_run_specs(run),
 content_id INTEGER NOT NULL REFERENCES contents(id)
);
CREATE TABLE agent_attempt_ids (
 attempt TEXT PRIMARY KEY, run TEXT NOT NULL REFERENCES agent_run_specs(run),
 step TEXT NOT NULL REFERENCES agent_request_specs(step)
);
CREATE TABLE agent_facts (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT,
 id TEXT NOT NULL UNIQUE, run TEXT NOT NULL REFERENCES agent_run_specs(run),
 revision INTEGER NOT NULL CHECK(revision>0), schema_version INTEGER NOT NULL,
 at INTEGER NOT NULL, body_content_id INTEGER NOT NULL REFERENCES contents(id),
 UNIQUE(run,revision)
);
CREATE TABLE agent_model_items (
 run TEXT NOT NULL REFERENCES agent_run_specs(run), attempt TEXT NOT NULL,
 item_index INTEGER NOT NULL, fact_id TEXT NOT NULL REFERENCES agent_facts(id),
 PRIMARY KEY(run,attempt,item_index)
);
CREATE TABLE agent_content_pins (
 run TEXT NOT NULL REFERENCES agent_run_specs(run), content_id INTEGER NOT NULL REFERENCES contents(id),
 PRIMARY KEY(run,content_id)
);
CREATE INDEX agent_content_pins_content ON agent_content_pins(content_id);
CREATE TABLE agent_operation_pins (
 run TEXT NOT NULL REFERENCES agent_run_specs(run), tool TEXT NOT NULL,
 reference_json TEXT NOT NULL CHECK(json_valid(reference_json)), PRIMARY KEY(run,tool)
);
CREATE TABLE agent_runs (
 run TEXT PRIMARY KEY REFERENCES agent_run_specs(run), schema_version INTEGER NOT NULL,
 owner TEXT NOT NULL, session TEXT NOT NULL, admission_sequence INTEGER NOT NULL, local INTEGER NOT NULL,
 revision INTEGER NOT NULL, control_version INTEGER NOT NULL,
 stopped INTEGER NOT NULL, terminal TEXT, tokens INTEGER NOT NULL, retries INTEGER NOT NULL,
 retry_due_at INTEGER, retry_pending TEXT, current_step TEXT, current_attempt TEXT,
 cancelled_by_risk INTEGER NOT NULL, replans TEXT NOT NULL, baseline TEXT, external TEXT,
 stop_request TEXT, stop_assessed TEXT
);
CREATE INDEX agent_runs_live ON agent_runs(owner,terminal,admission_sequence);
CREATE INDEX agent_runs_session ON agent_runs(session,admission_sequence);
CREATE INDEX agent_runs_due ON agent_runs(owner,terminal,retry_due_at);
CREATE TABLE agent_answer_parts (
 run TEXT NOT NULL REFERENCES agent_run_specs(run), revision INTEGER NOT NULL,
 start INTEGER NOT NULL, end INTEGER NOT NULL, content_id INTEGER NOT NULL REFERENCES contents(id),
 PRIMARY KEY(run,start), UNIQUE(run,revision)
);
CREATE INDEX agent_answer_end ON agent_answer_parts(run,end);

CREATE TABLE agent_steps (
 run TEXT NOT NULL REFERENCES agent_run_specs(run), key TEXT NOT NULL,
 pending INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(run,key)
);
CREATE INDEX agent_steps_pending ON agent_steps(run,pending,key);
CREATE TABLE agent_attempts (
 run TEXT NOT NULL REFERENCES agent_run_specs(run), key TEXT NOT NULL,
 pending INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(run,key)
);
CREATE INDEX agent_attempts_pending ON agent_attempts(run,pending,key);
CREATE TABLE agent_tools (
 run TEXT NOT NULL REFERENCES agent_run_specs(run), key TEXT NOT NULL,
 pending INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(run,key)
);
CREATE INDEX agent_tools_pending ON agent_tools(run,pending,key);
CREATE TABLE agent_approvals (
 run TEXT NOT NULL REFERENCES agent_run_specs(run), key TEXT NOT NULL,
 pending INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(run,key)
);
CREATE INDEX agent_approvals_pending ON agent_approvals(run,pending,key);
CREATE TABLE agent_blockers (
 run TEXT NOT NULL REFERENCES agent_run_specs(run), key TEXT NOT NULL,
 pending INTEGER NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(run,key)
);
CREATE INDEX agent_blockers_pending ON agent_blockers(run,pending,key);
CREATE TABLE agent_waits (
 run TEXT NOT NULL REFERENCES agent_run_specs(run), key TEXT NOT NULL,
 pending INTEGER NOT NULL, due_at INTEGER, body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(run,key)
);
CREATE INDEX agent_waits_due ON agent_waits(pending,due_at,run,key);
CREATE INDEX agent_waits_run ON agent_waits(run,pending,key);
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
 UNION ALL SELECT content_id FROM agent_content_pins;
