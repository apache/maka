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

ALTER TABLE host_peer_access ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE host_peer_access ADD COLUMN created_at TEXT NOT NULL DEFAULT '';

CREATE TABLE host_peer_pairing_invites (
    invite_id TEXT PRIMARY KEY NOT NULL,
    secret_hash BLOB NOT NULL UNIQUE CHECK (length(secret_hash) = 32),
    host_grant TEXT NOT NULL,
    label TEXT,
    expires_at_ms INTEGER NOT NULL,
    created_at TEXT NOT NULL
) STRICT, WITHOUT ROWID;

CREATE INDEX host_peer_pairing_invites_expiry ON host_peer_pairing_invites (expires_at_ms);
