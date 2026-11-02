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

CREATE TABLE history_checkpoint_bindings (
    session_id TEXT PRIMARY KEY NOT NULL,
    scope_json TEXT NOT NULL CHECK(json_valid(scope_json))
);
CREATE TABLE history_checkpoint_heads (
    session_id TEXT PRIMARY KEY NOT NULL REFERENCES history_checkpoint_bindings(session_id),
    head_json TEXT NOT NULL CHECK(json_valid(head_json))
);
CREATE TABLE history_checkpoint_publications (
    request_key TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL REFERENCES history_checkpoint_bindings(session_id),
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    publication_json TEXT NOT NULL CHECK(json_valid(publication_json))
);
CREATE INDEX history_checkpoint_recovery ON history_checkpoint_publications(request_key)
WHERE json_extract(publication_json,'$.state.kind') IN ('capturing','prepared')
   OR json_extract(publication_json,'$.cleanup_pending')=1;
