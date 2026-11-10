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

CREATE TABLE agent_usage_aux_specs (
 request TEXT PRIMARY KEY, owner TEXT NOT NULL, session TEXT NOT NULL,
 source_key TEXT NOT NULL UNIQUE,
 spec_content_id INTEGER NOT NULL REFERENCES contents(id)
);
CREATE TABLE agent_usage_aux_events (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
 request TEXT NOT NULL REFERENCES agent_usage_aux_specs(request),
 at INTEGER NOT NULL CHECK(at>=0), body_content_id INTEGER NOT NULL REFERENCES contents(id)
);
CREATE INDEX agent_usage_aux_request ON agent_usage_aux_events(request,sequence);
CREATE TABLE agent_usage_calls (
 request TEXT PRIMARY KEY, source TEXT NOT NULL CHECK(source IN ('fact','auxiliary','cell')),
 kind TEXT NOT NULL CHECK(kind IN ('model','tool')),
 owner TEXT, session TEXT NOT NULL, run TEXT,
 admission_sequence INTEGER NOT NULL CHECK(admission_sequence>0),
 started_at INTEGER NOT NULL CHECK(started_at>=0),
 model_id TEXT, provider_id TEXT, name TEXT, purpose TEXT,
 binding_json TEXT CHECK(binding_json IS NULL OR json_valid(binding_json)),
 quote_json TEXT CHECK(quote_json IS NULL OR json_valid(quote_json)),
 origin_json TEXT NOT NULL CHECK(json_valid(origin_json))
);
CREATE INDEX agent_usage_call_scope ON agent_usage_calls(owner,session,admission_sequence,request);
CREATE INDEX agent_usage_call_time ON agent_usage_calls(started_at,request);
CREATE TABLE agent_usage_results (
 request TEXT NOT NULL REFERENCES agent_usage_calls(request) ON DELETE CASCADE,
 sequence INTEGER NOT NULL CHECK(sequence>0),
 completed_at INTEGER CHECK(completed_at IS NULL OR completed_at>=0),
 outcome TEXT CHECK(outcome IN ('success','error','aborted','unknown','rejected')),
 rejection TEXT,
 input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, reasoning INTEGER,
 cost_usd REAL,
 cleanup_json TEXT CHECK(cleanup_json IS NULL OR json_valid(cleanup_json)),
 PRIMARY KEY(request,sequence)
);
CREATE INDEX agent_usage_result_time ON agent_usage_results(completed_at DESC,request ASC,sequence DESC);

CREATE INDEX agent_usage_call_owner_time ON agent_usage_calls(owner,session,started_at,request);
CREATE INDEX agent_usage_call_session_time ON agent_usage_calls(session,started_at,request);

CREATE INDEX agent_recall_scope_runs ON agent_run_specs(owner,session,run);

-- Disposable exact-source text indexes. Canonical facts, RunSpec inputs and
-- consumed request snapshots retain all original bodies and media descriptors.
CREATE TABLE agent_recall_messages (
 id INTEGER PRIMARY KEY, owner TEXT NOT NULL, session TEXT NOT NULL,
 sequence INTEGER NOT NULL REFERENCES agent_facts(sequence), ordinal INTEGER NOT NULL,
 run TEXT NOT NULL REFERENCES agent_run_specs(run), turn TEXT NOT NULL,
 message TEXT NOT NULL, at INTEGER NOT NULL, role TEXT NOT NULL,
 body TEXT NOT NULL, folded TEXT NOT NULL,
 fields_json TEXT NOT NULL CHECK(json_valid(fields_json)),
 origin_json TEXT CHECK(origin_json IS NULL OR json_valid(origin_json)),
 internal INTEGER NOT NULL CHECK(internal IN(0,1)),
 attachments TEXT NOT NULL CHECK(json_valid(attachments)),
 references_json TEXT NOT NULL CHECK(json_valid(references_json)),
 UNIQUE(owner,session,sequence,ordinal), UNIQUE(owner,session,message)
);
CREATE INDEX agent_recall_message_order ON agent_recall_messages(owner,session,sequence,ordinal);
CREATE INDEX agent_recall_visible_order ON agent_recall_messages(owner,session,internal,sequence,ordinal);
CREATE INDEX agent_recall_turn ON agent_recall_messages(owner,session,turn,sequence,ordinal);
CREATE VIRTUAL TABLE agent_recall_terms USING fts5(grams, tokenize='ascii');
CREATE TABLE agent_recall_heads (
 owner TEXT NOT NULL, session TEXT NOT NULL, sequence INTEGER NOT NULL,
 digest TEXT NOT NULL, PRIMARY KEY(owner,session)
) WITHOUT ROWID;
CREATE TABLE agent_recall_gaps (
 owner TEXT NOT NULL, session TEXT NOT NULL, sequence INTEGER NOT NULL,
 reason TEXT NOT NULL, PRIMARY KEY(owner,session,sequence)
) WITHOUT ROWID;

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
 UNION ALL SELECT content_id FROM agent_standalone_cell_pins
 UNION ALL SELECT spec_content_id FROM agent_usage_aux_specs
 UNION ALL SELECT body_content_id FROM agent_usage_aux_events;
