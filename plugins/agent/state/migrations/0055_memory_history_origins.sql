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

CREATE TABLE agent_memory_read_aliases (
 run TEXT NOT NULL REFERENCES agent_run_specs(run) ON DELETE CASCADE,
 name TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(run,name)
) WITHOUT ROWID;
CREATE VIEW agent_memory_read_alias_source AS
 SELECT run,name,kind FROM (
 SELECT r.run,service.value->>'$.selection.name' AS name,coalesce(service.value->>'$.history_reader',CASE
 WHEN service.value->>'$.selection.target.kind'='import' AND service.value->>'$.selection.target.name'='files' AND service.value->>'$.selection.method'='read' THEN 'file'
 WHEN service.value->>'$.selection.target.kind'='export' AND service.value->>'$.selection.target.name'='agent' AND service.value->>'$.selection.method' IN
   ('memory','memories','work','sessionRead','history','historyLandmarks','historyPrompt','historyRequests','source','search','toolImage','attachmentImage') THEN 'session' END) AS kind
 FROM agent_run_specs r CROSS JOIN contents spec ON spec.id=r.spec_content_id
 CROSS JOIN contents selection ON selection.content_sha256=json_extract(CAST(spec.payload AS TEXT),'$.toolSelection.digest')
 CROSS JOIN json_each(CAST(selection.payload AS TEXT),'$.services') service)
 WHERE kind IS NOT NULL;
INSERT INTO agent_memory_read_aliases SELECT * FROM agent_memory_read_alias_source;
CREATE TRIGGER agent_memory_read_alias_insert AFTER INSERT ON agent_run_specs BEGIN
 INSERT INTO agent_memory_read_aliases SELECT * FROM agent_memory_read_alias_source WHERE run=NEW.run;
END;
DROP TRIGGER agent_memory_recall_call_insert;
DROP VIEW agent_memory_recall_call_source;
CREATE VIEW agent_memory_recall_call_source AS
 SELECT calls.sequence,calls.run,calls.tool_use_id,calls.cell,CASE WHEN calls.name='Read' OR alias.kind='file' THEN path END AS read_path FROM (
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
 WHERE alias.kind='session' OR calls.name IN ('Recall','RecallMore','RecallMaterial','SessionRead')
    OR ((calls.name='Read' OR alias.kind='file') AND (path GLOB 'maka://*' OR path GLOB 'attachment:*' OR path GLOB 'session:*' OR path GLOB 'archive:*'));
INSERT OR IGNORE INTO agent_memory_recall_calls SELECT * FROM agent_memory_recall_call_source;
CREATE TRIGGER agent_memory_recall_call_insert AFTER INSERT ON agent_session_history WHEN NEW.tool_start=1 BEGIN
 INSERT INTO agent_memory_recall_calls SELECT * FROM agent_memory_recall_call_source WHERE sequence=NEW.sequence;
END;

-- Imported call IDs are scoped to their snapshot. Use the most recent preceding
-- call when a provider reuses an ID. Raw source records can own several rows.
DROP TRIGGER agent_memory_imported_output_insert;
DROP VIEW agent_memory_imported_output_source;
DROP TABLE agent_memory_imported_outputs;
CREATE TABLE agent_memory_imported_tools(
 snapshot TEXT NOT NULL REFERENCES agent_history_snapshots(snapshot) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 message INTEGER NOT NULL,part INTEGER NOT NULL, original_ordinal INTEGER NOT NULL, original TEXT NOT NULL,
 call_id TEXT NOT NULL, name TEXT NOT NULL, is_call INTEGER NOT NULL, read_path TEXT,
 PRIMARY KEY(snapshot,message,part)
) WITHOUT ROWID;
CREATE INDEX agent_memory_imported_tool_calls ON agent_memory_imported_tools(snapshot,call_id,name,message,part) WHERE is_call=1;
CREATE INDEX agent_memory_imported_tool_original ON agent_memory_imported_tools(snapshot,original_ordinal,original) WHERE is_call=0;
CREATE VIEW agent_memory_imported_tool_source AS
 SELECT snapshot,message,part,original_ordinal,original,call_id,name,is_call,read_path FROM (
 SELECT e.snapshot,e.position AS message,part.key AS part,
   json_extract(CAST(m.payload AS TEXT),'$.originalOrdinal') AS original_ordinal,
   json_extract(CAST(m.payload AS TEXT),'$.original.digest') AS original,
   coalesce(json_extract(CAST(b.payload AS TEXT),'$.part.call.id'),json_extract(CAST(b.payload AS TEXT),'$.call_id'),json_extract(CAST(b.payload AS TEXT),'$.part.id')) AS call_id,
   coalesce(json_extract(CAST(b.payload AS TEXT),'$.part.call.name'),json_extract(CAST(b.payload AS TEXT),'$.name'),json_extract(CAST(b.payload AS TEXT),'$.part.name')) AS name,
   CASE WHEN json_extract(CAST(b.payload AS TEXT),'$.kind')='tool_return' THEN 0
        WHEN json_extract(CAST(b.payload AS TEXT),'$.kind')='model' THEN CASE json_extract(CAST(b.payload AS TEXT),'$.part.kind') WHEN 'tool_call' THEN 1 WHEN 'tool_result' THEN 0 END END AS is_call,
   json_extract(CAST(b.payload AS TEXT),'$.part.call.input.data.path') AS read_path
 FROM agent_history_snapshot_entries e CROSS JOIN contents m ON m.content_sha256=e.entry_json->>'$.message.digest'
 CROSS JOIN json_each(CAST(m.payload AS TEXT),'$.parts') part
 CROSS JOIN contents b ON b.content_sha256=part.value->>'$.digest'
 WHERE e.kind='imported'
 ) WHERE (name='Read' AND is_call IS NOT NULL) OR (name IN ('Recall','RecallMore','RecallMaterial','SessionRead') AND is_call=0);
INSERT INTO agent_memory_imported_tools SELECT * FROM agent_memory_imported_tool_source;
CREATE TRIGGER agent_memory_imported_tool_insert AFTER INSERT ON agent_history_snapshot_entries WHEN NEW.kind='imported' BEGIN
 INSERT INTO agent_memory_imported_tools SELECT * FROM agent_memory_imported_tool_source WHERE snapshot=NEW.snapshot AND message=NEW.position;
END;
CREATE VIEW agent_memory_imported_outputs AS
 SELECT snapshot,message,part,original_ordinal,original,source_path AS read_path FROM (
   SELECT r.*,CASE WHEN r.name='Read' THEN
     (SELECT c.read_path FROM agent_memory_imported_tools c WHERE c.snapshot=r.snapshot AND c.call_id=r.call_id AND c.name=r.name AND c.is_call=1
     AND (c.message,c.part)<(r.message,r.part) ORDER BY c.message DESC,c.part DESC LIMIT 1) END AS source_path
   FROM agent_memory_imported_tools r WHERE r.is_call=0
 ) keyed WHERE name<>'Read' OR typeof(source_path)='text';

-- Only the durable return codec can identify a projection derived from a Host
-- receipt. Independent projections of the same call keep their own evidence.
CREATE TABLE agent_memory_operation_fields(
 message INTEGER NOT NULL REFERENCES agent_recall_messages(id) ON DELETE CASCADE,
 fact TEXT NOT NULL, run TEXT NOT NULL, tool TEXT NOT NULL,
 start INTEGER NOT NULL,end INTEGER NOT NULL,
 PRIMARY KEY(fact,start)
) WITHOUT ROWID;
CREATE INDEX agent_memory_operation_fields_tool ON agent_memory_operation_fields(run,tool);
CREATE VIEW agent_memory_operation_field_source AS
 SELECT d.id AS message,h.fact_id AS fact,h.run,h.tool_use_id AS tool,
        field.value->>'$.start' AS start,field.value->>'$.end' AS end
 FROM agent_recall_messages d CROSS JOIN agent_session_history h ON h.sequence=d.sequence
 LEFT JOIN contents cell ON h.kind='cell' AND cell.content_sha256=d.references_json->>'$[0].digest'
 LEFT JOIN contents accepted ON h.kind='tool_result_accepted' AND accepted.content_sha256=d.references_json->>'$[1].digest'
 LEFT JOIN contents returned ON returned.content_sha256=CASE h.kind
    WHEN 'cell' THEN d.references_json->>'$[1].digest'
    WHEN 'host_tool_result_recorded' THEN d.references_json->>'$[1].digest'
    WHEN 'tool_result_accepted' THEN d.references_json->>'$[2].digest' END
 CROSS JOIN json_each(d.fields_json) field
 WHERE d.ordinal=0 AND field.value->>'$.end'>field.value->>'$.start' AND (
   (h.kind='operation_observed' AND field.key=0) OR
   (h.kind='cell' AND json_extract(CAST(cell.payload AS TEXT),'$.fact.event.kind')='child_observed' AND field.key=0) OR
   (h.kind='tool_result_accepted' AND json_extract(CAST(accepted.payload AS TEXT),'$.kind') IN ('host','observed_operation','operation') AND field.key=0) OR
   ((h.kind='cell' AND json_extract(CAST(cell.payload AS TEXT),'$.fact.event.kind')='child_result_recorded' AND field.key=1 OR
     h.kind='host_tool_result_recorded' AND field.key=0 OR
     h.kind='tool_result_accepted' AND field.key=1 AND json_extract(CAST(accepted.payload AS TEXT),'$.kind') IN ('host','operation'))
     AND json_extract(CAST(returned.payload AS TEXT),'$.body.projection.kind') IN ('result','receipt','from_output'))
 );
INSERT INTO agent_memory_operation_fields SELECT * FROM agent_memory_operation_field_source;
CREATE TRIGGER agent_memory_operation_field_insert AFTER INSERT ON agent_recall_messages
 WHEN NEW.ordinal=0 AND EXISTS(SELECT 1 FROM agent_session_history h WHERE h.sequence=NEW.sequence
   AND h.kind IN ('operation_observed','host_tool_result_recorded','tool_result_accepted','cell')) BEGIN
 INSERT INTO agent_memory_operation_fields SELECT * FROM agent_memory_operation_field_source WHERE message=NEW.id;
END;

-- Identical serializations share byte offsets. The flattened model projection
-- and the original JSON receipt have different coordinates.
CREATE VIEW agent_memory_operation_spans(namespace,fact,ordinal,start,end) AS
 SELECT namespace,fact,0,
        CASE WHEN same_bytes THEN dest_start+overlap_start ELSE dest_start END,
        CASE WHEN same_bytes THEN dest_start+overlap_end ELSE dest_end END FROM (
 SELECT d.owner AS namespace,dest.fact,dest.start AS dest_start,dest.end AS dest_end,
        max(hidden.start,src.start)-src.start AS overlap_start,min(hidden.end,src.end)-src.start AS overlap_end,
        src.end-src.start=dest.end-dest.start AND substr(CAST(s.body AS BLOB),src.start+1,src.end-src.start)
              =substr(CAST(d.body AS BLOB),dest.start+1,dest.end-dest.start) AS same_bytes
 FROM agent_memory_operation_fields dest CROSS JOIN agent_recall_messages d ON d.id=dest.message
 CROSS JOIN agent_memory_operation_fields src ON src.run=dest.run AND src.tool=dest.tool
 CROSS JOIN agent_memory_hidden_spans hidden ON hidden.namespace=d.owner AND hidden.fact=src.fact AND hidden.ordinal=0
 CROSS JOIN agent_recall_messages s ON s.id=src.message
 WHERE (src.fact,src.start)<>(dest.fact,dest.start) AND hidden.start<src.end AND hidden.end>src.start
 );
