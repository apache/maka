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

CREATE INDEX agent_run_specs_history ON agent_run_specs(owner,session,run);
-- All rows are disposable references into the original canonical fact stream.
-- No body, semantic result or independent lifecycle is recorded here.
CREATE TABLE agent_session_history (
 owner TEXT NOT NULL, session TEXT NOT NULL,
 sequence INTEGER NOT NULL REFERENCES agent_facts(sequence),
 run TEXT NOT NULL REFERENCES agent_run_specs(run), admission_sequence INTEGER NOT NULL,
 step TEXT, attempt TEXT, kind TEXT NOT NULL, prefix_digest TEXT NOT NULL,
 tool_use_id TEXT, tool_start INTEGER NOT NULL CHECK(tool_start IN(0,1)), opening_message INTEGER NOT NULL CHECK(opening_message IN(0,1)),
 fact_id TEXT NOT NULL UNIQUE REFERENCES agent_facts(id),
 result_source INTEGER NOT NULL CHECK(result_source IN(0,1)), tool_name TEXT,
 PRIMARY KEY(owner,session,sequence), UNIQUE(sequence)
) WITHOUT ROWID;
CREATE INDEX agent_session_history_run ON agent_session_history(owner,session,run,step,kind,sequence);
CREATE INDEX agent_session_history_kind ON agent_session_history(owner,session,kind,sequence);
CREATE INDEX agent_session_history_tool ON agent_session_history(owner,session,tool_use_id,sequence);
CREATE INDEX agent_session_history_result ON agent_session_history(owner,session,result_source,fact_id,sequence);
CREATE INDEX agent_session_history_message ON agent_session_history(owner,session,opening_message,sequence);
CREATE TABLE agent_history_queue_requests (
 session TEXT NOT NULL, request TEXT NOT NULL, revision INTEGER NOT NULL,
 event_id TEXT NOT NULL,
 PRIMARY KEY(session,request,revision),
 FOREIGN KEY(session,revision) REFERENCES agent_queue_events(session,revision)
) WITHOUT ROWID;
-- The first canonical introduction prevents a frozen source cut from reading
-- later contents merely because the same Run has since acquired another pin.
CREATE TABLE agent_history_content_refs (
 owner TEXT NOT NULL, session TEXT NOT NULL,
 run TEXT NOT NULL REFERENCES agent_run_specs(run),
 content_id INTEGER NOT NULL REFERENCES contents(id),
 first_sequence INTEGER NOT NULL REFERENCES agent_facts(sequence),
 PRIMARY KEY(owner,session,run,content_id)
) WITHOUT ROWID;
