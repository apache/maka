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
-- Search tokens use NFC; assertion and evidence offsets address the original bytes.
CREATE VIEW agent_memory_recall_current AS
 SELECT k.seq, hex(m.namespace)||'x'||hex(m.scope) AS location, maka_nfc(v.body) AS body
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

-- Match the TEXT and INTEGER affinities of the history join keys so SQLite
-- can seek the full expression index when the lookup value comes from a row.
CREATE INDEX agent_memory_evidence_address ON agent_memory_evidence(namespace,
 CAST(json_extract(source,'$.reference.factId') AS TEXT),CAST(json_extract(source,'$.reference.itemIndex') AS INTEGER));
CREATE VIEW agent_memory_restricted_evidence AS
 SELECT e.* FROM agent_memory_evidence e JOIN agent_memory_versions v ON v.namespace=e.namespace AND v.scope=e.scope
 AND v.id=e.id AND v.revision=e.assertion JOIN agent_memories m ON m.namespace=e.namespace
 AND m.scope=e.scope AND m.id=e.id
 WHERE e.source->>'kind'='conversation' AND (v.disposition<>'current' OR m.state<>'active' OR m.assertion<>e.assertion);
CREATE VIEW agent_memory_hidden_spans AS
 SELECT e.namespace,CAST(json_extract(e.source,'$.reference.factId') AS TEXT) AS fact,
 CAST(json_extract(e.source,'$.reference.itemIndex') AS INTEGER) AS ordinal,
 json_extract(e.source,'$.reference.start') AS start,json_extract(e.source,'$.reference.end') AS end,
 json_extract(e.source,'$.reference.sessionId') AS session,json_extract(e.source,'$.reference.sequence') AS sequence
 FROM agent_memory_restricted_evidence e;

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

CREATE TABLE agent_memory_read_aliases (
 run TEXT NOT NULL REFERENCES agent_run_specs(run) ON DELETE CASCADE,
 name TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(run,name)
) WITHOUT ROWID;
-- A legacy Web, Skill or Shell input projection was validated against its service
-- contract at admission. Its method can share a name with an Agent method.
CREATE VIEW agent_memory_read_alias_source AS
 WITH services AS (
   SELECT r.run, service.value->>'$.selection.name' AS name,
          service.value->>'$.selection.target.kind' AS target_kind,
          service.value->>'$.selection.target.name' AS target_name,
          service.value->>'$.selection.method' AS method,
          service.value->>'$.selection.input' AS input,
          service.value->>'$.history_reader' AS frozen
   FROM agent_run_specs r JOIN contents spec ON spec.id=r.spec_content_id
   JOIN contents selection ON selection.content_sha256=json_extract(CAST(spec.payload AS TEXT),'$.toolSelection.digest')
   CROSS JOIN json_each(CAST(selection.payload AS TEXT),'$.services') service
 ), classified_methods AS (
   SELECT *, method IN ('memory','memories','execution','continuationAvailability','work','sessionRead','history',
     'historyLandmarks','historyPrompt','historyRequests','source','search','toolImage','attachmentImage') AS agent_history
   FROM services
 )
 SELECT run,name,kind FROM (
   SELECT run,name,CASE
     WHEN target_kind='export' AND target_name='agent' AND method IN ('execution','continuationAvailability') THEN 'session'
     WHEN frozen IS NOT NULL THEN frozen
     WHEN target_kind='import' AND target_name='files' AND method='read' THEN 'file'
     WHEN target_kind='export' AND target_name='agent' AND agent_history THEN 'session'
     WHEN name IN ('Read','SessionRead','Recall','RecallMore','RecallMaterial')
       AND (input IN ('web','skill','shell') OR (method<>'read' AND NOT agent_history)) THEN 'other'
   END AS kind FROM classified_methods
 ) WHERE kind IS NOT NULL;
INSERT INTO agent_memory_read_aliases SELECT * FROM agent_memory_read_alias_source;
CREATE TRIGGER agent_memory_read_alias_insert AFTER INSERT ON agent_run_specs BEGIN
 INSERT INTO agent_memory_read_aliases SELECT * FROM agent_memory_read_alias_source WHERE run=NEW.run;
END;

CREATE TABLE agent_memory_recall_calls (
 sequence INTEGER PRIMARY KEY REFERENCES agent_session_history(sequence) ON DELETE CASCADE,
 run TEXT NOT NULL, tool_use_id TEXT NOT NULL, cell TEXT, read_path TEXT
);
CREATE INDEX agent_memory_recall_call_id ON agent_memory_recall_calls(run,tool_use_id);
CREATE INDEX agent_memory_recall_call_cell ON agent_memory_recall_calls(run,cell);
CREATE INDEX agent_memory_recall_cell_sequence ON agent_memory_recall_calls(cell,sequence) WHERE cell IS NOT NULL;
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
-- Decode Read continuations once per immutable call. Only historical calls
-- need to participate in the observation cutoff of future notifications.
INSERT INTO agent_memory_recall_calls SELECT * FROM agent_memory_recall_call_source
 WHERE read_path IS NULL OR maka_reads_history_resource(read_path);
CREATE TRIGGER agent_memory_recall_call_insert AFTER INSERT ON agent_session_history WHEN NEW.tool_start=1 BEGIN
 INSERT INTO agent_memory_recall_calls SELECT * FROM agent_memory_recall_call_source
 WHERE sequence=NEW.sequence AND (read_path IS NULL OR maka_reads_history_resource(read_path));
END;

-- Imported call IDs are scoped to their snapshot. Use the most recent preceding
-- call when a provider reuses an ID. Raw source records can own several rows.
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

-- Preparation and approval index the same immutable child input after their
-- respective receipt fields. Keep the restriction relative to the arguments.
CREATE VIEW agent_memory_return_segments AS
 SELECT h.owner,h.session,h.run,h.tool_use_id,h.fact_id,h.sequence,d.ordinal,h.kind,d.body,
    CASE h.kind WHEN 'tool_result_accepted' THEN d.references_json->>'$[2].digest'
                ELSE d.references_json->>'$[1].digest' END AS content,
    CASE WHEN h.kind IN ('cell','tool_result_accepted') THEN d.fields_json->>'$[#-1].start'
         ELSE d.fields_json->>'$[0].start' END AS start,
    CASE WHEN h.kind IN ('cell','tool_result_accepted') THEN d.fields_json->>'$[#-1].end'
         ELSE d.fields_json->>'$[0].end' END AS end
 FROM agent_session_history h
 JOIN agent_recall_messages d ON d.owner=h.owner AND d.session=h.session AND d.sequence=h.sequence AND d.ordinal=0
 WHERE h.kind IN ('tool_result_accepted','local_tool_returned','host_tool_result_recorded')
    OR (h.kind='model_observed' AND h.tool_use_id IS NOT NULL AND h.tool_start=0)
    OR (h.kind='cell' AND h.tool_use_id IS NOT NULL AND d.fields_json->>'$[#-1].field'='arguments');
CREATE VIEW agent_memory_sibling_spans(namespace,fact,ordinal,start,end,session,sequence) AS
 SELECT dest.owner,dest.fact_id,dest.ordinal,
        dest.start + max(hidden.start,src.start) - src.start,
        dest.start + min(hidden.end,src.end) - src.start,dest.session,dest.sequence
 FROM agent_memory_return_segments dest CROSS JOIN agent_memory_return_segments src
 CROSS JOIN agent_memory_hidden_spans hidden
 WHERE src.owner=dest.owner AND src.session=dest.session AND src.run=dest.run
 AND src.tool_use_id=dest.tool_use_id AND src.fact_id<>dest.fact_id AND (
    src.content=dest.content OR
    ((src.kind='tool_result_accepted' AND dest.kind='model_observed' OR
      dest.kind='tool_result_accepted' AND src.kind='model_observed')
     AND src.content IS NULL AND dest.content IS NULL AND src.body=dest.body))
 AND src.end-src.start=dest.end-dest.start
 AND hidden.namespace=src.owner AND hidden.fact=src.fact_id AND hidden.ordinal=src.ordinal
 AND hidden.start<src.end AND hidden.end>src.start;

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

-- One historical field can derive from several matching receipts. Retain
-- each immutable association even when those receipts used the same wording.
CREATE TABLE agent_memory_shared_fields(
 message INTEGER NOT NULL REFERENCES agent_recall_messages(id) ON DELETE CASCADE,
 fact TEXT NOT NULL, run TEXT NOT NULL, tool TEXT NOT NULL,
 start INTEGER NOT NULL,end INTEGER NOT NULL,PRIMARY KEY(fact,start,tool)
) WITHOUT ROWID;
CREATE INDEX agent_memory_shared_fields_tool ON agent_memory_shared_fields(run,tool);
-- Bound foreign-key cleanup to the messages removed by a Session index rebuild.
CREATE INDEX agent_memory_shared_fields_message ON agent_memory_shared_fields(message);

-- Only the durable return codec can identify a projection derived from a Host
-- receipt. Independent projections of the same call keep their own evidence.
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
INSERT INTO agent_memory_shared_fields SELECT * FROM agent_memory_operation_field_source;
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

CREATE INDEX agent_memory_run_termination ON agent_session_history(run) WHERE kind='run_terminated';
CREATE INDEX agent_memory_interruption_attempt ON agent_session_history(run,attempt)
 WHERE kind='model_interrupted';
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

-- Keep the sparse set of restricted conversation evidence indexed by Run.
-- Cell observations can depend on earlier events or on fields shared with
-- later receipts. The observation cutoff applies to the derived cell event.
CREATE TABLE agent_memory_run_restrictions(
 evidence INTEGER PRIMARY KEY REFERENCES agent_memory_evidence(sequence) ON DELETE CASCADE,
 run TEXT NOT NULL, source INTEGER NOT NULL REFERENCES agent_session_history(sequence) ON DELETE CASCADE
);
CREATE INDEX agent_memory_restrictions_source ON agent_memory_run_restrictions(source);
CREATE VIEW agent_memory_run_restriction_source AS
 SELECT e.sequence AS evidence,h.run,h.sequence AS source,e.namespace,e.scope,e.id,e.assertion
 FROM agent_memory_restricted_evidence e JOIN agent_session_history h
 ON h.owner=e.namespace AND h.fact_id=CAST(json_extract(e.source,'$.reference.factId') AS TEXT);
INSERT INTO agent_memory_run_restrictions
 SELECT evidence,run,source FROM agent_memory_run_restriction_source;

CREATE TRIGGER agent_memory_run_restriction_evidence AFTER INSERT ON agent_memory_evidence
 WHEN NEW.source->>'kind'='conversation' BEGIN
 INSERT INTO agent_memory_run_restrictions SELECT evidence,run,source FROM agent_memory_run_restriction_source WHERE evidence=NEW.sequence;
END;
CREATE TRIGGER agent_memory_run_restriction_history AFTER INSERT ON agent_session_history BEGIN
 INSERT INTO agent_memory_run_restrictions SELECT e.sequence,NEW.run,NEW.sequence FROM agent_memory_restricted_evidence e
 WHERE e.namespace=NEW.owner AND CAST(json_extract(e.source,'$.reference.factId') AS TEXT)=NEW.fact_id;
END;
CREATE TRIGGER agent_memory_run_restriction_state AFTER UPDATE OF state,assertion ON agent_memories
 WHEN OLD.state<>NEW.state OR OLD.assertion<>NEW.assertion BEGIN
 DELETE FROM agent_memory_run_restrictions WHERE evidence IN
   (SELECT sequence FROM agent_memory_evidence WHERE namespace=NEW.namespace AND scope=NEW.scope AND id=NEW.id AND source->>'kind'='conversation');
 INSERT INTO agent_memory_run_restrictions SELECT evidence,run,source FROM agent_memory_run_restriction_source
 WHERE namespace=NEW.namespace AND scope=NEW.scope AND id=NEW.id;
END;
CREATE TRIGGER agent_memory_run_restriction_version AFTER UPDATE OF disposition ON agent_memory_versions
 WHEN OLD.disposition<>NEW.disposition BEGIN
 DELETE FROM agent_memory_run_restrictions WHERE evidence IN
   (SELECT sequence FROM agent_memory_evidence WHERE namespace=NEW.namespace AND scope=NEW.scope AND id=NEW.id AND assertion=NEW.revision AND source->>'kind'='conversation');
 INSERT INTO agent_memory_run_restrictions SELECT evidence,run,source FROM agent_memory_run_restriction_source
 WHERE namespace=NEW.namespace AND scope=NEW.scope AND id=NEW.id AND assertion=NEW.revision;
END;

-- Keep only cell events that have a restricted source. A linked receipt is a
-- candidate until its projected field and the source byte range are checked.
CREATE INDEX agent_memory_cell_tool ON agent_session_history(run,tool_use_id) WHERE tool_use_id IS NOT NULL;
CREATE VIEW agent_memory_cell_shared_routes AS
 SELECT a.run,a.tool,src.sequence AS source,e.sequence AS event
 FROM agent_memory_shared_fields a JOIN agent_session_history src ON src.fact_id=a.fact
 JOIN agent_memory_shared_fields d ON d.run=a.run AND d.tool=a.tool AND d.fact<>a.fact
 JOIN agent_session_history dest ON dest.fact_id=d.fact JOIN agent_memory_cell_events e ON e.sequence=dest.sequence;
CREATE VIEW agent_memory_cell_routes(source,event) AS
 SELECT sequence,sequence FROM agent_memory_cell_events
 UNION ALL
 SELECT src.sequence,dest.sequence FROM agent_session_history src
 JOIN agent_session_history dest ON dest.run=src.run AND dest.tool_use_id=src.tool_use_id
   AND dest.kind='cell' AND dest.tool_use_id IS NOT NULL AND dest.sequence<>src.sequence
   AND src.tool_use_id IS NOT NULL
 UNION ALL SELECT source,event FROM agent_memory_cell_shared_routes;

CREATE TABLE agent_memory_cell_candidates(
 evidence INTEGER NOT NULL REFERENCES agent_memory_run_restrictions(evidence) ON DELETE CASCADE,
 event INTEGER NOT NULL REFERENCES agent_memory_cell_events(sequence) ON DELETE CASCADE,
 cell TEXT NOT NULL, direct INTEGER NOT NULL, PRIMARY KEY(evidence,event)
) WITHOUT ROWID;
CREATE INDEX agent_memory_cell_candidate_cut ON agent_memory_cell_candidates(cell,event);
CREATE INDEX agent_memory_cell_candidate_event ON agent_memory_cell_candidates(event);
CREATE VIEW agent_memory_cell_candidate_source AS
 SELECT er.evidence,e.sequence AS event,e.cell,er.source=e.sequence AS direct
 FROM agent_memory_run_restrictions er JOIN agent_memory_cell_routes link ON link.source=er.source
 JOIN agent_memory_cell_events e ON e.sequence=link.event;
INSERT OR IGNORE INTO agent_memory_cell_candidates SELECT * FROM agent_memory_cell_candidate_source;

CREATE TRIGGER agent_memory_cell_candidate_evidence AFTER INSERT ON agent_memory_run_restrictions BEGIN
 INSERT OR IGNORE INTO agent_memory_cell_candidates SELECT * FROM agent_memory_cell_candidate_source WHERE evidence=NEW.evidence;
END;
CREATE TRIGGER agent_memory_cell_candidate_history AFTER INSERT ON agent_memory_cell_events BEGIN
 INSERT OR IGNORE INTO agent_memory_cell_candidates SELECT * FROM agent_memory_cell_candidate_source WHERE event=NEW.sequence;
END;
CREATE TRIGGER agent_memory_cell_candidate_field AFTER INSERT ON agent_memory_shared_fields BEGIN
 INSERT OR IGNORE INTO agent_memory_cell_candidates
 SELECT er.evidence,e.sequence,e.cell,0 FROM agent_memory_cell_shared_routes link
 JOIN agent_memory_run_restrictions er ON er.source=link.source
 JOIN agent_memory_cell_events e ON e.sequence=link.event
 WHERE link.run=NEW.run AND link.tool=NEW.tool;
END;

CREATE VIEW agent_memory_recall_outputs(owner,fact) AS
 SELECT h.owner,h.fact_id FROM agent_session_history h WHERE
 ((h.result_source=1 OR h.kind IN ('cell','operation_observed','external_task_observed','model_observed'))
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
