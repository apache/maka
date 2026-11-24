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


CREATE TABLE checkpoint_execution_claims (
    activation_id TEXT PRIMARY KEY NOT NULL,
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
);
CREATE TABLE checkpoint_executions (
    activation_id TEXT PRIMARY KEY NOT NULL REFERENCES checkpoint_execution_claims(activation_id),
    session_id TEXT NOT NULL REFERENCES checkpoint_repository_sessions(session_id),
    generation INTEGER NOT NULL CHECK(generation > 0),
    grant_json TEXT NOT NULL CHECK(json_valid(grant_json)),
    state TEXT NOT NULL CHECK(state IN ('active', 'draining', 'stopped')),
    expires_at INTEGER NOT NULL CHECK(expires_at > 0),
    UNIQUE(session_id, generation)
);
CREATE UNIQUE INDEX checkpoint_execution_single_writer
    ON checkpoint_executions(session_id) WHERE state != 'stopped';
CREATE TABLE checkpoint_execution_renewals (
    operation_id TEXT PRIMARY KEY NOT NULL,
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
);
CREATE TABLE checkpoint_execution_commits (
    operation_key TEXT PRIMARY KEY NOT NULL REFERENCES checkpoint_repository_receipts(operation_key),
    grant_json TEXT NOT NULL CHECK(json_valid(grant_json))
);
