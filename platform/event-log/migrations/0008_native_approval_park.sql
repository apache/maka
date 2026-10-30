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

CREATE TABLE native_approval_checkpoints (
 id TEXT PRIMARY KEY,
 session_id TEXT NOT NULL,
 invocation_id TEXT NOT NULL,
 checkpoint_json TEXT NOT NULL CHECK(json_valid(checkpoint_json)),
 pending_json TEXT NOT NULL CHECK(json_valid(pending_json)),
 revision INTEGER NOT NULL,
 active INTEGER NOT NULL CHECK(active IN (0,1)),
 revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
) STRICT;
CREATE UNIQUE INDEX native_approval_session_owner ON native_approval_checkpoints(session_id) WHERE active=1;
CREATE UNIQUE INDEX native_approval_invocation_owner ON native_approval_checkpoints(invocation_id) WHERE active=1;
CREATE TABLE native_approval_operations (
 checkpoint_id TEXT NOT NULL REFERENCES native_approval_checkpoints(id),
 operation_id TEXT NOT NULL,
 interaction_id TEXT NOT NULL REFERENCES interaction_requests(request_id),
 phase TEXT NOT NULL CHECK(phase IN ('waiting','claimed','started','settled')),
 claim TEXT,
 host_epoch TEXT,
 start_id TEXT,
 terminal_event_id TEXT,
 PRIMARY KEY(checkpoint_id,operation_id)
) STRICT;
CREATE INDEX native_approval_unfinished ON native_approval_operations(checkpoint_id,phase,interaction_id);
CREATE INDEX native_approval_interaction ON native_approval_operations(interaction_id,checkpoint_id);
