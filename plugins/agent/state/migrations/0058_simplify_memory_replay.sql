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

-- Drop session/history read taint tracking and visibility-propagation triggers.
-- Memory replay and revocation are checked directly against agent_memory_tool_inputs
-- joined to current memory versions, without blocking cross-run checkpoints or
-- ordinary session/archive reads.
DROP TRIGGER IF EXISTS agent_memory_tool_revoke;
DROP TRIGGER IF EXISTS agent_memory_rotate_journal;
DROP TRIGGER IF EXISTS agent_memory_change_session;
DROP TRIGGER IF EXISTS agent_memory_history_revoke;
DROP TRIGGER IF EXISTS agent_memory_hidden_span_revoke;
DROP TRIGGER IF EXISTS agent_memory_source_private;
DROP TRIGGER IF EXISTS agent_memory_source_retired;
DROP TRIGGER IF EXISTS agent_memory_source_removal;

DROP VIEW IF EXISTS agent_memory_rotate_external;
DROP VIEW IF EXISTS agent_memory_changed_sessions;
DROP VIEW IF EXISTS agent_memory_adopted_snapshots;
DROP VIEW IF EXISTS agent_memory_evidence_sessions;

DROP INDEX IF EXISTS agent_memory_tool_assertion;
DROP INDEX IF EXISTS agent_memory_tool_revoked;
DROP INDEX IF EXISTS agent_memory_conversation_source;
DROP INDEX IF EXISTS agent_memory_snapshots_by_fact;
DROP INDEX IF EXISTS agent_memory_adoptions_by_snapshot;

DROP TABLE IF EXISTS agent_memory_session_reads;
DROP TABLE IF EXISTS agent_memory_session_visibility;
DROP TABLE IF EXISTS agent_memory_visibility;
DROP TABLE IF EXISTS agent_memory_history_reads;
DROP TABLE IF EXISTS agent_memory_external_sources;
DROP TABLE IF EXISTS agent_memory_external_epochs;

-- Drop the redundant derived revoked column from agent_memory_tool_inputs.
CREATE TABLE agent_memory_tool_inputs_new (
 run TEXT NOT NULL REFERENCES agent_run_specs(run) ON DELETE CASCADE,
 namespace TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL,
 assertion INTEGER NOT NULL, revision INTEGER NOT NULL,
 PRIMARY KEY(run,scope,id,assertion,revision)
) WITHOUT ROWID;
INSERT INTO agent_memory_tool_inputs_new(run,namespace,scope,id,assertion,revision)
 SELECT run,namespace,scope,id,assertion,revision FROM agent_memory_tool_inputs;
DROP TABLE agent_memory_tool_inputs;
ALTER TABLE agent_memory_tool_inputs_new RENAME TO agent_memory_tool_inputs;
CREATE INDEX agent_memory_tool_project ON agent_memory_tool_inputs(run,scope) WHERE scope<>'personal';

ALTER TABLE agent_run_specs DROP COLUMN unmarked_replay_shared;

-- Unwrap session-recap receipts wrapped with a visibility clock in migration 0057.
UPDATE plugin_data SET value_json=json_extract(value_json,'$.receipt')
 WHERE package_id='maka.session-recap' AND scope_id='profile'
 AND json_type(value_json,'$.receipt')='object';
