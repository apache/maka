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


ALTER TABLE agent_memory_versions ADD COLUMN method TEXT NOT NULL DEFAULT 'user_input' CHECK(method IN ('user_input','extraction'));
CREATE INDEX agent_memories_mode ON agent_memories(namespace,scope,mode,state,id);
CREATE INDEX agent_memory_evidence_observed ON agent_memory_evidence(namespace,scope,id,assertion,json_extract(source,'$.observedAt') DESC);
CREATE TABLE agent_memory_matches (
 namespace TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL, assertion INTEGER NOT NULL,
 body TEXT NOT NULL, digest TEXT NOT NULL,
 UNIQUE(namespace,scope,id,assertion,digest),
 FOREIGN KEY(namespace,scope,id,assertion) REFERENCES agent_memory_versions(namespace,scope,id,revision) ON DELETE CASCADE
);
CREATE INDEX agent_memory_matches_digest ON agent_memory_matches(namespace,scope,digest,id,assertion);
INSERT INTO agent_memory_matches(namespace,scope,id,assertion,body,digest)
 SELECT namespace,scope,id,revision,body,digest FROM agent_memory_versions;
CREATE TRIGGER agent_memory_match_insert AFTER INSERT ON agent_memory_versions BEGIN
 INSERT INTO agent_memory_matches(namespace,scope,id,assertion,body,digest) VALUES(new.namespace,new.scope,new.id,new.revision,new.body,new.digest);
END;
CREATE VIRTUAL TABLE agent_memory_search USING fts5(location, body, tokenize='trigram');
INSERT INTO agent_memory_search(rowid,location,body) SELECT rowid,namespace || ':' || scope,body FROM agent_memory_matches;
CREATE TRIGGER agent_memory_search_insert AFTER INSERT ON agent_memory_matches BEGIN
 INSERT INTO agent_memory_search(rowid,location,body) VALUES(new.rowid,new.namespace || ':' || new.scope,new.body);
END;
CREATE TRIGGER agent_memory_search_delete AFTER DELETE ON agent_memory_matches BEGIN
 DELETE FROM agent_memory_search WHERE rowid=old.rowid;
END;
CREATE TABLE agent_memory_relations (
 namespace TEXT NOT NULL, scope TEXT NOT NULL,
 id TEXT NOT NULL, assertion INTEGER NOT NULL, target TEXT NOT NULL, target_assertion INTEGER NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('equivalent','conflict','restored')),
 PRIMARY KEY(namespace,scope,id,assertion,target,target_assertion,kind)
);
CREATE INDEX agent_memory_relations_target ON agent_memory_relations(namespace,scope,target,target_assertion,kind,id,assertion);
