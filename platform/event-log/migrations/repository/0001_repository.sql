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


CREATE TABLE checkpoint_repository_settings (
    singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
    repository_id TEXT NOT NULL
);
CREATE TABLE checkpoint_repository_sessions (
    session_id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL
);
CREATE TABLE checkpoint_repository_sources (
    source_key TEXT PRIMARY KEY NOT NULL,
    source_json TEXT NOT NULL CHECK(json_valid(source_json)),
    session_id TEXT NOT NULL REFERENCES checkpoint_repository_sessions(session_id)
);
CREATE INDEX checkpoint_repository_source_session ON checkpoint_repository_sources(session_id);
CREATE TABLE checkpoint_repository_receipts (
    operation_key TEXT PRIMARY KEY NOT NULL,
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
);
