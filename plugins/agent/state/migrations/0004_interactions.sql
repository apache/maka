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

-- Canonical immutable request and first-writer answer. Eligibility is captured
-- at answer time; replay must not reinterpret a late answer as fresh authority.
CREATE TABLE agent_interaction_requests (
 request TEXT PRIMARY KEY, session TEXT NOT NULL,
 run TEXT NOT NULL REFERENCES agent_run_specs(run), created_at INTEGER NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 record_json TEXT NOT NULL CHECK(json_valid(record_json)),
 basis_json TEXT CHECK(basis_json IS NULL OR json_valid(basis_json)),
 approval TEXT UNIQUE, binding_json TEXT CHECK(binding_json IS NULL OR json_valid(binding_json)),
 CHECK((approval IS NULL) = (binding_json IS NULL)),
 CHECK(approval IS NULL OR basis_json IS NOT NULL),
 UNIQUE(session,revision)
);
CREATE INDEX agent_interaction_requests_session ON agent_interaction_requests(session,revision);
CREATE INDEX agent_interaction_requests_target ON agent_interaction_requests(run,json_extract(binding_json,'$.target'));
CREATE INDEX agent_interaction_requests_run ON agent_interaction_requests(run,created_at,request);
CREATE TABLE agent_interaction_outcomes (
 request TEXT PRIMARY KEY REFERENCES agent_interaction_requests(request),
 session TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
 outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json)),
 eligible INTEGER NOT NULL CHECK(eligible IN (0,1)),
 UNIQUE(session,revision)
);
CREATE INDEX agent_interaction_outcomes_session ON agent_interaction_outcomes(session,revision);

-- Disposable same-transaction indexes. No lifecycle timer and no second grant ledger.
CREATE TABLE agent_interaction_heads (session TEXT PRIMARY KEY, revision INTEGER NOT NULL);
CREATE TABLE agent_interaction_pending (
 session TEXT NOT NULL, created_at INTEGER NOT NULL, request TEXT NOT NULL,
 PRIMARY KEY(session,created_at,request), UNIQUE(request)
);
CREATE TABLE agent_interaction_grants (
 request TEXT PRIMARY KEY REFERENCES agent_interaction_requests(request),
 session TEXT NOT NULL, run TEXT NOT NULL, basis TEXT NOT NULL,
 scope TEXT NOT NULL CHECK(scope IN ('once','run','session')),
 approval TEXT, target TEXT, permissions TEXT NOT NULL CHECK(json_valid(permissions))
);
CREATE INDEX agent_interaction_grants_scope ON agent_interaction_grants(session,basis,scope,run,target,request);
CREATE TABLE agent_interaction_capabilities (
 session TEXT NOT NULL, target TEXT NOT NULL, request TEXT NOT NULL,
 grant_json TEXT NOT NULL CHECK(json_valid(grant_json)), PRIMARY KEY(session,target)
);
