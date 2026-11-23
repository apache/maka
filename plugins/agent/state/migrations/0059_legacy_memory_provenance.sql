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

-- A spelling is not a binding. Old file selections have a host-appended
-- paragraph in the frozen definition that was absent from the caller's own
-- declaration. This proves the file contract even for aliases on import slots.
UPDATE legacy_v53 SET published=1 WHERE data_version<>(SELECT data_version FROM pragma_data_version);
CREATE TEMP TABLE legacy_bindings (
 run TEXT NOT NULL, name TEXT NOT NULL, reader TEXT NOT NULL, PRIMARY KEY(run,name)
) WITHOUT ROWID;
INSERT INTO legacy_bindings
 SELECT r.run,a.value->>'$.selection.name',CASE
  WHEN a.value->>'$.history_reader'='file' THEN 'file'
  WHEN a.value->>'$.history_reader'='session' THEN 'opaque'
  WHEN a.value->>'$.selection.method'='execute' AND a.value->>'$.selection.input'='shell' AND a.value->>'$.selection.result'='json' THEN 'plain'
  WHEN a.value->>'$.selection.method'='read' AND EXISTS(
   SELECT 1 FROM json_each(selection.payload,'$.definitions') d
   WHERE d.value->>'$.name'=a.value->>'$.selection.name' AND d.value->>'$.description'=
    (a.value->>'$.selection.description') || char(10,10) ||
    'Also reads Maka resources (maka://session/<id>, maka://session/<id>/tool-results/<event-id>, attachment:<id>, archive:<event-id>). Pass page.next unchanged to continue reading.'
  ) THEN 'file'
  ELSE 'opaque' END
 FROM agent_memory_history_reads h JOIN agent_run_specs r ON r.run=h.run
 JOIN contents spec ON spec.id=r.spec_content_id
 JOIN contents selection ON selection.content_sha256=spec.payload->>'$.toolSelection.digest'
 CROSS JOIN json_each(selection.payload,'$.services') a WHERE h.revision=-1;

CREATE TEMP TABLE legacy_opaque(run TEXT PRIMARY KEY) WITHOUT ROWID;
WITH calls AS (
 SELECT h.owner,h.session,h.run,h.tool_use_id,h.attempt,
  coalesce(b.payload->>'$.fact.part.call.name',b.payload->>'$.fact.event.name',
   b.payload->>'$.fact.output.name',x.payload->>'$.name') AS name,
  coalesce(b.payload->>'$.fact.part.call.input.data.path',b.payload->>'$.fact.output.input.path',
   x.payload->>'$.input.path',i.payload->>'$.path') AS path
 FROM agent_memory_history_reads old JOIN agent_session_history h ON h.run=old.run AND h.tool_start=1
 LEFT JOIN agent_facts f ON f.sequence=h.sequence AND f.run=h.run
 LEFT JOIN contents b ON b.id=f.body_content_id
 LEFT JOIN contents x ON x.content_sha256=b.payload->>'$.fact.event.descriptor.digest'
 LEFT JOIN contents i ON i.content_sha256=b.payload->>'$.fact.event.input.digest'
 WHERE old.revision=-1
)
INSERT OR IGNORE INTO legacy_opaque
 SELECT c.run FROM calls c LEFT JOIN legacy_bindings a ON a.run=c.run AND a.name=c.name
 WHERE CASE a.reader WHEN 'plain' THEN 0 WHEN 'file' THEN CASE WHEN typeof(c.path)='text'
 THEN maka_reads_history_resource(c.path) ELSE 1 END ELSE 1 END
 AND NOT EXISTS (
  SELECT 1 FROM agent_session_history h JOIN agent_facts f ON f.sequence=h.sequence JOIN contents b ON b.id=f.body_content_id
  WHERE h.owner=c.owner AND h.session=c.session AND h.tool_use_id=c.tool_use_id AND h.run=c.run
  AND h.attempt=c.attempt AND h.kind='tool_original_bound'
  AND b.payload->>'$.fact.reference.contract.name'='maka.workspace.Files'
  AND b.payload->>'$.fact.reference.method' IN ('edit','write','applyPatch')
 );
INSERT OR IGNORE INTO legacy_opaque SELECT run FROM agent_memory_recall_calls;
-- Profile-scoped retirement may retain a Run stub after releasing its facts.
-- An incomplete projection cannot establish the absence of a historical read.
INSERT OR IGNORE INTO legacy_opaque SELECT r.run FROM agent_runs r
 JOIN agent_run_specs s ON s.run=r.run JOIN contents b ON b.id=s.spec_content_id
 WHERE b.payload->>'$.memoryAdmission' IS NULL AND
 (r.revision<>(SELECT count(*) FROM agent_facts f WHERE f.run=r.run) OR EXISTS(
   SELECT 1 FROM agent_facts f LEFT JOIN agent_session_history h ON h.sequence=f.sequence
   WHERE f.run=r.run AND (h.run IS NOT f.run OR h.fact_id IS NOT f.id)
 ));
DROP TABLE legacy_bindings;

-- Imported text-only inventories have no previous Agent read or checkpoint.
-- Canonical forks, opaque provider context and incomplete inventories stay fenced.
INSERT OR IGNORE INTO legacy_opaque SELECT r.run FROM agent_runs r
 JOIN agent_memory_history_reads old ON old.run=r.run AND old.revision=-1
 WHERE r.local=0 AND NOT EXISTS (
  SELECT 1 FROM agent_history_snapshot_adoptions a JOIN agent_history_snapshots s ON s.snapshot=a.snapshot
  JOIN contents manifest ON manifest.id=s.manifest_content_id
  WHERE a.run=r.run AND manifest.payload->>'$.origin.kind'='imported'
  AND EXISTS (SELECT 1 FROM agent_history_snapshot_entries e WHERE e.snapshot=a.snapshot AND e.kind='imported')
  AND NOT EXISTS (
   SELECT 1 FROM agent_history_snapshot_entries e
   LEFT JOIN contents m ON m.content_sha256=e.entry_json->>'$.message.digest'
   LEFT JOIN json_each(m.payload,'$.parts') part
   LEFT JOIN contents b ON b.content_sha256=part.value->>'$.digest'
   WHERE e.snapshot=a.snapshot AND (e.kind IN ('run','fact','source') OR
     (e.kind='imported' AND (m.payload->>'$.role' IS NOT 'user' OR b.payload->>'$.kind' IS NOT 'input'
       OR typeof(b.payload->>'$.content.text')!='text' OR m.payload->>'$.providerMetadata' IS NOT NULL
       OR coalesce(json_array_length(m.payload,'$.media'),0)>0 OR coalesce(json_array_length(b.payload,'$.content.directory_references'),0)>0
       OR coalesce(json_array_length(b.payload,'$.content.attachments'),0)>0 OR coalesce(json_array_length(b.payload,'$.content.quotes'),0)>0
       OR coalesce(json_array_length(b.payload,'$.content.inline_references'),0)>0 OR coalesce(json_array_length(b.payload,'$.content.preparation'),0)>0)))
  )
 );

-- v53 used INSERT OR IGNORE for real reads. On an already running v53
-- database an outstanding call may have shared the sentinel's ledger row.
INSERT OR IGNORE INTO legacy_opaque SELECT r.run FROM agent_runs r
 JOIN agent_memory_history_reads h ON h.run=r.run WHERE h.revision=-1 AND r.terminal IS NULL
 AND (SELECT published FROM legacy_v53);
CREATE TEMP TABLE legacy_boundary(owner TEXT,session TEXT,first_run INTEGER,PRIMARY KEY(owner,session)) WITHOUT ROWID;
INSERT INTO legacy_boundary SELECT r.owner,r.session,min(r.admission_sequence)
 FROM legacy_opaque o JOIN agent_runs r ON r.run=o.run GROUP BY r.owner,r.session;
DELETE FROM agent_memory_history_reads WHERE revision=-1 AND run IN (
 SELECT r.run FROM agent_runs r LEFT JOIN legacy_boundary b ON b.owner=r.owner AND b.session=r.session
 WHERE b.first_run IS NULL OR r.admission_sequence<b.first_run
);
-- A remote executor can keep its journal outside this database. If v53 has
-- ever served this root, its published key can already name a divergent thread.
DELETE FROM agent_memory_external_epochs WHERE revision=0 AND NOT (SELECT published FROM legacy_v53)
 AND session NOT IN (SELECT session FROM legacy_boundary);
DROP TABLE legacy_opaque;
DROP TABLE legacy_v53;

-- The immutable request and checkpoint bytes predate the replay field. Record
-- positive evidence once; detached or removed sources have no such authority.
CREATE TABLE agent_memory_legacy_runs (
 run TEXT PRIMARY KEY REFERENCES agent_run_specs(run) ON DELETE CASCADE,
 shared INTEGER NOT NULL, ordinary INTEGER
) WITHOUT ROWID;
INSERT INTO agent_memory_legacy_runs(run,shared)
 SELECT r.run,NOT EXISTS(SELECT 1 FROM legacy_boundary boundary WHERE boundary.owner=r.owner
                        AND boundary.session=r.session AND boundary.first_run<=r.admission_sequence)
 AND NOT EXISTS(SELECT 1 FROM agent_memory_history_reads h WHERE h.run=r.run)
 AND NOT EXISTS(SELECT 1 FROM agent_memory_tool_inputs t WHERE t.run=r.run)
 FROM agent_runs r JOIN agent_run_specs s ON s.run=r.run JOIN contents spec ON spec.id=s.spec_content_id
 WHERE spec.payload->>'$.memoryAdmission' IS NULL;
DROP TABLE legacy_boundary;

-- Freeze the original receiver for outstanding handoffs in this transaction.
WITH RECURSIVE ancestors(target,run) AS (
 SELECT r.run,r.run FROM agent_runs r JOIN agent_memory_legacy_runs a ON a.run=r.run
 WHERE r.local=1 AND r.terminal IS NULL
 UNION
 SELECT a.target,b.payload->>'$.trigger.source' FROM ancestors a JOIN agent_run_specs s ON s.run=a.run
 JOIN contents b ON b.id=s.spec_content_id WHERE b.payload->>'$.trigger.kind'='checkpoint_handoff'
 AND b.payload->>'$.origin.kind'='local' AND b.payload->>'$.allowedTools' IS NULL
), inputs AS (
 SELECT a.target,s.session,s.run,b.payload AS spec,i.payload AS input FROM ancestors a
 JOIN agent_run_specs s ON s.run=a.run JOIN contents b ON b.id=s.spec_content_id
 LEFT JOIN contents i ON i.content_sha256=b.payload->>'$.input.digest'
 WHERE b.payload->>'$.trigger.kind' IS NOT 'checkpoint_handoff' OR b.payload->>'$.origin.kind' IS NOT 'local'
 OR b.payload->>'$.allowedTools' IS NOT NULL
), decisions AS (
 SELECT target,CASE
  WHEN spec->>'$.origin.kind' IS NOT 'local' OR spec->>'$.allowedTools' IS NOT NULL THEN 0
  WHEN spec->>'$.trigger.kind' IN ('context_compact','continuation') THEN
    (SELECT ordinary FROM agent_memory_legacy_sources WHERE session=i.session AND source=i.run)
  WHEN spec->>'$.trigger.kind' IS NOT 'message' THEN 0
  WHEN input->>'$.kind' IS NOT 'message' THEN NULL
  WHEN coalesce(json_array_length(input,'$.source_messages'),0)=0 THEN
   (SELECT ordinary FROM agent_memory_legacy_sources WHERE session=i.session AND source=spec->>'$.trigger.message_id')
  WHEN json_array_length(input,'$.source_messages')=1 AND input->>'$.request_fingerprint' IS NULL THEN 0
  ELSE (SELECT CASE WHEN min(CASE WHEN m.value->>'$.origin' IS NOT NULL THEN 0 ELSE s.ordinary END)=0 THEN 0
                WHEN count(s.ordinary)=count(*) THEN 1 END
        FROM json_each(input,'$.source_messages') m LEFT JOIN agent_memory_legacy_sources s
        ON s.session=i.session AND s.source=m.value->>'$.message_id') END AS ordinary
 FROM inputs i
)
UPDATE agent_memory_legacy_runs AS r SET ordinary=d.ordinary FROM decisions d WHERE r.run=d.target;

-- Queue events are immutable. Keep the migrated decision independent of the
-- queue projection so an explicit rebuild can restore it after replay.
CREATE TABLE agent_memory_legacy_queue (
 session TEXT NOT NULL REFERENCES session_control(id) ON DELETE CASCADE,
 request TEXT NOT NULL, admission TEXT NOT NULL, PRIMARY KEY(session,request)
) WITHOUT ROWID;
INSERT INTO agent_memory_legacy_queue
 SELECT q.session,q.request,CASE
 WHEN q.entry_json->>'$.request.spec.origin.kind'!='local' OR q.entry_json->>'$.request.spec.allowedTools' IS NOT NULL
 OR q.entry_json->>'$.request.spec.trigger.kind'!='message' OR origin.payload->>'$.origin' IS NOT NULL OR s.ordinary=0 THEN 'excluded'
 WHEN q.entry_json->>'$.request.spec.origin.kind'='local' AND q.entry_json->>'$.request.spec.trigger.kind'='message'
 AND q.entry_json->>'$.request.spec.trigger.message_id'=q.message AND origin.payload->>'$.message_id'=q.message
 AND s.ordinary=1 THEN 'disabled' ELSE 'legacy' END FROM agent_queue_items q JOIN session_control c ON c.id=q.session
 LEFT JOIN agent_memory_legacy_sources s ON s.session=q.session AND s.source=q.message
 LEFT JOIN contents origin ON origin.content_sha256=q.entry_json->>'$.request.source.digest'
 WHERE q.state='pending' AND json_type(q.entry_json,'$.request.spec')='object'
 AND q.entry_json->>'$.request.spec.memoryAdmission' IS NULL;
UPDATE agent_queue_items AS q SET entry_json=json_set(entry_json,'$.request.spec.memoryAdmission',l.admission)
 FROM agent_memory_legacy_queue l WHERE q.session=l.session AND q.request=l.request;
DROP TABLE agent_memory_legacy_sources;
