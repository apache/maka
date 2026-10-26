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

-- App consent uses the existing append-only interaction facts. Only profile
-- persistence needs mutable authority: revocation advances its revision so a
-- delayed response cannot restore the previously revoked Always grant.
CREATE TABLE computer_app_profile_authority (
    target_key TEXT PRIMARY KEY NOT NULL,
    revision INTEGER NOT NULL CHECK(revision BETWEEN 0 AND 9007199254740991),
    source_request TEXT REFERENCES interaction_requests(request_id)
) STRICT;

CREATE UNIQUE INDEX computer_app_native_effect ON interaction_requests(
    session_id,
    json_extract(record_json, '$.request.nativeOperationId')
) WHERE json_extract(record_json, '$.request.kind') = 'computer_app';

-- An observed app remains selectable between completed native calls in the same
-- logical Turn. Its first source T1 is an immutable, host-resolved selection.
CREATE TABLE computer_app_turn_activity (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    app_key TEXT NOT NULL,
    source_event TEXT NOT NULL REFERENCES event_log(event_id),
    operation_id TEXT NOT NULL,
    record_json TEXT NOT NULL,
    PRIMARY KEY(session_id,turn_id,app_key),
    UNIQUE(session_id,operation_id)
) STRICT;

CREATE TABLE computer_app_turn_stops (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    app_key TEXT NOT NULL,
    stopped_at INTEGER NOT NULL CHECK(stopped_at BETWEEN 0 AND 9007199254740991),
    PRIMARY KEY(session_id,turn_id,app_key),
    FOREIGN KEY(session_id,turn_id,app_key)
        REFERENCES computer_app_turn_activity(session_id,turn_id,app_key) ON DELETE CASCADE
) STRICT;
