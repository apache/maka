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

-- Keep restricted assertions out of normal Recall postings, including prefix counts.
CREATE TABLE agent_memory_recall_keys (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, namespace TEXT NOT NULL, scope TEXT NOT NULL,
    id TEXT NOT NULL, UNIQUE(namespace,scope,id)
);
CREATE VIRTUAL TABLE agent_memory_recall_terms USING fts5(location, body, prefix='1 2 3');
CREATE VIEW agent_memory_recall_current AS
 SELECT k.seq, hex(m.namespace)||'x'||hex(m.scope) AS location, v.body
 FROM agent_memory_recall_keys k JOIN agent_memories m USING(namespace,scope,id)
 JOIN agent_memory_versions v ON v.namespace=m.namespace AND v.scope=m.scope
 AND v.id=m.id AND v.revision=m.assertion
 WHERE m.state='active' AND v.disposition='current';
INSERT INTO agent_memory_recall_keys(namespace,scope,id) SELECT namespace,scope,id FROM agent_memories;
INSERT INTO agent_memory_recall_terms(rowid,location,body) SELECT * FROM agent_memory_recall_current;

CREATE TRIGGER agent_memory_recall_key AFTER INSERT ON agent_memories BEGIN
 INSERT INTO agent_memory_recall_keys(namespace,scope,id) VALUES(NEW.namespace,NEW.scope,NEW.id);
END;
CREATE TRIGGER agent_memory_recall_version AFTER INSERT ON agent_memory_versions BEGIN
 INSERT INTO agent_memory_recall_terms(rowid,location,body)
 SELECT r.* FROM agent_memory_recall_current r JOIN agent_memory_recall_keys k ON r.seq=k.seq
 WHERE k.namespace=NEW.namespace AND k.scope=NEW.scope AND k.id=NEW.id
 AND EXISTS (SELECT 1 FROM agent_memories m WHERE m.namespace=k.namespace AND m.scope=k.scope AND m.id=k.id AND m.assertion=NEW.revision);
END;
CREATE TRIGGER agent_memory_recall_change AFTER UPDATE OF state,assertion ON agent_memories
WHEN OLD.state<>NEW.state OR OLD.assertion<>NEW.assertion BEGIN
 DELETE FROM agent_memory_recall_terms WHERE rowid=(SELECT seq FROM agent_memory_recall_keys
 WHERE namespace=NEW.namespace AND scope=NEW.scope AND id=NEW.id);
 INSERT INTO agent_memory_recall_terms(rowid,location,body)
 SELECT r.* FROM agent_memory_recall_current r JOIN agent_memory_recall_keys k ON r.seq=k.seq
 WHERE k.namespace=NEW.namespace AND k.scope=NEW.scope AND k.id=NEW.id;
END;

CREATE INDEX agent_memory_evidence_address ON agent_memory_evidence(namespace,
 json_extract(source,'$.reference.factId'),json_extract(source,'$.reference.itemIndex'));
CREATE VIEW agent_memory_hidden_spans AS
 SELECT e.namespace,json_extract(e.source,'$.reference.factId') AS fact,
 json_extract(e.source,'$.reference.itemIndex') AS ordinal,
 json_extract(e.source,'$.reference.start') AS start,json_extract(e.source,'$.reference.end') AS end,
 json_extract(e.source,'$.reference.sessionId') AS session,json_extract(e.source,'$.reference.sequence') AS sequence
 FROM agent_memory_evidence e JOIN agent_memory_versions v ON v.namespace=e.namespace AND v.scope=e.scope
 AND v.id=e.id AND v.revision=e.assertion JOIN agent_memories m ON m.namespace=e.namespace
 AND m.scope=e.scope AND m.id=e.id
 WHERE e.source->>'kind'='conversation' AND (v.disposition<>'current' OR m.state<>'active' OR m.assertion<>e.assertion);

-- Bound cache checks by original operation/cell identity, including CodeMode
-- parent results that may contain a child's returned text.
CREATE TABLE agent_memory_recall_calls (
 sequence INTEGER PRIMARY KEY REFERENCES agent_session_history(sequence) ON DELETE CASCADE,
 run TEXT NOT NULL, tool_use_id TEXT NOT NULL, cell TEXT
);
CREATE INDEX agent_memory_recall_call_id ON agent_memory_recall_calls(run,tool_use_id);
CREATE INDEX agent_memory_recall_call_cell ON agent_memory_recall_calls(run,cell);
CREATE VIEW agent_memory_recall_call_source AS
 SELECT sequence,run,tool_use_id,cell FROM (
   SELECT h.sequence,h.run,h.tool_use_id,json_extract(CAST(b.payload AS TEXT),'$.fact.event.cell') AS cell,
    coalesce(json_extract(CAST(b.payload AS TEXT),'$.fact.part.call.name'),json_extract(CAST(b.payload AS TEXT),'$.fact.event.name'),
       json_extract(CAST(b.payload AS TEXT),'$.fact.output.name'),json_extract(CAST(x.payload AS TEXT),'$.name')) AS name,
    coalesce(json_extract(CAST(b.payload AS TEXT),'$.fact.part.call.input.data.path'),json_extract(CAST(b.payload AS TEXT),'$.fact.output.input.path'),
       json_extract(CAST(x.payload AS TEXT),'$.input.path'),json_extract(CAST(i.payload AS TEXT),'$.path')) AS path
   FROM agent_session_history h JOIN agent_facts f ON f.sequence=h.sequence JOIN contents b ON b.id=f.body_content_id
   LEFT JOIN contents x ON x.content_sha256=json_extract(CAST(b.payload AS TEXT),'$.fact.event.descriptor.digest')
   LEFT JOIN contents i ON i.content_sha256=json_extract(CAST(b.payload AS TEXT),'$.fact.event.input.digest')
   WHERE h.tool_start=1
 ) WHERE name IN ('Recall','RecallMore','RecallMaterial','SessionRead')
    OR (name='Read' AND (path GLOB 'maka://*' OR path GLOB 'attachment:*' OR path GLOB 'session:*' OR path GLOB 'archive:*'));
INSERT INTO agent_memory_recall_calls SELECT * FROM agent_memory_recall_call_source;
CREATE TRIGGER agent_memory_recall_call_insert AFTER INSERT ON agent_session_history WHEN NEW.tool_start=1 BEGIN
 INSERT INTO agent_memory_recall_calls SELECT * FROM agent_memory_recall_call_source WHERE sequence=NEW.sequence;
END;

CREATE VIEW agent_memory_recall_outputs AS
 SELECT r.owner,r.fact_id AS fact FROM agent_session_history r
 WHERE (r.result_source=1 OR r.kind IN ('cell','operation_observed','external_task_observed','model_observed'))
 AND (
   EXISTS(SELECT 1 FROM agent_memory_recall_calls k WHERE k.run=r.run AND k.tool_use_id=r.tool_use_id AND r.sequence>k.sequence)
   OR (r.kind='cell' AND r.tool_use_id IS NULL AND EXISTS (
     SELECT 1 FROM agent_facts f JOIN contents b ON b.id=f.body_content_id
     JOIN agent_memory_recall_calls k ON k.run=r.run AND k.cell=json_extract(CAST(b.payload AS TEXT),'$.fact.event.cell')
     WHERE f.sequence=r.sequence AND r.sequence>k.sequence))
   OR (r.result_source=1 AND EXISTS (
     SELECT 1 FROM agent_facts f JOIN contents b ON b.id=f.body_content_id
     JOIN agent_cells cell ON cell.run=r.run AND json_extract(cell.body,'$.owner.link.attempt')=r.attempt
       AND json_extract(cell.body,'$.owner.call')=json_extract(CAST(b.payload AS TEXT),'$.fact.tool.call')
     JOIN agent_memory_recall_calls k ON k.run=r.run AND k.cell=cell.cell WHERE f.sequence=r.sequence))
 );

CREATE TABLE agent_memory_recall_attachments(
 namespace TEXT NOT NULL, session TEXT NOT NULL, artifact TEXT NOT NULL, message INTEGER NOT NULL
 REFERENCES agent_recall_messages(id) ON DELETE CASCADE,
 PRIMARY KEY(namespace,session,artifact,message)
) WITHOUT ROWID;
CREATE INDEX agent_memory_recall_attachment_message ON agent_memory_recall_attachments(message);
CREATE VIEW agent_memory_recall_attachment_source AS
 SELECT d.owner,a.value->>'$.ref.sessionId',a.value->>'$.ref.relativePath',d.id AS message
 FROM agent_recall_messages d,json_each(d.attachments) a WHERE a.value->>'$.ref.kind'='session_file';
INSERT OR IGNORE INTO agent_memory_recall_attachments SELECT * FROM agent_memory_recall_attachment_source;
CREATE TRIGGER agent_memory_attachment_insert AFTER INSERT ON agent_recall_messages WHEN NEW.attachments<>'[]' BEGIN
 INSERT OR IGNORE INTO agent_memory_recall_attachments SELECT * FROM agent_memory_recall_attachment_source WHERE message=NEW.id;
END;
CREATE TRIGGER agent_memory_attachment_update AFTER UPDATE OF attachments ON agent_recall_messages
WHEN NEW.attachments<>OLD.attachments BEGIN
 DELETE FROM agent_memory_recall_attachments WHERE message=OLD.id;
 INSERT OR IGNORE INTO agent_memory_recall_attachments SELECT * FROM agent_memory_recall_attachment_source WHERE message=NEW.id;
END;
