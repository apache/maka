/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

CREATE TEMP TABLE retained_tool_result_payloads AS SELECT * FROM tool_result_payloads;
DROP TABLE tool_result_payloads;
CREATE TABLE tool_result_payloads (
    event_id TEXT PRIMARY KEY NOT NULL REFERENCES event_log(event_id),
    payload BLOB NOT NULL
);
INSERT INTO tool_result_payloads SELECT * FROM retained_tool_result_payloads;
DROP TABLE retained_tool_result_payloads;

CREATE TEMP TABLE retained_model_request_compositions AS SELECT * FROM model_request_compositions;
CREATE TEMP TABLE retained_request_compositions AS SELECT * FROM request_compositions;
DROP TABLE model_request_compositions;
DROP TABLE request_compositions;
CREATE TABLE request_compositions (
    digest TEXT PRIMARY KEY NOT NULL,
    surface BLOB NOT NULL
);
INSERT INTO request_compositions SELECT * FROM retained_request_compositions;
DROP TABLE retained_request_compositions;
CREATE TABLE model_request_compositions (
    event_id TEXT PRIMARY KEY NOT NULL REFERENCES event_log(event_id),
    digest TEXT NOT NULL REFERENCES request_compositions(digest)
);
INSERT INTO model_request_compositions SELECT * FROM retained_model_request_compositions;
DROP TABLE retained_model_request_compositions;
