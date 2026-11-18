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

-- Preserve the original target of paginated Read calls for classification at read time.
DROP TRIGGER agent_memory_recall_call_insert;
DROP VIEW agent_memory_recall_call_source;
DROP VIEW agent_memory_recall_outputs;
ALTER TABLE agent_memory_recall_calls ADD COLUMN read_path TEXT;
CREATE VIEW agent_memory_recall_call_source AS
 SELECT sequence,run,tool_use_id,cell,CASE WHEN name='Read' THEN path END AS read_path FROM (
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
UPDATE agent_memory_recall_calls AS k SET read_path=s.read_path
 FROM agent_memory_recall_call_source s WHERE s.sequence=k.sequence AND s.read_path IS NOT NULL;
CREATE TRIGGER agent_memory_recall_call_insert AFTER INSERT ON agent_session_history WHEN NEW.tool_start=1 BEGIN
 INSERT INTO agent_memory_recall_calls SELECT * FROM agent_memory_recall_call_source WHERE sequence=NEW.sequence;
END;
CREATE VIEW agent_memory_recall_outputs AS
 SELECT r.owner,r.fact_id AS fact,k.read_path
 FROM agent_session_history r JOIN agent_memory_recall_calls k
   ON k.run=r.run AND k.tool_use_id=r.tool_use_id AND r.sequence>k.sequence
 WHERE r.result_source=1 OR r.kind IN ('cell','operation_observed','external_task_observed','model_observed')
 UNION ALL
 SELECT r.owner,r.fact_id,k.read_path
 FROM agent_session_history r JOIN agent_facts f ON f.sequence=r.sequence
 JOIN contents b ON b.id=f.body_content_id
 JOIN agent_memory_recall_calls k ON k.run=r.run AND k.cell=json_extract(CAST(b.payload AS TEXT),'$.fact.event.cell')
 WHERE r.kind='cell' AND r.tool_use_id IS NULL AND r.sequence>k.sequence
 UNION ALL
 SELECT r.owner,r.fact_id,k.read_path
 FROM agent_session_history r JOIN agent_facts f ON f.sequence=r.sequence
 JOIN contents b ON b.id=f.body_content_id
 JOIN agent_cells cell ON cell.run=r.run AND json_extract(cell.body,'$.owner.link.attempt')=r.attempt
   AND json_extract(cell.body,'$.owner.call')=json_extract(CAST(b.payload AS TEXT),'$.fact.tool.call')
 JOIN agent_memory_recall_calls k ON k.run=r.run AND k.cell=cell.cell
 WHERE r.result_source=1;
