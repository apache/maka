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

CREATE TABLE deployment (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    configuration TEXT NOT NULL CHECK (json_valid(configuration) AND length(CAST(configuration AS BLOB)) <= 65536)
) STRICT;

-- Pending intent does not authorize startup; only the active deployment does.
CREATE TABLE deployment_update (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    target TEXT NOT NULL CHECK (json_valid(target) AND length(CAST(target AS BLOB)) <= 65536)
) STRICT;

CREATE TABLE deployment_update_policy (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    configuration TEXT NOT NULL CHECK (json_valid(configuration) AND length(CAST(configuration AS BLOB)) <= 16384)
) STRICT;

PRAGMA user_version = 1;
