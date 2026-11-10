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

CREATE TABLE agent_history_snapshot_imports (
 ingest TEXT PRIMARY KEY,
 owner TEXT NOT NULL, session TEXT NOT NULL, operation TEXT NOT NULL,
 expected_json TEXT NOT NULL CHECK(json_valid(expected_json)),
 snapshot TEXT NOT NULL REFERENCES agent_history_snapshots(snapshot),
 manifest_content_id INTEGER NOT NULL REFERENCES contents(id),
 UNIQUE(owner,session,operation)
);
CREATE INDEX agent_history_snapshot_artifact_page ON agent_history_snapshot_entries(snapshot,json_extract(entry_json,'$.owner'),json_extract(entry_json,'$.session'),ordinal) WHERE kind='artifact';
CREATE INDEX agent_history_snapshot_artifact_session_page ON agent_history_snapshot_entries(snapshot,json_extract(entry_json,'$.session'),ordinal) WHERE kind='artifact';
CREATE INDEX agent_history_snapshot_artifact_record ON agent_history_snapshot_entries(snapshot,json_extract(entry_json,'$.session'),json_extract(entry_json,'$.record.artifact.id')) WHERE kind='artifact';

-- Transaction-local copy proofs and graph worklists, emptied before successful
-- publication. These contain references only, never a second payload/event log.
CREATE TABLE agent_history_snapshot_ingest_frames (
 ingest TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 content_id INTEGER NOT NULL REFERENCES contents(id),
 PRIMARY KEY(ingest,ordinal), UNIQUE(ingest,content_id)
) WITHOUT ROWID;
CREATE TABLE agent_history_snapshot_ingest_nodes (
 ingest TEXT NOT NULL, snapshot TEXT NOT NULL,
 manifest_content_id INTEGER NOT NULL REFERENCES contents(id),
 state INTEGER NOT NULL CHECK(state IN (0,1,2)),
 remaining INTEGER NOT NULL CHECK(remaining>=0),
 PRIMARY KEY(ingest,snapshot), UNIQUE(ingest,manifest_content_id)
) WITHOUT ROWID;
CREATE INDEX agent_history_snapshot_ingest_pending ON agent_history_snapshot_ingest_nodes(ingest,state,remaining,snapshot);
CREATE TABLE agent_history_snapshot_ingest_edges (
 ingest TEXT NOT NULL, parent TEXT NOT NULL, run TEXT NOT NULL, child TEXT NOT NULL,
 PRIMARY KEY(ingest,parent,run)
) WITHOUT ROWID;
CREATE INDEX agent_history_snapshot_ingest_children ON agent_history_snapshot_ingest_edges(ingest,parent,child);
CREATE INDEX agent_history_snapshot_ingest_parents ON agent_history_snapshot_ingest_edges(ingest,child,parent);
