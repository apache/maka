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

-- Independent user decisions are canonical, not a disposable unread cache.
CREATE TABLE agent_catalog_events (
 owner TEXT NOT NULL, session TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 id TEXT NOT NULL, at INTEGER NOT NULL, schema_version INTEGER NOT NULL,
 command_json TEXT NOT NULL CHECK(json_valid(command_json)),
 event_json TEXT NOT NULL CHECK(json_valid(event_json)),
 PRIMARY KEY(owner,session,revision), UNIQUE(owner,session,id)
) WITHOUT ROWID;
CREATE TABLE agent_catalog_controls (
 owner TEXT NOT NULL, session TEXT NOT NULL, revision INTEGER NOT NULL,
 read_through INTEGER NOT NULL DEFAULT 0, read_message TEXT,
 lineage TEXT CHECK(lineage IS NULL OR json_valid(lineage)),
 PRIMARY KEY(owner,session)
) WITHOUT ROWID;
CREATE TABLE agent_catalog_sessions (
 owner TEXT NOT NULL, session TEXT NOT NULL, last_sequence INTEGER NOT NULL,
 terminal_sequence INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(owner,session)
) WITHOUT ROWID;
CREATE TABLE agent_catalog_messages (
 owner TEXT NOT NULL, session TEXT NOT NULL, sequence INTEGER NOT NULL REFERENCES agent_facts(sequence),
 message TEXT NOT NULL, at INTEGER NOT NULL, preview TEXT,
 PRIMARY KEY(owner,session,sequence)
) WITHOUT ROWID;
CREATE INDEX agent_catalog_messages_time ON agent_catalog_messages(owner,session,at DESC,sequence DESC);
CREATE TABLE agent_catalog_runs (
 run TEXT PRIMARY KEY REFERENCES agent_run_specs(run), owner TEXT NOT NULL, session TEXT NOT NULL,
 admission_sequence INTEGER NOT NULL, live INTEGER NOT NULL DEFAULT 0,
 terminal TEXT, stopped INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0,
 unknown_effects INTEGER NOT NULL DEFAULT 0, cleanup_pending INTEGER NOT NULL DEFAULT 0,
 terminal_sequence INTEGER NOT NULL DEFAULT 0, late_sequence INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX agent_catalog_latest_run ON agent_catalog_runs(owner,session,admission_sequence DESC);
CREATE INDEX agent_catalog_live ON agent_catalog_runs(owner,session,live);
CREATE INDEX agent_catalog_blocked ON agent_catalog_runs(owner,session,blocked);
CREATE INDEX agent_catalog_unknown ON agent_catalog_runs(owner,session,unknown_effects);
CREATE INDEX agent_catalog_cleanup ON agent_catalog_runs(owner,session,cleanup_pending);
CREATE INDEX agent_catalog_late ON agent_catalog_runs(owner,session,late_sequence);
CREATE TABLE agent_catalog_revision (singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision INTEGER NOT NULL);
INSERT INTO agent_catalog_revision VALUES(1,0);
CREATE TRIGGER agent_catalog_fact_insert AFTER INSERT ON agent_facts BEGIN
 UPDATE agent_catalog_revision SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER agent_catalog_control_insert AFTER INSERT ON agent_catalog_events BEGIN
 UPDATE agent_catalog_revision SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER agent_catalog_interaction_insert AFTER INSERT ON agent_interaction_requests BEGIN
 UPDATE agent_catalog_revision SET revision=revision+1 WHERE singleton=1;
END;
CREATE TRIGGER agent_catalog_answer_insert AFTER INSERT ON agent_interaction_outcomes BEGIN
 UPDATE agent_catalog_revision SET revision=revision+1 WHERE singleton=1;
END;
