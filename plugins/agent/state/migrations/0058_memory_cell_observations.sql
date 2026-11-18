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

DROP VIEW agent_memory_read_alias_source;
CREATE VIEW agent_memory_read_alias_source AS
 SELECT run,name,kind FROM (
 SELECT r.run,service.value->>'$.selection.name' AS name,coalesce(service.value->>'$.history_reader',CASE
 WHEN service.value->>'$.selection.target.kind'='import' AND service.value->>'$.selection.target.name'='files' AND service.value->>'$.selection.method'='read' THEN 'file'
 WHEN service.value->>'$.selection.target.kind'='export' AND service.value->>'$.selection.target.name'='agent' AND service.value->>'$.selection.method' IN
   ('memory','memories','work','sessionRead','history','historyLandmarks','historyPrompt','historyRequests','source','search','toolImage','attachmentImage') THEN 'session'
 WHEN service.value->>'$.selection.name' IN ('Read','SessionRead','Recall','RecallMore','RecallMaterial')
 AND service.value->>'$.selection.method' NOT IN ('read','memory','memories','work','sessionRead','history','historyLandmarks','historyPrompt','historyRequests','source','search','toolImage','attachmentImage')
 THEN 'other' END) AS kind
 FROM agent_run_specs r CROSS JOIN contents spec ON spec.id=r.spec_content_id
 CROSS JOIN contents selection ON selection.content_sha256=json_extract(CAST(spec.payload AS TEXT),'$.toolSelection.digest')
 CROSS JOIN json_each(CAST(selection.payload AS TEXT),'$.services') service)
 WHERE kind IS NOT NULL;
INSERT OR REPLACE INTO agent_memory_read_aliases SELECT * FROM agent_memory_read_alias_source;
DROP VIEW agent_memory_recall_call_source;
CREATE VIEW agent_memory_recall_call_source AS
 SELECT calls.sequence,calls.run,calls.tool_use_id,calls.cell,CASE WHEN alias.kind='file' OR (alias.kind IS NULL AND calls.name='Read') THEN path END AS read_path FROM (
   SELECT h.sequence,h.run,h.tool_use_id,json_extract(CAST(b.payload AS TEXT),'$.fact.event.cell') AS cell,
    coalesce(json_extract(CAST(b.payload AS TEXT),'$.fact.part.call.name'),json_extract(CAST(b.payload AS TEXT),'$.fact.event.name'),
       json_extract(CAST(b.payload AS TEXT),'$.fact.output.name'),json_extract(CAST(x.payload AS TEXT),'$.name')) AS name,
    coalesce(json_extract(CAST(b.payload AS TEXT),'$.fact.part.call.input.data.path'),json_extract(CAST(b.payload AS TEXT),'$.fact.output.input.path'),
       json_extract(CAST(x.payload AS TEXT),'$.input.path'),json_extract(CAST(i.payload AS TEXT),'$.path')) AS path
   FROM agent_session_history h JOIN agent_facts f ON f.sequence=h.sequence JOIN contents b ON b.id=f.body_content_id
   LEFT JOIN contents x ON x.content_sha256=json_extract(CAST(b.payload AS TEXT),'$.fact.event.descriptor.digest')
   LEFT JOIN contents i ON i.content_sha256=json_extract(CAST(b.payload AS TEXT),'$.fact.event.input.digest')
   WHERE h.tool_start=1
 ) calls LEFT JOIN agent_memory_read_aliases alias ON alias.run=calls.run AND alias.name=calls.name
 WHERE alias.kind='session' OR (alias.kind IS NULL AND calls.name IN ('Recall','RecallMore','RecallMaterial','SessionRead'))
    OR (((alias.kind IS NULL AND calls.name='Read') OR alias.kind='file') AND (path GLOB 'maka://*' OR path GLOB 'attachment:*' OR path GLOB 'session:*' OR path GLOB 'archive:*'));
DELETE FROM agent_memory_recall_calls;
INSERT INTO agent_memory_recall_calls SELECT * FROM agent_memory_recall_call_source;

-- Index the cell named by the durable reply, including wait observations of
-- another call's cell. An acceptance reuses the original return's frontier.
CREATE TABLE agent_memory_cell_observations(
 sequence INTEGER PRIMARY KEY REFERENCES agent_session_history(sequence) ON DELETE CASCADE,
 cell TEXT NOT NULL, through_sequence INTEGER NOT NULL
);
CREATE VIEW agent_memory_cell_return_source AS
 SELECT h.sequence,CASE h.kind WHEN 'local_tool_returned'
  THEN json_extract(CAST(ret.payload AS TEXT),'$.body.output.value.cell')
  ELSE json_extract(CAST(ret.payload AS TEXT),'$.output.value.cell') END AS cell,h.sequence AS through_sequence
 FROM agent_session_history h JOIN agent_facts f ON f.sequence=h.sequence JOIN contents b ON b.id=f.body_content_id
 JOIN contents ret ON ret.content_sha256=CASE h.kind WHEN 'local_tool_returned'
  THEN json_extract(CAST(b.payload AS TEXT),'$.fact.result.digest') ELSE json_extract(CAST(b.payload AS TEXT),'$.fact.event.output.digest') END
 WHERE h.result_source=1 AND ((h.kind='local_tool_returned' AND json_extract(CAST(ret.payload AS TEXT),'$.body.output.format')='cell')
 OR (h.kind='external_effect' AND json_extract(CAST(ret.payload AS TEXT),'$.output.format')='cell'));
CREATE VIEW agent_memory_cell_accept_source AS
 SELECT h.sequence,obs.cell,obs.through_sequence
 FROM agent_session_history h JOIN agent_session_history origin ON origin.owner=h.owner AND origin.session=h.session
  AND origin.run=h.run AND origin.tool_use_id=h.tool_use_id AND origin.sequence<h.sequence AND origin.kind='local_tool_returned'
 JOIN agent_memory_cell_observations obs ON obs.sequence=origin.sequence
 JOIN agent_facts f ON f.sequence=h.sequence JOIN contents b ON b.id=f.body_content_id
 JOIN contents accepted ON accepted.content_sha256=json_extract(CAST(b.payload AS TEXT),'$.fact.result.digest')
 WHERE h.kind='tool_result_accepted' AND json_extract(CAST(accepted.payload AS TEXT),'$.kind')='local'
 UNION ALL
 SELECT h.sequence,json_extract(CAST(b.payload AS TEXT),'$.fact.outcome.cell'),h.sequence
 FROM agent_session_history h JOIN agent_facts f ON f.sequence=h.sequence JOIN contents b ON b.id=f.body_content_id
 WHERE h.kind='tool_result_accepted' AND json_extract(CAST(b.payload AS TEXT),'$.fact.outcome.kind')='cell_recovered';

INSERT INTO agent_memory_cell_observations SELECT * FROM agent_memory_cell_return_source;
INSERT INTO agent_memory_cell_observations SELECT * FROM agent_memory_cell_accept_source;
CREATE TRIGGER agent_memory_cell_return_insert AFTER INSERT ON agent_session_history
 WHEN NEW.result_source=1 AND NEW.kind IN ('local_tool_returned','external_effect') BEGIN
 INSERT INTO agent_memory_cell_observations SELECT * FROM agent_memory_cell_return_source WHERE sequence=NEW.sequence;
END;
CREATE TRIGGER agent_memory_cell_accept_insert AFTER INSERT ON agent_session_history WHEN NEW.kind='tool_result_accepted' BEGIN
 INSERT INTO agent_memory_cell_observations SELECT * FROM agent_memory_cell_accept_source WHERE sequence=NEW.sequence;
END;

-- A suppressed child receipt also restricts projections assembled from it.
CREATE TABLE agent_memory_cell_events(
 sequence INTEGER PRIMARY KEY REFERENCES agent_session_history(sequence) ON DELETE CASCADE,
 cell TEXT NOT NULL
);
CREATE INDEX agent_memory_cell_event_range ON agent_memory_cell_events(cell,sequence);
CREATE VIEW agent_memory_cell_event_source AS
 SELECT h.sequence,json_extract(CAST(b.payload AS TEXT),'$.fact.event.cell') AS cell
 FROM agent_session_history h JOIN agent_facts f ON f.sequence=h.sequence JOIN contents b ON b.id=f.body_content_id
 WHERE h.kind='cell';
INSERT INTO agent_memory_cell_events SELECT * FROM agent_memory_cell_event_source;
CREATE TRIGGER agent_memory_cell_event_insert AFTER INSERT ON agent_session_history WHEN NEW.kind='cell' BEGIN
 INSERT INTO agent_memory_cell_events SELECT * FROM agent_memory_cell_event_source WHERE sequence=NEW.sequence;
END;

CREATE INDEX agent_memory_recall_cell_sequence ON agent_memory_recall_calls(cell,sequence) WHERE cell IS NOT NULL;
DROP VIEW agent_memory_recall_outputs;
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
 SELECT h.owner,h.fact_id,k.read_path FROM agent_session_history h
 JOIN agent_memory_cell_observations obs ON obs.sequence=h.sequence
 JOIN agent_memory_recall_calls k ON k.cell=obs.cell AND k.sequence<obs.through_sequence
 UNION ALL
 SELECT h.owner,h.fact_id,NULL FROM agent_session_history h
 JOIN agent_memory_cell_observations obs ON obs.sequence=h.sequence
 WHERE EXISTS (
   SELECT 1 FROM agent_memory_cell_events e JOIN agent_session_history src ON src.sequence=e.sequence
   WHERE e.cell=obs.cell AND e.sequence<=obs.through_sequence AND
    (EXISTS(SELECT 1 FROM agent_memory_hidden_spans s WHERE s.namespace=h.owner AND s.fact=src.fact_id)
     OR EXISTS(SELECT 1 FROM agent_memory_operation_spans s WHERE s.namespace=h.owner AND s.fact=src.fact_id)
     OR EXISTS(SELECT 1 FROM agent_memory_sibling_spans s WHERE s.namespace=h.owner AND s.fact=src.fact_id))
 );
