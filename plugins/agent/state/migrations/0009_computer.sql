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

CREATE TABLE agent_computer_facts (
 sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
 run TEXT NOT NULL REFERENCES agent_run_specs(run), at INTEGER NOT NULL,
 schema_version INTEGER NOT NULL, fact_json TEXT NOT NULL CHECK(json_valid(fact_json))
);
CREATE INDEX agent_computer_facts_run ON agent_computer_facts(run,sequence);
-- All following rows are disposable projections of these facts and canonical interaction outcomes.
CREATE TABLE agent_computer_subjects (
 operation TEXT NOT NULL, run TEXT NOT NULL, session TEXT NOT NULL, owner TEXT NOT NULL,
 target TEXT NOT NULL, subject_json TEXT NOT NULL CHECK(json_valid(subject_json)), sequence INTEGER NOT NULL, PRIMARY KEY(session,operation)
);
CREATE UNIQUE INDEX agent_computer_subjects_run ON agent_computer_subjects(run,operation);
CREATE TABLE agent_computer_activities (
 run TEXT NOT NULL, target TEXT NOT NULL, operation TEXT NOT NULL, sequence INTEGER NOT NULL, PRIMARY KEY(run,target)
);
CREATE TABLE agent_computer_stops (
 run TEXT NOT NULL, target TEXT NOT NULL, source_operation TEXT NOT NULL, PRIMARY KEY(run,target)
);
CREATE TABLE agent_computer_authorizations (
 run TEXT NOT NULL, operation TEXT NOT NULL, request TEXT, basis TEXT NOT NULL, PRIMARY KEY(run,operation)
);
CREATE INDEX agent_computer_authorizations_request ON agent_computer_authorizations(request);
CREATE TABLE agent_computer_revocations (
 owner TEXT NOT NULL, target TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(owner,target)
);
CREATE TABLE agent_computer_grants (
 request TEXT PRIMARY KEY REFERENCES agent_interaction_requests(request),
 owner TEXT NOT NULL, session TEXT NOT NULL, run TEXT NOT NULL, target TEXT NOT NULL,
 operation TEXT NOT NULL, basis TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('once','session','profile')), authority_revision INTEGER NOT NULL
);
CREATE INDEX agent_computer_grants_target ON agent_computer_grants(owner,target,authority_revision,scope,session,run,operation);
