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

-- Rebuildable navigation caches over frozen facts/parts, never inventory authority.
CREATE TABLE agent_history_snapshot_nav_documents (
 id INTEGER PRIMARY KEY,
 snapshot TEXT NOT NULL, kind TEXT NOT NULL, major INTEGER NOT NULL, minor INTEGER NOT NULL,
 turn TEXT, turn_ordinal INTEGER CHECK(turn_ordinal IS NULL OR turn_ordinal>=0),
 role TEXT NOT NULL, label TEXT NOT NULL, complete INTEGER NOT NULL CHECK(complete IN(0,1)),
 origin_json TEXT CHECK(origin_json IS NULL OR json_valid(origin_json)),
 CHECK((kind='canonical' AND turn IS NOT NULL AND turn_ordinal IS NULL)
    OR (kind='imported' AND turn_ordinal IS NOT NULL)),
 UNIQUE(snapshot,kind,major,minor),
 FOREIGN KEY(snapshot,kind,major,minor)
   REFERENCES agent_history_snapshot_positions(snapshot,kind,major,minor) ON DELETE CASCADE
);
CREATE INDEX agent_history_snapshot_nav_turn
 ON agent_history_snapshot_nav_documents(snapshot,kind,turn,major,minor);
CREATE INDEX agent_history_snapshot_nav_imported_turn
 ON agent_history_snapshot_nav_documents(snapshot,kind,turn_ordinal,major,minor);
CREATE TABLE agent_history_snapshot_nav_fields (
 document INTEGER NOT NULL REFERENCES agent_history_snapshot_nav_documents(id) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 field TEXT NOT NULL,
 internal INTEGER NOT NULL CHECK(internal IN(0,1)),
 bytes INTEGER NOT NULL CHECK(bytes>=0),
 PRIMARY KEY(document,ordinal)
) WITHOUT ROWID;
CREATE TABLE agent_history_snapshot_nav_chunks (
 id INTEGER PRIMARY KEY,
 document INTEGER NOT NULL, field_ordinal INTEGER NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 start INTEGER NOT NULL CHECK(start>=0),
 body TEXT NOT NULL, grams TEXT NOT NULL,
 UNIQUE(document,field_ordinal,ordinal),
 FOREIGN KEY(document,field_ordinal)
   REFERENCES agent_history_snapshot_nav_fields(document,ordinal) ON DELETE CASCADE
);
CREATE VIRTUAL TABLE agent_history_snapshot_nav_terms
 USING fts5(grams,content='agent_history_snapshot_nav_chunks',content_rowid='id',tokenize='ascii');
CREATE TRIGGER agent_history_snapshot_nav_chunk_insert AFTER INSERT ON agent_history_snapshot_nav_chunks BEGIN
 INSERT INTO agent_history_snapshot_nav_terms(rowid,grams) VALUES(new.id,new.grams);
END;
CREATE TRIGGER agent_history_snapshot_nav_chunk_delete AFTER DELETE ON agent_history_snapshot_nav_chunks BEGIN
 INSERT INTO agent_history_snapshot_nav_terms(agent_history_snapshot_nav_terms,rowid,grams)
 VALUES('delete',old.id,old.grams);
END;
CREATE TRIGGER agent_history_snapshot_nav_chunk_update AFTER UPDATE ON agent_history_snapshot_nav_chunks BEGIN
 INSERT INTO agent_history_snapshot_nav_terms(agent_history_snapshot_nav_terms,rowid,grams)
 VALUES('delete',old.id,old.grams);
 INSERT INTO agent_history_snapshot_nav_terms(rowid,grams) VALUES(new.id,new.grams);
END;
CREATE TABLE agent_history_snapshot_nav_heads (
 snapshot TEXT PRIMARY KEY REFERENCES agent_history_snapshots(snapshot),
 version INTEGER NOT NULL CHECK(version>0)
) WITHOUT ROWID;
