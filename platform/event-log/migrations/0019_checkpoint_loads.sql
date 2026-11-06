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

CREATE TABLE history_checkpoint_loads (
    load_key TEXT PRIMARY KEY NOT NULL,
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    result_json TEXT NOT NULL CHECK(json_valid(result_json))
);
CREATE INDEX history_checkpoint_load_recovery ON history_checkpoint_loads(load_key)
WHERE json_extract(result_json,'$.state.kind')='preparing';

CREATE TABLE checkpoint_workspace_restores (
    restore_key TEXT PRIMARY KEY NOT NULL,
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    prepared_json TEXT NOT NULL CHECK(json_valid(prepared_json)),
    directory_identity_json TEXT CHECK(directory_identity_json IS NULL OR json_valid(directory_identity_json)),
    result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))
);
