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

-- Canonical session/request domain, deliberately independent of Run identity.
CREATE TABLE agent_queue_events (
 session TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 id TEXT NOT NULL, at INTEGER NOT NULL,
 body_content_id INTEGER NOT NULL REFERENCES contents(id),
 PRIMARY KEY(session,revision), UNIQUE(session,id)
);
CREATE TABLE agent_queue_content_pins (
 session TEXT NOT NULL, request TEXT NOT NULL,
 content_id INTEGER NOT NULL REFERENCES contents(id),
 PRIMARY KEY(session,request,content_id)
);
CREATE INDEX agent_queue_content_pins_content ON agent_queue_content_pins(content_id);
-- Disposable, synchronously folded indexes. Cancelled/delivered associations
-- survive queue removal and are rebuilt from the canonical event stream.
CREATE TABLE agent_queue_heads (session TEXT PRIMARY KEY, revision INTEGER NOT NULL);
CREATE TABLE agent_queue_items (
 session TEXT NOT NULL, request TEXT NOT NULL, message TEXT NOT NULL,
 owner TEXT NOT NULL, position INTEGER NOT NULL, lane TEXT NOT NULL,
 target_run TEXT, state TEXT NOT NULL CHECK(state IN ('pending','cancelled','delivered')),
 accepted_run TEXT, shared INTEGER NOT NULL DEFAULT 0,
 entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
 PRIMARY KEY(session,request), UNIQUE(session,message)
);
CREATE INDEX agent_queue_ready ON agent_queue_items(owner,state,session,position,request);
CREATE INDEX agent_queue_pending ON agent_queue_items(session,state,lane,position,request);
CREATE INDEX agent_queue_steering ON agent_queue_items(session,target_run,state,position,request);
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
 UNION ALL SELECT content_id FROM agent_queue_content_pins;
