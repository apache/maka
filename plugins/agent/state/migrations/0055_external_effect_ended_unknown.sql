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

-- Track ended-unknown external effect observations in shared-field and recall
-- redaction views; the companion data migration rebuilds affected Recall rows.
DROP TRIGGER agent_memory_operation_field_insert;
DROP VIEW agent_memory_operation_field_source;

CREATE VIEW agent_memory_operation_field_source AS
 SELECT d.id AS message,h.fact_id AS fact,h.run,h.tool_use_id AS tool,
        field.value->>'$.start' AS start,field.value->>'$.end' AS end
 FROM agent_recall_messages d CROSS JOIN agent_memory_new_history h ON h.sequence=d.sequence
 LEFT JOIN contents cell ON h.kind='cell' AND cell.content_sha256=d.references_json->>'$[0].digest'
 LEFT JOIN contents accepted ON h.kind='tool_result_accepted' AND accepted.content_sha256=d.references_json->>'$[1].digest'
 LEFT JOIN contents returned ON returned.content_sha256=CASE h.kind
    WHEN 'cell' THEN d.references_json->>'$[1].digest'
    WHEN 'host_tool_result_recorded' THEN d.references_json->>'$[1].digest'
    WHEN 'tool_result_accepted' THEN d.references_json->>'$[2].digest' END
 CROSS JOIN json_each(d.fields_json) field
 WHERE d.ordinal=0 AND field.value->>'$.end'>field.value->>'$.start' AND (
   (h.kind='operation_observed' AND field.key=0) OR
   (h.kind='external_effect' AND h.tool_start=0 AND h.result_source=0 AND field.key=0) OR
   (h.kind='cell' AND json_extract(CAST(cell.payload AS TEXT),'$.fact.event.kind')='child_observed' AND field.key=0) OR
   (h.kind='tool_result_accepted' AND json_extract(CAST(accepted.payload AS TEXT),'$.kind') IN ('host','observed_operation','operation') AND field.key=0) OR
   ((h.kind='cell' AND json_extract(CAST(cell.payload AS TEXT),'$.fact.event.kind')='child_result_recorded' AND field.key=1 OR
     h.kind='host_tool_result_recorded' AND field.key=0 OR
     h.kind='tool_result_accepted' AND field.key=1 AND json_extract(CAST(accepted.payload AS TEXT),'$.kind') IN ('host','operation'))
     AND json_extract(CAST(returned.payload AS TEXT),'$.body.projection.kind') IN ('result','receipt','from_output'))
 );

CREATE TRIGGER agent_memory_operation_field_insert AFTER INSERT ON agent_recall_messages
 WHEN NEW.ordinal=0 AND EXISTS(SELECT 1 FROM agent_session_history h WHERE h.sequence=NEW.sequence
   AND (h.kind IN ('operation_observed','host_tool_result_recorded','tool_result_accepted','cell')
     OR (h.kind='external_effect' AND h.tool_start=0 AND h.result_source=0))) BEGIN
 INSERT INTO agent_memory_shared_fields SELECT * FROM agent_memory_operation_field_source WHERE message=NEW.id;
END;

DROP VIEW agent_memory_termination_receipts;

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
     AND later.sequence>op.sequence AND later.sequence<t.sequence)
 UNION
 SELECT DISTINCT t.message,t.fact,t.run,t.end,op.tool_use_id AS tool
 FROM agent_memory_failed_terminations t
 CROSS JOIN agent_session_history blocked ON blocked.owner=t.owner AND blocked.session=t.session AND blocked.run=t.run
   AND blocked.kind='blocked' AND blocked.sequence<t.sequence
 CROSS JOIN agent_facts bf ON bf.sequence=blocked.sequence CROSS JOIN contents b ON b.id=bf.body_content_id
 CROSS JOIN agent_session_history op ON op.owner=t.owner AND op.session=t.session AND op.run=t.run
   AND op.kind='external_effect' AND op.tool_start=0 AND op.result_source=0 AND op.sequence<t.sequence
 CROSS JOIN agent_facts ofact ON ofact.sequence=op.sequence CROSS JOIN contents r ON r.id=ofact.body_content_id
 WHERE CAST(b.payload AS TEXT)->>'$.fact.reason.kind'='external_effect_unknown'
   AND CAST(r.payload AS TEXT)->>'$.fact.event.kind'='observed'
   AND CAST(r.payload AS TEXT)->>'$.fact.event.key.task'=CAST(b.payload AS TEXT)->>'$.fact.reason.task'
   AND CAST(r.payload AS TEXT)->>'$.fact.event.key.operation'=CAST(b.payload AS TEXT)->>'$.fact.reason.operation'
   AND t.body IN (
     CASE WHEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.outcome.kind'='unknown'
       THEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.outcome.diagnostic'
       WHEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.kind'='unavailable'
       THEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.diagnostic' END,
     rtrim(CASE WHEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.outcome.kind'='unknown'
       THEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.outcome.diagnostic'
       WHEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.kind'='unavailable'
       THEN CAST(r.payload AS TEXT)->>'$.fact.event.observation.receipt.diagnostic' END,'.')
       ||'. The call may still be running; its end was not confirmed.'
   )
   AND NOT EXISTS (
     SELECT 1 FROM agent_session_history later
     CROSS JOIN agent_facts lf ON lf.sequence=later.sequence
     CROSS JOIN contents lr ON lr.id=lf.body_content_id
     WHERE later.owner=t.owner AND later.session=t.session
       AND later.tool_use_id=op.tool_use_id AND later.run=t.run
       AND later.kind='external_effect' AND later.tool_start=0 AND later.result_source=0
       AND later.sequence>op.sequence AND later.sequence<t.sequence
       AND CAST(lr.payload AS TEXT)->>'$.fact.event.kind'='observed'
   );

DROP VIEW agent_memory_recall_outputs;

CREATE VIEW agent_memory_recall_outputs(owner,fact) AS
 SELECT h.owner,h.fact_id FROM agent_session_history h WHERE
 ((h.result_source=1 OR h.kind IN ('cell','operation_observed','external_task_observed','model_observed')
   OR (h.kind='external_effect' AND h.tool_start=0))
  AND EXISTS(SELECT 1 FROM agent_memory_recall_calls k
      WHERE k.run=h.run AND k.tool_use_id=h.tool_use_id AND k.sequence<h.sequence))
 OR (h.kind='cell' AND h.tool_use_id IS NULL AND EXISTS(
     SELECT 1 FROM agent_memory_cell_events e JOIN agent_memory_recall_calls k ON k.run=h.run AND k.cell=e.cell
     WHERE e.sequence=h.sequence AND k.sequence<h.sequence))
 OR EXISTS(SELECT 1 FROM agent_memory_cell_observations obs WHERE obs.sequence=h.sequence AND (
     EXISTS(SELECT 1 FROM agent_memory_recall_calls k
       WHERE k.cell=obs.cell AND k.sequence<obs.through_sequence)
     OR EXISTS(
       SELECT 1 FROM agent_memory_cell_candidates c
       JOIN agent_session_history dest ON dest.sequence=c.event
       WHERE c.cell=obs.cell AND c.event<=obs.through_sequence AND (c.direct
         OR EXISTS(SELECT 1 FROM agent_memory_operation_spans s WHERE s.namespace=h.owner AND s.fact=dest.fact_id)
         OR EXISTS(SELECT 1 FROM agent_memory_sibling_spans s WHERE s.namespace=h.owner AND s.fact=dest.fact_id))
     )
 ));

INSERT OR IGNORE INTO agent_memory_shared_fields
 SELECT message,fact,run,tool,start,end FROM agent_memory_termination_fields;
