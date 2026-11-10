-- Licensed to the Apache Software Foundation (ASF) under one
-- or more contributor license agreements. See the NOTICE file
-- distributed with this work for additional information
-- regarding copyright ownership. The ASF licenses this file
-- to you under the Apache License, Version 2.0 (the
-- "License"); you may not use this file except in compliance
-- with the License. You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing,
-- software distributed under the License is distributed on an
-- "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
-- KIND, either express or implied. See the License for the
-- specific language governing permissions and limitations
-- under the License.


DROP TRIGGER agent_history_snapshot_nav_chunk_insert;
DROP TRIGGER agent_history_snapshot_nav_chunk_update;
DROP TRIGGER agent_history_snapshot_nav_chunk_delete;
DROP TABLE agent_history_snapshot_nav_terms;
CREATE VIRTUAL TABLE agent_history_snapshot_nav_terms
 USING fts5(grams,content='',contentless_delete=1,detail=none,tokenize='ascii');
INSERT INTO agent_history_snapshot_nav_terms(rowid,grams)
 SELECT id,grams FROM agent_history_snapshot_nav_chunks ORDER BY id;

CREATE TABLE agent_history_snapshot_nav_chunks_new (
 id INTEGER PRIMARY KEY,
 document INTEGER NOT NULL, field_ordinal INTEGER NOT NULL,
 ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 start INTEGER NOT NULL CHECK(start>=0),
 body TEXT NOT NULL,
 UNIQUE(document,field_ordinal,ordinal),
 FOREIGN KEY(document,field_ordinal)
   REFERENCES agent_history_snapshot_nav_fields(document,ordinal) ON DELETE CASCADE
);
INSERT INTO agent_history_snapshot_nav_chunks_new
 SELECT id,document,field_ordinal,ordinal,start,body FROM agent_history_snapshot_nav_chunks ORDER BY id;
DROP TABLE agent_history_snapshot_nav_chunks;
ALTER TABLE agent_history_snapshot_nav_chunks_new RENAME TO agent_history_snapshot_nav_chunks;
CREATE TRIGGER agent_history_snapshot_nav_chunk_delete AFTER DELETE ON agent_history_snapshot_nav_chunks BEGIN
 DELETE FROM agent_history_snapshot_nav_terms WHERE rowid=old.id;
END;

CREATE VIRTUAL TABLE agent_recall_terms_new
 USING fts5(grams,content='',contentless_delete=1,detail=none,tokenize='ascii');
INSERT INTO agent_recall_terms_new(rowid,grams) SELECT rowid,grams FROM agent_recall_terms ORDER BY rowid;
DROP TABLE agent_recall_terms;
ALTER TABLE agent_recall_terms_new RENAME TO agent_recall_terms;

DROP INDEX agent_history_snapshot_artifact;
DROP INDEX agent_history_snapshot_revision;
DROP INDEX agent_history_snapshot_step;
DROP INDEX agent_history_snapshot_run;
DROP INDEX agent_history_snapshot_source;
CREATE INDEX agent_history_snapshot_artifact
 ON agent_history_snapshot_entries(snapshot,json_extract(entry_json,'$.owner'),json_extract(entry_json,'$.session'),json_extract(entry_json,'$.record.artifact.id'),run,sequence)
 WHERE kind='artifact';
CREATE INDEX agent_history_snapshot_revision
 ON agent_history_snapshot_entries(snapshot,run,json_extract(entry_json,'$.revision'))
 WHERE kind='fact';
CREATE INDEX agent_history_snapshot_step
 ON agent_history_snapshot_entries(snapshot,run,json_extract(entry_json,'$.step'),sequence)
 WHERE kind='fact';
CREATE INDEX agent_history_snapshot_run
 ON agent_history_snapshot_entries(snapshot,kind,run,sequence,ordinal)
 WHERE kind='run' OR kind='fact';
CREATE INDEX agent_history_snapshot_source
 ON agent_history_snapshot_entries(snapshot,kind,sequence,position)
 WHERE kind='source' OR kind='run' OR kind='position';
