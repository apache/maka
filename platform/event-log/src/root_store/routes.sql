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

CREATE TABLE IF NOT EXISTS session_routes(
    session_id TEXT PRIMARY KEY,
    creation_id TEXT NOT NULL,
    partition INTEGER NOT NULL CHECK(partition>=0 AND partition<8),
    fingerprint TEXT NOT NULL,
    command TEXT,
    ready INTEGER NOT NULL CHECK(ready IN(0,1,2)),
    failure TEXT,
    visible INTEGER NOT NULL DEFAULT 1 CHECK(visible IN(0,1)),
    CHECK((session_id=creation_id)=(command IS NOT NULL)),
    CHECK((ready=2)=(failure IS NOT NULL))
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS pending_session_routes ON session_routes(session_id) WHERE ready=0;
CREATE INDEX IF NOT EXISTS session_route_partitions ON session_routes(partition);

CREATE INDEX IF NOT EXISTS session_route_creations ON session_routes(creation_id);
