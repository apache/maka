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

-- A publication depends on observations strictly before its own fact. Its
-- own evidence keeps the exact byte coordinates of the published message.
CREATE VIEW agent_memory_cell_publication_source AS
 SELECT h.sequence,CAST(b.payload AS TEXT)->>'$.fact.event.cell' AS cell,h.sequence-1 AS through_sequence
 FROM agent_session_history h JOIN agent_facts f USING(sequence) JOIN contents b ON b.id=f.body_content_id
 WHERE h.kind='cell' AND CAST(b.payload AS TEXT)->>'$.fact.event.kind' IN
 ('completed','interrupted','notification_queued','final_notification_queued','session_value_published','loaded_tools_published');

INSERT INTO agent_memory_cell_observations SELECT * FROM agent_memory_cell_publication_source;
CREATE TRIGGER agent_memory_cell_publication_insert AFTER INSERT ON agent_session_history WHEN NEW.kind='cell' BEGIN
 INSERT INTO agent_memory_cell_observations SELECT * FROM agent_memory_cell_publication_source WHERE sequence=NEW.sequence;
END;

-- One historical field can derive from several matching receipts. Retain
-- each immutable association even when those receipts used the same wording.
CREATE TABLE agent_memory_shared_fields(
 message INTEGER NOT NULL REFERENCES agent_recall_messages(id) ON DELETE CASCADE,
 fact TEXT NOT NULL, run TEXT NOT NULL, tool TEXT NOT NULL,
 start INTEGER NOT NULL,end INTEGER NOT NULL,PRIMARY KEY(fact,start,tool)
) WITHOUT ROWID;
INSERT INTO agent_memory_shared_fields SELECT * FROM agent_memory_operation_fields;
DROP TRIGGER agent_memory_operation_field_insert;
DROP VIEW agent_memory_operation_spans;
DROP TABLE agent_memory_operation_fields;
CREATE INDEX agent_memory_shared_fields_tool ON agent_memory_shared_fields(run,tool);

CREATE TRIGGER agent_memory_operation_field_insert AFTER INSERT ON agent_recall_messages
 WHEN NEW.ordinal=0 AND EXISTS(SELECT 1 FROM agent_session_history h WHERE h.sequence=NEW.sequence
   AND h.kind IN ('operation_observed','host_tool_result_recorded','tool_result_accepted','cell')) BEGIN
 INSERT INTO agent_memory_shared_fields SELECT * FROM agent_memory_operation_field_source WHERE message=NEW.id;
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
 FROM agent_memory_shared_fields dest CROSS JOIN agent_recall_messages d ON d.id=dest.message
 CROSS JOIN agent_memory_shared_fields src ON src.run=dest.run AND src.tool=dest.tool
 CROSS JOIN agent_memory_hidden_spans hidden ON hidden.namespace=d.owner AND hidden.fact=src.fact AND hidden.ordinal=0
 CROSS JOIN agent_recall_messages s ON s.id=src.message
 WHERE (src.fact,src.start)<>(dest.fact,dest.start) AND hidden.start<src.end AND hidden.end>src.start
 );

-- Compute the same key from the caller and the Started owner independently.
-- An external Run can contain many calls; writing a cell never searches them.
CREATE VIEW agent_memory_cell_code_source AS
 SELECT d.id AS message,h.fact_id AS fact,h.run,
   CASE h.kind
   WHEN 'model_observed' THEN 'code:agent:'||h.attempt||':'||(CAST(b.payload AS TEXT)->>'$.fact.part.call.id')
   WHEN 'external_effect' THEN 'code:external:'||(CAST(b.payload AS TEXT)->>'$.fact.event.key.task')||':'||(CAST(b.payload AS TEXT)->>'$.fact.event.key.operation')
   WHEN 'cell' THEN CASE CAST(b.payload AS TEXT)->>'$.fact.event.owner.kind'
     WHEN 'agent' THEN 'code:agent:'||h.attempt||':'||(CAST(b.payload AS TEXT)->>'$.fact.event.owner.call')
     WHEN 'external' THEN 'code:external:'||(CAST(b.payload AS TEXT)->>'$.fact.event.owner.key.task')||':'||(CAST(b.payload AS TEXT)->>'$.fact.event.owner.key.operation') END
   END AS tool,h.kind,
   d.fields_json->>'$[#-1].start' AS field_start,d.fields_json->>'$[#-1].end' AS field_end,
   substr(CAST(d.body AS BLOB),1+(d.fields_json->>'$[#-1].start')) AS content
 FROM agent_recall_messages d CROSS JOIN agent_session_history h ON h.sequence=d.sequence
 CROSS JOIN agent_facts f ON f.sequence=h.sequence CROSS JOIN contents b ON b.id=f.body_content_id
 WHERE d.ordinal=0 AND (
   (h.kind IN ('model_observed','external_effect') AND h.tool_start=1 AND d.fields_json->>'$[#-1].field'='arguments')
   OR (h.kind='cell' AND CAST(b.payload AS TEXT)->>'$.fact.event.kind'='started'));

CREATE VIEW agent_memory_cell_code_fields(message,fact,run,tool,start,end) AS
 SELECT message,fact,run,tool,field_start,field_end FROM agent_memory_cell_code_source WHERE kind='cell' AND tool IS NOT NULL
 UNION ALL
 SELECT message,fact,run,tool,CASE WHEN at>0 THEN field_start+at+length(prefix) ELSE field_start END,
    CASE WHEN at>0 THEN field_start+at+length(prefix)+length(literal)-2 ELSE field_end END
 FROM (
    SELECT args.*,CAST('"code":' AS BLOB) AS prefix,CAST(json_quote(code) AS BLOB) AS literal,
       instr(content,CAST('"code":'||json_quote(code) AS BLOB)) AS at
    FROM (SELECT s.*,CASE WHEN json_valid(CAST(content AS TEXT)) THEN CAST(content AS TEXT)->>'$.code' END AS code
          FROM agent_memory_cell_code_source s WHERE kind<>'cell') args WHERE typeof(code)='text'
 );

INSERT INTO agent_memory_shared_fields SELECT * FROM agent_memory_cell_code_fields;
CREATE TRIGGER agent_memory_cell_code_insert AFTER INSERT ON agent_recall_messages
 WHEN NEW.ordinal=0 AND (NEW.fields_json->>'$[#-1].field'='arguments' OR
    (NEW.fields_json->>'$[0].field'='receipt' AND NEW.fields_json->>'$[#-1].field'='body')) BEGIN
 INSERT INTO agent_memory_shared_fields SELECT * FROM agent_memory_cell_code_fields WHERE message=NEW.id;
END;

-- Failed termination persists either an original operation diagnostic or the
-- active attempt's error. Index the copied field when its source is known.
CREATE VIEW agent_memory_failed_terminations AS
 SELECT d.id AS message,d.body,h.fact_id AS fact,h.run,h.owner,h.session,h.sequence,length(CAST(d.body AS BLOB)) AS end
 FROM agent_recall_messages d CROSS JOIN agent_session_history h ON h.sequence=d.sequence
 CROSS JOIN agent_facts f ON f.sequence=h.sequence CROSS JOIN contents b ON b.id=f.body_content_id
 WHERE d.ordinal=0 AND h.kind='run_terminated' AND CAST(b.payload AS TEXT)->>'$.fact.terminal'='failed';

CREATE VIEW agent_memory_termination_receipts AS
 SELECT DISTINCT t.message,t.fact,t.run,t.end,op.tool_use_id AS tool
 FROM agent_memory_failed_terminations t
 CROSS JOIN agent_session_history blocked ON blocked.owner=t.owner AND blocked.session=t.session AND blocked.run=t.run
   AND blocked.kind='blocked' AND blocked.sequence<t.sequence
 CROSS JOIN agent_facts bf ON bf.sequence=blocked.sequence CROSS JOIN contents b ON b.id=bf.body_content_id
 CROSS JOIN agent_session_history op ON op.owner=t.owner AND op.session=t.session AND op.run=t.run
   AND op.step=blocked.step AND op.kind='operation_observed' AND op.attempt=blocked.attempt AND op.sequence<t.sequence
 CROSS JOIN agent_facts ofact ON ofact.sequence=op.sequence CROSS JOIN contents r ON r.id=ofact.body_content_id
 WHERE CAST(b.payload AS TEXT)->>'$.fact.reason.kind'='operation_unknown'
   AND CAST(r.payload AS TEXT)->>'$.fact.reply.reference.operation'=CAST(b.payload AS TEXT)->>'$.fact.reason.reference.operation'
   AND CAST(r.payload AS TEXT)->>'$.fact.tool.call'=CAST(b.payload AS TEXT)->>'$.fact.reason.tool.call'
   AND t.body=CASE WHEN CAST(r.payload AS TEXT)->>'$.fact.reply.receipt.outcome.kind'='unknown'
     THEN CAST(r.payload AS TEXT)->>'$.fact.reply.receipt.outcome.diagnostic'
     WHEN CAST(r.payload AS TEXT)->>'$.fact.reply.receipt.kind'='unavailable' THEN CAST(r.payload AS TEXT)->>'$.fact.reply.receipt.diagnostic' END
   AND NOT EXISTS (SELECT 1 FROM agent_session_history later WHERE later.owner=t.owner AND later.session=t.session
     AND later.tool_use_id=op.tool_use_id AND later.run=t.run AND later.kind='operation_observed'
     AND later.sequence>op.sequence AND later.sequence<t.sequence);

CREATE VIEW agent_memory_termination_interruptions AS
 SELECT t.message,t.fact,t.run,t.end,src.id AS source_message,i.fact_id AS source_fact
 FROM agent_memory_failed_terminations t CROSS JOIN agent_session_history i
   ON i.owner=t.owner AND i.session=t.session AND i.run=t.run AND i.kind='model_interrupted' AND i.sequence<t.sequence
   AND i.attempt=(SELECT p.attempt FROM agent_session_history p
       WHERE p.owner=t.owner AND p.session=t.session AND p.run=t.run AND p.kind='model_attempt_prepared'
         AND p.sequence<t.sequence ORDER BY p.sequence DESC LIMIT 1)
   AND i.step=(SELECT p.step FROM agent_session_history p WHERE p.run=t.run AND p.kind='step_prepared'
         AND p.sequence<t.sequence ORDER BY p.sequence DESC LIMIT 1)
 CROSS JOIN agent_recall_messages src ON src.owner=i.owner AND src.session=i.session AND src.sequence=i.sequence AND src.ordinal=0
 WHERE src.body=t.body;

CREATE VIEW agent_memory_termination_fields(origin,message,fact,run,tool,start,end) AS
 SELECT message,message,fact,run,tool,0,end FROM agent_memory_termination_receipts
 UNION ALL SELECT message,message,fact,run,'interruption:'||source_fact,0,end FROM agent_memory_termination_interruptions
 UNION ALL SELECT message,source_message,source_fact,run,'interruption:'||source_fact,0,end FROM agent_memory_termination_interruptions;

INSERT INTO agent_memory_shared_fields SELECT message,fact,run,tool,start,end FROM agent_memory_termination_fields;
CREATE TRIGGER agent_memory_termination_field_insert AFTER INSERT ON agent_recall_messages
 WHEN NEW.ordinal=0 AND NEW.role='"failure"' AND EXISTS(SELECT 1 FROM agent_session_history h
    WHERE h.sequence=NEW.sequence AND h.kind='run_terminated') BEGIN
 INSERT INTO agent_memory_shared_fields SELECT message,fact,run,tool,start,end FROM agent_memory_termination_fields WHERE origin=NEW.id;
END;
