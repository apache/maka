/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

-- Update all agent SQL views and triggers reading contents.payload to decode
-- through maka_content_text(payload, encoding) once per referenced content row
-- via jsonb(...) so compressed blobs decompress at most once per row.

DROP VIEW agent_memory_selected_readers;
DROP VIEW agent_memory_selection_readers;
CREATE VIEW agent_memory_selection_readers AS
 SELECT selection_id,name,CASE WHEN legacy_recap THEN 'session' ELSE reader END AS kind,legacy_recap FROM (
  SELECT selection.id AS selection_id,service.value->>'$.selection.name' AS name,service.value->>'$.history_reader' AS reader,
   (coalesce(service.value->>'$.history_reader','other')='other'
    AND service.value->>'$.selection.method' IN ('recap','generateRecap')
    AND (service.value->>'$.selection.target.kind'='import' OR
      (service.value->>'$.selection.target.kind'='export' AND service.value->>'$.selection.target.name'='agent'))) AS legacy_recap
  FROM contents selection CROSS JOIN json_each(maka_content_text(selection.payload,selection.encoding),'$.services') service);
CREATE VIEW agent_memory_selected_readers AS
 SELECT r.run,a.name,a.kind,a.legacy_recap FROM agent_run_specs r CROSS JOIN contents spec ON spec.id=r.spec_content_id
 CROSS JOIN contents selection ON selection.content_sha256=maka_content_text(spec.payload,spec.encoding)->>'$.toolSelection.digest'
 CROSS JOIN agent_memory_selection_readers a ON a.selection_id=selection.id;

DROP TRIGGER agent_memory_run_insert;
CREATE TRIGGER agent_memory_run_insert AFTER INSERT ON agent_run_specs BEGIN
 UPDATE agent_run_specs SET original_user_run=CASE maka_content_text(b.payload,b.encoding)->>'$.memoryAdmission'
  WHEN 'enabled' THEN 1 WHEN 'disabled' THEN 1 WHEN 'excluded' THEN 0 END
 FROM contents b WHERE run=NEW.run AND b.id=NEW.spec_content_id;
 INSERT INTO agent_memory_read_aliases SELECT run,name,kind FROM agent_memory_selected_readers
 WHERE run=NEW.run AND kind IS NOT NULL;
END;

DROP TRIGGER agent_memory_snapshot_index;
CREATE TRIGGER agent_memory_snapshot_index AFTER INSERT ON agent_memory_indexed_snapshots BEGIN
 INSERT INTO agent_memory_snapshot_outputs(snapshot,fact)
 SELECT NEW.snapshot,fact FROM (
  WITH aliases AS MATERIALIZED (
   SELECT e.run,a.name,a.kind FROM agent_history_snapshot_entries e
   CROSS JOIN contents spec ON spec.content_sha256=e.entry_json->>'$.spec.digest'
   CROSS JOIN contents selection ON selection.content_sha256=maka_content_text(spec.payload,spec.encoding)->>'$.toolSelection.digest'
   CROSS JOIN agent_memory_selection_readers a ON a.selection_id=selection.id
   WHERE e.snapshot=NEW.snapshot AND e.kind='run'
  ), raw_events AS MATERIALIZED (
   SELECT e.sequence,e.run,e.entry_json->>'$.id' AS fact,e.entry_json->>'$.tool_use_id' AS tool,
    jsonb(maka_content_text(b.payload,b.encoding)) AS b_doc
   FROM agent_history_snapshot_entries e
   CROSS JOIN contents b ON b.content_sha256=e.entry_json->>'$.body.digest'
   WHERE e.snapshot=NEW.snapshot AND e.kind='fact'
    AND (e.entry_json->>'$.tool_use_id' IS NOT NULL OR coalesce(e.fact_kind,maka_content_text(b.payload,b.encoding)->>'$.fact.kind')='cell')
    AND (e.fact_kind IS NULL OR e.fact_kind IN ('model_observed','external_task_observed','external_effect',
         'cell','local_tool_returned','tool_result_accepted','host_tool_result_recorded','operation_observed'))
  ), event_docs AS MATERIALIZED (
   SELECT r.sequence,r.run,r.fact,r.tool,r.b_doc,
    CASE WHEN descriptor.id IS NOT NULL THEN jsonb(maka_content_text(descriptor.payload,descriptor.encoding)) END AS d_doc,
    CASE WHEN input.id IS NOT NULL THEN jsonb(maka_content_text(input.payload,input.encoding)) END AS i_doc,
    CASE WHEN ret.id IS NOT NULL THEN jsonb(maka_content_text(ret.payload,ret.encoding)) END AS ret_doc
   FROM raw_events r
   LEFT JOIN contents descriptor ON descriptor.content_sha256=r.b_doc->>'$.fact.event.descriptor.digest'
   LEFT JOIN contents input ON input.content_sha256=r.b_doc->>'$.fact.event.input.digest'
   LEFT JOIN contents ret ON ret.content_sha256=coalesce(r.b_doc->>'$.fact.result.digest',r.b_doc->>'$.fact.event.output.digest')
  ), events AS MATERIALIZED (
   SELECT sequence,run,fact,tool,
    b_doc->>'$.fact.kind' AS kind,
    coalesce(b_doc->>'$.fact.part.kind',b_doc->>'$.fact.event.kind',b_doc->>'$.fact.output.type') AS event,
    b_doc->>'$.fact.event.cell' AS cell,
    coalesce(b_doc->>'$.fact.part.call.name',b_doc->>'$.fact.event.name',
     b_doc->>'$.fact.output.name',d_doc->>'$.name') AS name,
    coalesce(b_doc->>'$.fact.part.call.input.data.path',b_doc->>'$.fact.output.input.path',
     d_doc->>'$.input.path',i_doc->>'$.path') AS path,
    coalesce(CASE WHEN ret_doc->>'$.body.output.format'='cell' THEN ret_doc->>'$.body.output.value.cell' END,
     CASE WHEN ret_doc->>'$.output.format'='cell' THEN ret_doc->>'$.output.value.cell' END,
     CASE WHEN b_doc->>'$.fact.outcome.kind'='cell_recovered' THEN b_doc->>'$.fact.outcome.cell' END) AS observed_cell,
    ret_doc->>'$.kind' AS accepted_kind
   FROM event_docs
  ), reads AS MATERIALIZED (
   SELECT e.run,e.tool,e.cell,e.sequence FROM events e LEFT JOIN aliases a ON a.run=e.run AND a.name=e.name
   WHERE e.tool IS NOT NULL AND e.event IN ('tool_call','child_prepared','tool_start','prepared')
    AND (a.kind='session' OR
    (a.kind IS NULL AND e.name IN ('Recall','RecallMore','RecallMaterial','SessionRead')) OR
    ((a.kind='file' OR (a.kind IS NULL AND e.name='Read')) AND e.path IS NOT NULL AND maka_reads_history_resource(e.path)))
  ), cells AS MATERIALIZED (
   SELECT cell,min(sequence) AS first_read FROM reads WHERE cell IS NOT NULL GROUP BY cell
  ), returns AS MATERIALIZED (
   SELECT e.run,e.tool,e.fact,e.sequence FROM events e JOIN cells c ON c.cell=e.observed_cell AND c.first_read<e.sequence
  )
  SELECT e.fact FROM events e JOIN reads r ON r.run=e.run AND r.tool=e.tool AND r.sequence<e.sequence
  UNION SELECT e.fact FROM events e JOIN cells c ON c.cell=e.cell AND c.first_read<e.sequence
   WHERE e.kind='cell' AND e.tool IS NULL
  UNION SELECT fact FROM returns
  UNION SELECT e.fact FROM events e JOIN returns r ON r.run=e.run AND r.tool=e.tool AND r.sequence<e.sequence
   WHERE e.kind='tool_result_accepted' AND e.accepted_kind='local'
 );
END;

DROP VIEW agent_history_tool_metadata_source;
CREATE VIEW agent_history_tool_metadata_source AS
WITH facts AS (
    SELECT h.sequence, h.kind, jsonb(maka_content_text(c.payload, c.encoding)) AS fact
    FROM agent_session_history h
    JOIN agent_facts f ON f.sequence=h.sequence
    JOIN contents c ON c.id=f.body_content_id
    WHERE h.result_source=1
), evidence AS (
    SELECT f.sequence, f.kind, maka_content_text(c.payload, c.encoding) AS payload
    FROM facts f
    JOIN contents c ON c.content_sha256=CASE f.kind
        WHEN 'cell' THEN json_extract(f.fact,'$.fact.event.result.digest')
        WHEN 'external_effect' THEN json_extract(f.fact,'$.fact.event.output.digest')
        ELSE json_extract(f.fact,'$.fact.result.digest') END
), returns AS (
    SELECT e.sequence, e.kind,
           jsonb(CASE WHEN e.kind='tool_result_accepted' THEN maka_content_text(c.payload, c.encoding) ELSE e.payload END) AS value
    FROM evidence e
    LEFT JOIN contents c ON e.kind='tool_result_accepted'
        AND json_extract(e.payload,'$.kind') IN ('local','host','operation')
        AND c.content_sha256=json_extract(e.payload,'$.result.digest')
    WHERE e.kind<>'tool_result_accepted' OR c.id IS NOT NULL
), bodies AS (
    SELECT sequence,kind, CASE WHEN kind='external_effect' THEN value
                              ELSE jsonb_extract(value,'$.body') END AS body
    FROM returns
), media AS (
    SELECT sequence,
           CASE WHEN kind='external_effect' AND json_extract(body,'$.kind')='failure' THEN 1
                ELSE COALESCE(json_extract(body,'$.is_error'),json_extract(body,'$.isError')) END AS is_error,
           CASE WHEN json_extract(body,'$.output.format')='image' THEN json_extract(body,'$.output.value.ref') END AS inline_image,
           CASE json_extract(body,'$.projection.kind')
                WHEN 'inline' THEN jsonb_extract(body,'$.projection.projection.parts')
                WHEN 'content' THEN jsonb_extract(body,'$.projection.parts') END AS parts,
           CASE WHEN kind='external_effect' THEN
                CASE json_extract(body,'$.kind') WHEN 'failure' THEN json_extract(body,'$.settlement')
                                                WHEN 'output' THEN 'returned' END END AS external_settlement
    FROM bodies
)
SELECT m.sequence, m.is_error,
       m.inline_image IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM json_each(m.parts) p
           WHERE json_extract(p.value,'$.kind')='artifact'
             AND json_extract(p.value,'$.image.ref.kind')=json_extract(m.inline_image,'$.kind')
             AND json_extract(p.value,'$.image.ref.sessionId') IS json_extract(m.inline_image,'$.sessionId')
             AND json_extract(p.value,'$.image.ref.refId') IS json_extract(m.inline_image,'$.refId')
             AND json_extract(p.value,'$.image.ref.relativePath') IS json_extract(m.inline_image,'$.relativePath')
             AND json_extract(p.value,'$.image.ref.absolutePath') IS json_extract(m.inline_image,'$.absolutePath')
       ) AS image,
       (SELECT count(*) FROM json_each(m.parts) p WHERE json_extract(p.value,'$.kind')='artifact') AS images,
       m.external_settlement
FROM media m;

DROP VIEW agent_memory_cell_accept_source;
CREATE VIEW agent_memory_cell_accept_source AS
 SELECT h.sequence,obs.cell,obs.through_sequence
 FROM agent_memory_new_history h JOIN agent_session_history origin ON origin.namespace_id=h.namespace_id
  AND origin.run=h.run AND origin.tool_use_id=h.tool_use_id AND origin.sequence<h.sequence AND origin.kind='local_tool_returned'
 JOIN agent_memory_cell_observations obs ON obs.sequence=origin.sequence
 JOIN agent_facts f ON f.sequence=h.sequence JOIN contents b ON b.id=f.body_content_id
 JOIN contents accepted ON accepted.content_sha256=json_extract(maka_content_text(b.payload,b.encoding),'$.fact.result.digest')
 WHERE h.kind='tool_result_accepted' AND json_extract(maka_content_text(accepted.payload,accepted.encoding),'$.kind')='local'
 UNION ALL
 SELECT sequence,json_extract(doc,'$.fact.outcome.cell'),sequence
 FROM (
   SELECT h.sequence, jsonb(maka_content_text(b.payload,b.encoding)) AS doc
   FROM agent_memory_new_history h
   JOIN agent_facts f ON f.sequence=h.sequence
   JOIN contents b ON b.id=f.body_content_id
   WHERE h.kind='tool_result_accepted'
 )
 WHERE json_extract(doc,'$.fact.outcome.kind')='cell_recovered';

DROP VIEW agent_memory_cell_code_source;
CREATE VIEW agent_memory_cell_code_source AS
 SELECT message,fact,run,
   CASE kind
   WHEN 'model_observed' THEN 'code:agent:'||attempt||':'||(doc->>'$.fact.part.call.id')
   WHEN 'external_effect' THEN 'code:external:'||(doc->>'$.fact.event.key.task')||':'||(doc->>'$.fact.event.key.operation')
   WHEN 'cell' THEN CASE doc->>'$.fact.event.owner.kind'
     WHEN 'agent' THEN 'code:agent:'||attempt||':'||(doc->>'$.fact.event.owner.call')
     WHEN 'external' THEN 'code:external:'||(doc->>'$.fact.event.owner.key.task')||':'||(doc->>'$.fact.event.owner.key.operation') END
   END AS tool,kind,field_start,field_end,content
 FROM (
   SELECT d.id AS message,h.fact_id AS fact,h.run,h.kind,h.attempt,h.tool_start,
     d.fields_json->>'$[#-1].field' AS last_field,
     d.fields_json->>'$[#-1].start' AS field_start,d.fields_json->>'$[#-1].end' AS field_end,
     substr(CAST(d.body AS BLOB),1+(d.fields_json->>'$[#-1].start')) AS content,
     jsonb(maka_content_text(b.payload,b.encoding)) AS doc
   FROM agent_recall_messages d CROSS JOIN agent_memory_new_history h ON h.sequence=d.sequence
   CROSS JOIN agent_facts f ON f.sequence=h.sequence CROSS JOIN contents b ON b.id=f.body_content_id
   WHERE d.ordinal=0 AND (
     (h.kind IN ('model_observed','external_effect') AND h.tool_start=1 AND d.fields_json->>'$[#-1].field'='arguments')
     OR h.kind='cell'
   )
 )
 WHERE (kind IN ('model_observed','external_effect') AND tool_start=1 AND last_field='arguments')
    OR (kind='cell' AND doc->>'$.fact.event.kind'='started');

DROP VIEW agent_memory_cell_event_source;
CREATE VIEW agent_memory_cell_event_source AS
 SELECT h.sequence,json_extract(maka_content_text(b.payload,b.encoding),'$.fact.event.cell') AS cell
 FROM agent_memory_new_history h JOIN agent_facts f ON f.sequence=h.sequence JOIN contents b ON b.id=f.body_content_id
 WHERE h.kind='cell';

DROP VIEW agent_memory_cell_publication_source;
CREATE VIEW agent_memory_cell_publication_source AS
 SELECT sequence,doc->>'$.fact.event.cell' AS cell,sequence-1 AS through_sequence
 FROM (
   SELECT h.sequence, jsonb(maka_content_text(b.payload,b.encoding)) AS doc
   FROM agent_memory_new_history h JOIN agent_facts f USING(sequence) JOIN contents b ON b.id=f.body_content_id
   WHERE h.kind='cell'
 )
 WHERE doc->>'$.fact.event.kind' IN
 ('completed','interrupted','notification_queued','final_notification_queued','session_value_published','loaded_tools_published');

DROP VIEW agent_memory_cell_return_source;
CREATE VIEW agent_memory_cell_return_source AS
 SELECT sequence,CASE kind WHEN 'local_tool_returned'
  THEN json_extract(ret_doc,'$.body.output.value.cell')
  ELSE json_extract(ret_doc,'$.output.value.cell') END AS cell,sequence AS through_sequence
 FROM (
   SELECT h.sequence, h.kind, jsonb(maka_content_text(ret.payload,ret.encoding)) AS ret_doc
   FROM agent_memory_new_history h JOIN agent_facts f ON f.sequence=h.sequence JOIN contents b ON b.id=f.body_content_id
   JOIN contents ret ON ret.content_sha256=CASE h.kind WHEN 'local_tool_returned'
    THEN json_extract(maka_content_text(b.payload,b.encoding),'$.fact.result.digest') ELSE json_extract(maka_content_text(b.payload,b.encoding),'$.fact.event.output.digest') END
   WHERE h.result_source=1 AND h.kind IN ('local_tool_returned','external_effect')
 )
 WHERE (kind='local_tool_returned' AND json_extract(ret_doc,'$.body.output.format')='cell')
    OR (kind='external_effect' AND json_extract(ret_doc,'$.output.format')='cell');

DROP VIEW agent_memory_failed_terminations;
CREATE VIEW agent_memory_failed_terminations AS
 SELECT d.id AS message,d.body,h.fact_id AS fact,h.run,h.namespace_id,h.sequence,length(CAST(d.body AS BLOB)) AS end
 FROM agent_recall_messages d CROSS JOIN agent_memory_new_history h ON h.sequence=d.sequence
 CROSS JOIN agent_facts f ON f.sequence=h.sequence CROSS JOIN contents b ON b.id=f.body_content_id
 WHERE d.ordinal=0 AND h.kind='run_terminated' AND maka_content_text(b.payload,b.encoding)->>'$.fact.terminal'='failed';

DROP VIEW agent_memory_imported_tool_source;
CREATE VIEW agent_memory_imported_tool_source AS
 WITH messages AS (
   SELECT e.snapshot,e.position AS message,maka_content_text(m.payload,m.encoding) AS m_text
   FROM agent_history_snapshot_entries e CROSS JOIN contents m ON m.content_sha256=e.entry_json->>'$.message.digest'
   WHERE e.kind='imported'
 ), parts AS (
   SELECT msg.snapshot,msg.message,part.key AS part,
     json_extract(msg.m_text,'$.originalOrdinal') AS original_ordinal,
     json_extract(msg.m_text,'$.original.digest') AS original,
     jsonb(maka_content_text(b.payload,b.encoding)) AS b_doc
   FROM messages msg
   CROSS JOIN json_each(msg.m_text,'$.parts') part
   CROSS JOIN contents b ON b.content_sha256=part.value->>'$.digest'
 )
 SELECT snapshot,message,part,original_ordinal,original,call_id,name,is_call,read_path FROM (
   SELECT snapshot,message,part,original_ordinal,original,
     coalesce(json_extract(b_doc,'$.part.call.id'),json_extract(b_doc,'$.call_id'),json_extract(b_doc,'$.part.id')) AS call_id,
     coalesce(json_extract(b_doc,'$.part.call.name'),json_extract(b_doc,'$.name'),json_extract(b_doc,'$.part.name')) AS name,
     CASE WHEN json_extract(b_doc,'$.kind')='tool_return' THEN 0
          WHEN json_extract(b_doc,'$.kind')='model' THEN CASE json_extract(b_doc,'$.part.kind') WHEN 'tool_call' THEN 1 WHEN 'tool_result' THEN 0 END END AS is_call,
     json_extract(b_doc,'$.part.call.input.data.path') AS read_path
   FROM parts
 ) WHERE (name='Read' AND is_call IS NOT NULL) OR (name IN ('Recall','RecallMore','RecallMaterial','SessionRead') AND is_call=0);

DROP VIEW agent_memory_operation_field_source;
CREATE VIEW agent_memory_operation_field_source AS
 WITH docs AS (
   SELECT d.id AS message,h.fact_id AS fact,h.run,h.tool_use_id AS tool,h.kind,h.tool_start,h.result_source,d.fields_json,
     CASE WHEN cell.id IS NOT NULL THEN json_extract(maka_content_text(cell.payload,cell.encoding),'$.fact.event.kind') END AS cell_kind,
     CASE WHEN accepted.id IS NOT NULL THEN json_extract(maka_content_text(accepted.payload,accepted.encoding),'$.kind') END AS accepted_kind,
     CASE WHEN returned.id IS NOT NULL THEN json_extract(maka_content_text(returned.payload,returned.encoding),'$.body.projection.kind') END AS proj_kind
   FROM agent_recall_messages d CROSS JOIN agent_memory_new_history h ON h.sequence=d.sequence
   LEFT JOIN contents cell ON h.kind='cell' AND cell.content_sha256=d.references_json->>'$[0].digest'
   LEFT JOIN contents accepted ON h.kind='tool_result_accepted' AND accepted.content_sha256=d.references_json->>'$[1].digest'
   LEFT JOIN contents returned ON returned.content_sha256=CASE h.kind
      WHEN 'cell' THEN d.references_json->>'$[1].digest'
      WHEN 'host_tool_result_recorded' THEN d.references_json->>'$[1].digest'
      WHEN 'tool_result_accepted' THEN d.references_json->>'$[2].digest' END
   WHERE d.ordinal=0
 )
 SELECT docs.message,docs.fact,docs.run,docs.tool,
        field.value->>'$.start' AS start,field.value->>'$.end' AS end
 FROM docs
 CROSS JOIN json_each(docs.fields_json) field
 WHERE field.value->>'$.end'>field.value->>'$.start' AND (
   (docs.kind='operation_observed' AND field.key=0) OR
   (docs.kind='external_effect' AND docs.tool_start=0 AND docs.result_source=0 AND field.key=0) OR
   (docs.kind='cell' AND docs.cell_kind='child_observed' AND field.key=0) OR
   (docs.kind='tool_result_accepted' AND docs.accepted_kind IN ('host','observed_operation','operation') AND field.key=0) OR
   ((docs.kind='cell' AND docs.cell_kind='child_result_recorded' AND field.key=1 OR
     docs.kind='host_tool_result_recorded' AND field.key=0 OR
     docs.kind='tool_result_accepted' AND field.key=1 AND docs.accepted_kind IN ('host','operation'))
     AND docs.proj_kind IN ('result','receipt','from_output'))
 );

DROP VIEW agent_memory_recall_call_source;
CREATE VIEW agent_memory_recall_call_source AS
 WITH base AS (
   SELECT h.sequence,h.run,h.tool_use_id,jsonb(maka_content_text(b.payload,b.encoding)) AS b_doc
   FROM agent_memory_new_history h
   JOIN agent_facts f ON f.sequence=h.sequence
   JOIN contents b ON b.id=f.body_content_id
   WHERE h.tool_start=1
 ), joined AS (
   SELECT base.sequence,base.run,base.tool_use_id,base.b_doc,
     CASE WHEN x.id IS NOT NULL THEN jsonb(maka_content_text(x.payload,x.encoding)) END AS x_doc,
     CASE WHEN i.id IS NOT NULL THEN json_extract(maka_content_text(i.payload,i.encoding),'$.path') END AS i_path
   FROM base
   LEFT JOIN contents x ON x.content_sha256=json_extract(base.b_doc,'$.fact.event.descriptor.digest')
   LEFT JOIN contents i ON i.content_sha256=json_extract(base.b_doc,'$.fact.event.input.digest')
 )
 SELECT calls.sequence,calls.run,calls.tool_use_id,calls.cell,CASE WHEN alias.kind='file' OR (alias.kind IS NULL AND calls.name='Read') THEN path END AS read_path FROM (
   SELECT sequence,run,tool_use_id,json_extract(b_doc,'$.fact.event.cell') AS cell,
    coalesce(json_extract(b_doc,'$.fact.part.call.name'),json_extract(b_doc,'$.fact.event.name'),
       json_extract(b_doc,'$.fact.output.name'),json_extract(x_doc,'$.name')) AS name,
    coalesce(json_extract(b_doc,'$.fact.part.call.input.data.path'),json_extract(b_doc,'$.fact.output.input.path'),
       json_extract(x_doc,'$.input.path'),i_path) AS path
   FROM joined
 ) calls LEFT JOIN agent_memory_read_aliases alias ON alias.run=calls.run AND alias.name=calls.name
 WHERE alias.kind='session' OR (alias.kind IS NULL AND calls.name IN ('Recall','RecallMore','RecallMaterial','SessionRead'))
    OR (((alias.kind IS NULL AND calls.name='Read') OR alias.kind='file') AND (path GLOB 'maka://*' OR path GLOB 'attachment:*' OR path GLOB 'session:*' OR path GLOB 'archive:*'));

DROP VIEW agent_memory_termination_receipts;
CREATE VIEW agent_memory_termination_receipts AS
 WITH op_unknown AS (
   SELECT t.message,t.fact,t.run,t.end,t.body,t.namespace_id,t.sequence AS term_seq,
     op.tool_use_id AS tool,op.sequence AS op_seq,
     jsonb(maka_content_text(b.payload,b.encoding)) AS b_doc,
     jsonb(maka_content_text(r.payload,r.encoding)) AS r_doc
   FROM agent_memory_failed_terminations t
   CROSS JOIN agent_session_history blocked ON blocked.namespace_id=t.namespace_id AND blocked.run=t.run
     AND blocked.kind='blocked' AND blocked.sequence<t.sequence
   CROSS JOIN agent_facts bf ON bf.sequence=blocked.sequence CROSS JOIN contents b ON b.id=bf.body_content_id
   CROSS JOIN agent_session_history op ON op.namespace_id=t.namespace_id AND op.run=t.run
     AND op.step=blocked.step AND op.kind='operation_observed' AND op.attempt=blocked.attempt AND op.sequence<t.sequence
   CROSS JOIN agent_facts ofact ON ofact.sequence=op.sequence CROSS JOIN contents r ON r.id=ofact.body_content_id
 ), ext_unknown AS (
   SELECT t.message,t.fact,t.run,t.end,t.body,t.namespace_id,t.sequence AS term_seq,
     op.tool_use_id AS tool,op.sequence AS op_seq,
     jsonb(maka_content_text(b.payload,b.encoding)) AS b_doc,
     jsonb(maka_content_text(r.payload,r.encoding)) AS r_doc
   FROM agent_memory_failed_terminations t
   CROSS JOIN agent_session_history blocked ON blocked.namespace_id=t.namespace_id AND blocked.run=t.run
     AND blocked.kind='blocked' AND blocked.sequence<t.sequence
   CROSS JOIN agent_facts bf ON bf.sequence=blocked.sequence CROSS JOIN contents b ON b.id=bf.body_content_id
   CROSS JOIN agent_session_history op ON op.namespace_id=t.namespace_id AND op.run=t.run
     AND op.kind='external_effect' AND op.tool_start=0 AND op.result_source=0 AND op.sequence<t.sequence
   CROSS JOIN agent_facts ofact ON ofact.sequence=op.sequence CROSS JOIN contents r ON r.id=ofact.body_content_id
 ), ext_diag AS (
   SELECT message,fact,run,end,body,namespace_id,term_seq,tool,op_seq,
     CASE WHEN r_doc->>'$.fact.event.observation.receipt.outcome.kind'='unknown'
       THEN r_doc->>'$.fact.event.observation.receipt.outcome.diagnostic'
       WHEN r_doc->>'$.fact.event.observation.receipt.kind'='unavailable'
       THEN r_doc->>'$.fact.event.observation.receipt.diagnostic' END AS diag
   FROM ext_unknown
   WHERE b_doc->>'$.fact.reason.kind'='external_effect_unknown'
     AND r_doc->>'$.fact.event.kind'='observed'
     AND r_doc->>'$.fact.event.key.task'=b_doc->>'$.fact.reason.task'
     AND r_doc->>'$.fact.event.key.operation'=b_doc->>'$.fact.reason.operation'
 )
 SELECT DISTINCT message,fact,run,end,tool
 FROM op_unknown
 WHERE b_doc->>'$.fact.reason.kind'='operation_unknown'
   AND r_doc->>'$.fact.reply.reference.operation'=b_doc->>'$.fact.reason.reference.operation'
   AND r_doc->>'$.fact.tool.call'=b_doc->>'$.fact.reason.tool.call'
   AND body=CASE WHEN r_doc->>'$.fact.reply.receipt.outcome.kind'='unknown'
     THEN r_doc->>'$.fact.reply.receipt.outcome.diagnostic'
     WHEN r_doc->>'$.fact.reply.receipt.kind'='unavailable' THEN r_doc->>'$.fact.reply.receipt.diagnostic' END
   AND NOT EXISTS (SELECT 1 FROM agent_session_history later WHERE later.namespace_id=op_unknown.namespace_id
     AND later.tool_use_id=op_unknown.tool AND later.run=op_unknown.run AND later.kind='operation_observed'
     AND later.sequence>op_unknown.op_seq AND later.sequence<op_unknown.term_seq)
 UNION
 SELECT DISTINCT message,fact,run,end,tool
 FROM ext_diag
 WHERE body IN (diag, rtrim(diag,'.')||'. The call may still be running; its end was not confirmed.')
   AND NOT EXISTS (
     SELECT 1 FROM agent_session_history later
     CROSS JOIN agent_facts lf ON lf.sequence=later.sequence
     CROSS JOIN contents lr ON lr.id=lf.body_content_id
     WHERE later.namespace_id=ext_diag.namespace_id
       AND later.tool_use_id=ext_diag.tool AND later.run=ext_diag.run
       AND later.kind='external_effect' AND later.tool_start=0 AND later.result_source=0
       AND later.sequence>ext_diag.op_seq AND later.sequence<ext_diag.term_seq
       AND maka_content_text(lr.payload,lr.encoding)->>'$.fact.event.kind'='observed'
   );
