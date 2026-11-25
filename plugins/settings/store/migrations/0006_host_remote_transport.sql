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

CREATE TABLE host_remote_transport (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    relay_only INTEGER NOT NULL CHECK (relay_only IN (0, 1)),
    relays TEXT NOT NULL CHECK (json_valid(relays))
) STRICT;

INSERT INTO host_remote_transport VALUES (1, 0, 0, '[]');

ALTER TABLE host_peer_access ADD COLUMN last_active_at TEXT;
UPDATE host_peer_access SET last_active_at = created_at WHERE created_at <> '';
