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

-- Disposable safe projections over original Agent facts, not another event stream.
CREATE TABLE agent_diagnostics (
 sequence INTEGER PRIMARY KEY REFERENCES agent_facts(sequence),
 run TEXT NOT NULL REFERENCES agent_run_specs(run),
 owner TEXT NOT NULL, session TEXT NOT NULL,
 event_id TEXT NOT NULL, at INTEGER NOT NULL CHECK(at>=0),
 detail_json TEXT NOT NULL CHECK(json_valid(detail_json))
);
CREATE INDEX agent_diagnostics_scope ON agent_diagnostics(owner,session,sequence DESC);
CREATE INDEX agent_diagnostics_run ON agent_diagnostics(run,sequence);
CREATE TABLE agent_diagnostic_coverage (
 run TEXT PRIMARY KEY REFERENCES agent_run_specs(run),
 revision INTEGER NOT NULL CHECK(revision>0),
 sequence INTEGER NOT NULL REFERENCES agent_facts(sequence),
 FOREIGN KEY(run,revision) REFERENCES agent_facts(run,revision)
);
