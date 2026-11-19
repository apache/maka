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

CREATE TABLE agent_memories (
 namespace TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision > 0), assertion INTEGER NOT NULL,
 mode TEXT NOT NULL CHECK(mode IN ('auto_recall','user_recall','user_always')),
 state TEXT NOT NULL CHECK(state IN ('active','unresolved','suppressed')),
 created_at INTEGER NOT NULL, modified_at INTEGER NOT NULL,
 PRIMARY KEY(namespace,scope,id), CHECK(state <> 'suppressed' OR mode <> 'user_always')
);
CREATE INDEX agent_memories_active ON agent_memories(namespace,scope,state,id);
CREATE TABLE agent_memory_versions (
 namespace TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
 body TEXT NOT NULL, source TEXT NOT NULL, corrects INTEGER,
 digest TEXT NOT NULL, disposition TEXT NOT NULL CHECK(disposition IN ('current','corrected','suppressed')),
 PRIMARY KEY(namespace,scope,id,revision),
 FOREIGN KEY(namespace,scope,id) REFERENCES agent_memories(namespace,scope,id)
);
CREATE INDEX agent_memory_matching ON agent_memory_versions(namespace,scope,digest,disposition);
CREATE TABLE agent_memory_scopes (
 namespace TEXT NOT NULL, scope TEXT NOT NULL, revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision > 0),
 PRIMARY KEY(namespace,scope)
);
