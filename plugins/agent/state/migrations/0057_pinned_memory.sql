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

-- Keep only identities here. The model and the archive have different read contracts.
CREATE TABLE agent_memory_tool_inputs (
 run TEXT NOT NULL REFERENCES agent_run_specs(run) ON DELETE CASCADE,
 namespace TEXT NOT NULL, scope TEXT NOT NULL, id TEXT NOT NULL,
 assertion INTEGER NOT NULL, revision INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(run,scope,id,assertion,revision)
) WITHOUT ROWID;
CREATE INDEX agent_memory_tool_assertion ON agent_memory_tool_inputs(namespace,scope,id,assertion) WHERE revoked=0;
CREATE INDEX agent_memory_tool_revoked ON agent_memory_tool_inputs(run) WHERE revoked=1;
CREATE INDEX agent_memory_tool_project ON agent_memory_tool_inputs(run,scope) WHERE scope<>'personal';

CREATE TRIGGER agent_memory_tool_revoke AFTER UPDATE OF disposition ON agent_memory_versions
WHEN NEW.disposition<>OLD.disposition AND NEW.disposition<>'current' BEGIN
 UPDATE agent_memory_tool_inputs SET revoked=1 WHERE namespace=NEW.namespace AND scope=NEW.scope
  AND id=NEW.id AND assertion=NEW.revision AND revoked=0;
END;

-- A rendered archive, cell result or attachment may combine several source rows.
-- Fence its first read against later restrictions even if the tool result is opaque.
CREATE TABLE agent_memory_visibility (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
INSERT INTO agent_memory_visibility VALUES(1,0);
CREATE TABLE agent_memory_history_reads (
 run TEXT PRIMARY KEY REFERENCES agent_run_specs(run) ON DELETE CASCADE, revision INTEGER NOT NULL
) WITHOUT ROWID;
-- Old declarations did not classify recap methods. A local Agent export names
-- its original contract; an old import records only a slot, not its contract.
CREATE VIEW agent_memory_selection_readers AS
 SELECT selection_id,name,CASE WHEN legacy_recap THEN 'session' ELSE reader END AS kind,legacy_recap FROM (
  SELECT selection.id AS selection_id,service.value->>'$.selection.name' AS name,service.value->>'$.history_reader' AS reader,
   (coalesce(service.value->>'$.history_reader','other')='other'
    AND service.value->>'$.selection.method' IN ('recap','generateRecap')
    AND (service.value->>'$.selection.target.kind'='import' OR
      (service.value->>'$.selection.target.kind'='export' AND service.value->>'$.selection.target.name'='agent'))) AS legacy_recap
  FROM contents selection CROSS JOIN json_each(CAST(selection.payload AS TEXT),'$.services') service);
CREATE VIEW agent_memory_selected_readers AS
 SELECT r.run,a.name,a.kind,a.legacy_recap FROM agent_run_specs r CROSS JOIN contents spec ON spec.id=r.spec_content_id
 CROSS JOIN contents selection ON selection.content_sha256=CAST(spec.payload AS TEXT)->>'$.toolSelection.digest'
 CROSS JOIN agent_memory_selection_readers a ON a.selection_id=selection.id;
DROP TRIGGER agent_memory_read_alias_insert;
CREATE TRIGGER agent_memory_read_alias_insert AFTER INSERT ON agent_run_specs BEGIN
 INSERT INTO agent_memory_read_aliases SELECT run,name,kind FROM agent_memory_selected_readers
 WHERE run=NEW.run AND kind IS NOT NULL;
END;
CREATE TEMP TABLE memory_recap_aliases(run TEXT,name TEXT,PRIMARY KEY(run,name)) WITHOUT ROWID;
INSERT INTO memory_recap_aliases SELECT run,name FROM agent_memory_selected_readers WHERE legacy_recap;
INSERT INTO agent_memory_read_aliases SELECT run,name,kind FROM agent_memory_selected_readers
 WHERE run IN (SELECT run FROM memory_recap_aliases) AND kind IS NOT NULL
 ON CONFLICT(run,name) DO UPDATE SET kind=excluded.kind;

-- Include the prefix of affected pre-v51 conversations when indexing original
-- cell returns and later waits. The same boundary applies after a history rebuild.
CREATE TABLE agent_memory_legacy_recap_history (
 session TEXT PRIMARY KEY REFERENCES session_control(id) ON DELETE CASCADE, first_sequence INTEGER NOT NULL
) WITHOUT ROWID;
INSERT INTO agent_memory_legacy_recap_history
 SELECT h.session,min(h.sequence) FROM agent_session_history h JOIN session_control s ON s.id=h.session
 JOIN agent_facts f ON f.sequence=h.sequence JOIN contents b ON b.id=f.body_content_id
 LEFT JOIN contents descriptor ON descriptor.content_sha256=CAST(b.payload AS TEXT)->>'$.fact.event.descriptor.digest'
 WHERE h.run IN (SELECT run FROM memory_recap_aliases) AND h.tool_start=1
 AND h.sequence<=(SELECT last_existing_fact FROM agent_memory_history_boundary)
 AND EXISTS(SELECT 1 FROM memory_recap_aliases a WHERE a.run=h.run AND a.name=coalesce(
  CAST(b.payload AS TEXT)->>'$.fact.part.call.name', CAST(b.payload AS TEXT)->>'$.fact.event.name',
  CAST(b.payload AS TEXT)->>'$.fact.output.name', CAST(descriptor.payload AS TEXT)->>'$.name'))
 GROUP BY h.session;
DROP VIEW agent_memory_new_history;
CREATE VIEW agent_memory_new_history AS SELECT h.* FROM agent_session_history h
 WHERE h.sequence>(SELECT last_existing_fact FROM agent_memory_history_boundary)
 OR EXISTS(SELECT 1 FROM agent_memory_legacy_recap_history l WHERE l.session=h.session AND h.sequence>=l.first_sequence);
CREATE TEMP TABLE memory_old_recap_rows(sequence INTEGER PRIMARY KEY);
INSERT INTO memory_old_recap_rows SELECT h.sequence FROM agent_memory_legacy_recap_history l
 CROSS JOIN agent_session_history h WHERE h.session=l.session AND h.sequence BETWEEN l.first_sequence AND
 (SELECT last_existing_fact FROM agent_memory_history_boundary);
INSERT OR IGNORE INTO agent_memory_cell_events SELECT * FROM agent_memory_cell_event_source WHERE sequence IN memory_old_recap_rows;
INSERT OR IGNORE INTO agent_memory_cell_observations SELECT * FROM agent_memory_cell_return_source WHERE sequence IN memory_old_recap_rows;
INSERT OR IGNORE INTO agent_memory_cell_observations SELECT * FROM agent_memory_cell_accept_source WHERE sequence IN memory_old_recap_rows;
INSERT OR IGNORE INTO agent_memory_cell_observations SELECT * FROM agent_memory_cell_publication_source WHERE sequence IN memory_old_recap_rows;
DROP TABLE memory_old_recap_rows;
INSERT OR IGNORE INTO agent_memory_recall_calls SELECT * FROM agent_memory_recall_call_source
 WHERE run IN (SELECT run FROM memory_recap_aliases) AND (read_path IS NULL OR maka_reads_history_resource(read_path));
DROP TABLE memory_recap_aliases;

-- A fork and a transferred canonical snapshot own their facts independently of
-- the source session. Derive the tool dependencies from the completed inventory:
-- archive ingest can deliver inventory pages in reverse order.
CREATE TABLE agent_memory_indexed_snapshots (
 snapshot TEXT PRIMARY KEY REFERENCES agent_history_snapshots(snapshot) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
) WITHOUT ROWID;
CREATE TABLE agent_memory_snapshot_outputs (
 snapshot TEXT NOT NULL REFERENCES agent_memory_indexed_snapshots(snapshot) ON DELETE CASCADE,
 fact TEXT NOT NULL, PRIMARY KEY(snapshot,fact)
) WITHOUT ROWID;
CREATE TRIGGER agent_memory_snapshot_index AFTER INSERT ON agent_memory_indexed_snapshots BEGIN
 INSERT INTO agent_memory_snapshot_outputs(snapshot,fact)
 SELECT NEW.snapshot,fact FROM (
  WITH aliases AS MATERIALIZED (
   SELECT e.run,a.name,a.kind FROM agent_history_snapshot_entries e
   CROSS JOIN contents spec ON spec.content_sha256=e.entry_json->>'$.spec.digest'
   CROSS JOIN contents selection ON selection.content_sha256=spec.payload->>'$.toolSelection.digest'
   CROSS JOIN agent_memory_selection_readers a ON a.selection_id=selection.id
   WHERE e.snapshot=NEW.snapshot AND e.kind='run'
  ), events AS MATERIALIZED (
   SELECT e.sequence,e.run,e.entry_json->>'$.id' AS fact,e.entry_json->>'$.tool_use_id' AS tool,
    b.payload->>'$.fact.kind' AS kind,
    coalesce(b.payload->>'$.fact.part.kind',b.payload->>'$.fact.event.kind',b.payload->>'$.fact.output.type') AS event,
    b.payload->>'$.fact.event.cell' AS cell,
    coalesce(b.payload->>'$.fact.part.call.name',b.payload->>'$.fact.event.name',
     b.payload->>'$.fact.output.name',descriptor.payload->>'$.name') AS name,
    coalesce(b.payload->>'$.fact.part.call.input.data.path',b.payload->>'$.fact.output.input.path',
     descriptor.payload->>'$.input.path',input.payload->>'$.path') AS path,
    coalesce(CASE WHEN ret.payload->>'$.body.output.format'='cell' THEN ret.payload->>'$.body.output.value.cell' END,
     CASE WHEN ret.payload->>'$.output.format'='cell' THEN ret.payload->>'$.output.value.cell' END,
     CASE WHEN b.payload->>'$.fact.outcome.kind'='cell_recovered' THEN b.payload->>'$.fact.outcome.cell' END) AS observed_cell,
    ret.payload->>'$.kind' AS accepted_kind
   FROM agent_history_snapshot_entries e
   CROSS JOIN contents b ON b.content_sha256=e.entry_json->>'$.body.digest'
   LEFT JOIN contents descriptor ON descriptor.content_sha256=b.payload->>'$.fact.event.descriptor.digest'
   LEFT JOIN contents input ON input.content_sha256=b.payload->>'$.fact.event.input.digest'
   LEFT JOIN contents ret ON ret.content_sha256=coalesce(b.payload->>'$.fact.result.digest',b.payload->>'$.fact.event.output.digest')
   WHERE e.snapshot=NEW.snapshot AND e.kind='fact'
    AND (e.entry_json->>'$.tool_use_id' IS NOT NULL OR coalesce(e.fact_kind,b.payload->>'$.fact.kind')='cell')
    AND (e.fact_kind IS NULL OR e.fact_kind IN ('model_observed','external_task_observed','external_effect',
         'cell','local_tool_returned','tool_result_accepted','host_tool_result_recorded','operation_observed'))
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
INSERT INTO agent_memory_indexed_snapshots SELECT DISTINCT snapshot FROM agent_history_snapshot_entries WHERE kind='run';

-- The executor may keep prior context outside the local database.
CREATE TABLE agent_memory_external_epochs (
 session TEXT PRIMARY KEY REFERENCES session_control(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;

-- Only outstanding legacy admissions can still switch models. Keep their original
-- receiver's identity without retaining operation inputs, results or memory text.
CREATE TEMP TABLE memory_handoff_runs(run TEXT PRIMARY KEY) WITHOUT ROWID;
WITH RECURSIVE pending(run) AS (
 SELECT run FROM agent_runs WHERE local=1 AND terminal IS NULL
 UNION
 SELECT b.payload->>'$.trigger.source' FROM pending p JOIN agent_run_specs s ON s.run=p.run
 JOIN contents b ON b.id=s.spec_content_id WHERE b.payload->>'$.trigger.kind'='checkpoint_handoff'
)
INSERT INTO memory_handoff_runs SELECT run FROM pending;
CREATE TEMP TABLE legacy_sources (
 session TEXT NOT NULL,
 source TEXT NOT NULL, ordinary INTEGER NOT NULL, PRIMARY KEY(session,source)
) WITHOUT ROWID;
CREATE TEMP TABLE memory_handoff_targets (
 session TEXT NOT NULL, source TEXT NOT NULL, owner TEXT NOT NULL, method TEXT NOT NULL,
 PRIMARY KEY(session,source)
) WITHOUT ROWID;
INSERT INTO memory_handoff_targets
 SELECT session,message,owner,'send' FROM agent_queue_items
 WHERE state='pending' OR accepted_run IN memory_handoff_runs;
INSERT INTO memory_handoff_targets
 SELECT s.session,s.run,s.owner,
        CASE b.payload->>'$.trigger.kind' WHEN 'context_compact' THEN 'compact' ELSE 'continueRun' END
 FROM memory_handoff_runs p CROSS JOIN agent_run_specs s ON s.run=p.run JOIN contents b ON b.id=s.spec_content_id
 WHERE b.payload->>'$.trigger.kind' IN ('context_compact','continuation');
INSERT INTO legacy_sources
 SELECT t.session,t.source,min(o.request_json->>'$.origin.kind' IN ('native','remote'))
 FROM (SELECT 1 FROM memory_handoff_targets LIMIT 1) CROSS JOIN application_operations o
 CROSS JOIN contents r ON r.id=o.outcome_content_id
 CROSS JOIN memory_handoff_targets t
 ON t.session=coalesce(r.payload->>'$.value.sessionId',r.payload->>'$.value.execution.sessionId')
 AND t.source=coalesce(r.payload->>'$.value.messageId',r.payload->>'$.value.execution.runId')
 WHERE o.request_json->>'export'='agent' AND o.request_json->>'method' IN ('send','compact','continueRun')
 AND o.request_json->>'$.origin.kind' IS NOT NULL AND r.payload->>'kind'='success'
 AND t.method=o.request_json->>'method' AND o.deployment=t.owner->>'deployment' AND o.namespace=t.owner->'namespace'
 AND (r.payload->>'$.value.kind'='started' OR (t.method='send' AND r.payload->>'$.value.kind'='queued'))
 GROUP BY t.session,t.source;
DROP TABLE memory_handoff_targets;
DROP TABLE memory_handoff_runs;

-- The global clock orders a search against changes while its result sessions are
-- still unknown. Only changes to one of its returned sources invalidate a read.
CREATE TABLE agent_memory_session_visibility (
 session TEXT PRIMARY KEY REFERENCES session_control(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE agent_memory_session_reads (
 run TEXT NOT NULL REFERENCES agent_run_specs(run) ON DELETE CASCADE,
 session TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(run,session)
) WITHOUT ROWID;
CREATE INDEX agent_memory_read_source ON agent_memory_session_reads(session,run);
CREATE INDEX agent_memory_conversation_source ON agent_memory_evidence(namespace,source->>'$.reference.sessionId')
 WHERE source->>'kind'='conversation';
CREATE INDEX agent_memory_snapshots_by_fact ON agent_history_snapshot_entries(json_extract(entry_json,'$.id'),snapshot)
 WHERE kind='fact';
CREATE INDEX agent_memory_adoptions_by_snapshot ON agent_history_snapshot_adoptions(snapshot,run);

-- Track only the dependencies of the current remote conversation. Once the
-- executor rotates, changes to its discarded journal cannot rotate its successor.
CREATE TABLE agent_memory_external_sources (
 session TEXT NOT NULL REFERENCES session_control(id) ON DELETE CASCADE,
 source TEXT NOT NULL, PRIMARY KEY(source,session)
) WITHOUT ROWID;
CREATE INDEX agent_memory_external_sources_reader ON agent_memory_external_sources(session);
CREATE INDEX agent_memory_visibility_change ON agent_memory_session_visibility(revision,session);
CREATE VIEW agent_memory_rotate_external(session,revision) AS SELECT session,revision FROM agent_memory_external_epochs;
CREATE TRIGGER agent_memory_rotate_journal INSTEAD OF INSERT ON agent_memory_rotate_external BEGIN
 INSERT INTO agent_memory_external_epochs VALUES(NEW.session,NEW.revision)
 ON CONFLICT(session) DO UPDATE SET revision=excluded.revision;
 DELETE FROM agent_memory_external_sources WHERE session=NEW.session;
END;

CREATE VIEW agent_memory_changed_sessions(session) AS SELECT session FROM agent_memory_session_visibility;
CREATE TRIGGER agent_memory_change_session INSTEAD OF INSERT ON agent_memory_changed_sessions BEGIN
 UPDATE agent_memory_visibility SET revision=revision+1 WHERE id=1;
 INSERT INTO agent_memory_session_visibility
 WITH RECURSIVE affected(session) AS (
   SELECT NEW.session UNION
   SELECT r.session FROM affected a CROSS JOIN agent_memory_session_reads h ON h.session=a.session
   CROSS JOIN agent_run_specs r ON r.run=h.run
 )
 SELECT s.id,(SELECT revision FROM agent_memory_visibility) FROM affected a
 CROSS JOIN session_control s ON s.id=a.session WHERE 1
 ON CONFLICT(session) DO UPDATE SET revision=excluded.revision;
 INSERT INTO agent_memory_rotate_external
 WITH journals AS MATERIALIZED (
  SELECT DISTINCT e.session,v.revision FROM agent_memory_session_visibility v
  CROSS JOIN agent_memory_external_sources e ON e.source=v.session
  WHERE v.revision=(SELECT revision FROM agent_memory_visibility)
 ) SELECT session,revision FROM journals;
END;

-- The parent snapshot pins the complete nested inventory, including each
-- nested manifest. A fork can retain an evidence fact after its live source retires.
CREATE VIEW agent_memory_adopted_snapshots(owner,session,snapshot) AS
 SELECT r.owner,r.session,a.snapshot FROM agent_run_specs r JOIN agent_history_snapshot_adoptions a ON a.run=r.run
 UNION ALL
 SELECT r.owner,r.session,child.snapshot FROM agent_run_specs r JOIN agent_history_snapshot_adoptions a ON a.run=r.run
 JOIN agent_history_snapshot_pins p ON p.snapshot=a.snapshot
 JOIN agent_history_snapshots child ON child.manifest_content_id=p.content_id AND child.snapshot<>a.snapshot;
CREATE VIEW agent_memory_evidence_sessions(namespace,scope,id,assertion,evidence,session) AS
 SELECT namespace,scope,id,assertion,sequence,source->>'$.reference.sessionId' FROM agent_memory_evidence WHERE source->>'kind'='conversation'
 UNION ALL
 SELECT e.namespace,e.scope,e.id,e.assertion,e.sequence,r.session FROM agent_memory_evidence e
 CROSS JOIN agent_history_snapshot_entries f ON f.kind='fact' AND json_extract(f.entry_json,'$.id')=e.source->>'$.reference.factId'
 CROSS JOIN agent_history_snapshot_adoptions a ON a.snapshot=f.snapshot
 CROSS JOIN agent_run_specs r ON r.run=a.run AND r.owner=e.namespace
 WHERE e.source->>'kind'='conversation'
 UNION ALL
 SELECT e.namespace,e.scope,e.id,e.assertion,e.sequence,r.session FROM agent_memory_evidence e
 CROSS JOIN agent_history_snapshot_entries f ON f.kind='fact' AND json_extract(f.entry_json,'$.id')=e.source->>'$.reference.factId'
 CROSS JOIN agent_history_snapshots child ON child.snapshot=f.snapshot
 CROSS JOIN agent_history_snapshot_pins p ON p.content_id=child.manifest_content_id AND p.snapshot<>child.snapshot
 CROSS JOIN agent_history_snapshot_adoptions a ON a.snapshot=p.snapshot
 CROSS JOIN agent_run_specs r ON r.run=a.run AND r.owner=e.namespace
 WHERE e.source->>'kind'='conversation';
CREATE TRIGGER agent_memory_history_revoke AFTER INSERT ON agent_memory_run_restrictions BEGIN
 INSERT INTO agent_memory_changed_sessions SELECT DISTINCT session FROM agent_memory_evidence_sessions WHERE evidence=NEW.evidence;
END;
CREATE TRIGGER agent_memory_hidden_span_revoke AFTER UPDATE OF disposition ON agent_memory_versions
WHEN OLD.disposition='current' AND NEW.disposition<>'current' BEGIN
 INSERT INTO agent_memory_changed_sessions SELECT DISTINCT session FROM agent_memory_evidence_sessions
 WHERE namespace=NEW.namespace AND scope=NEW.scope AND id=NEW.id AND assertion=NEW.revision;
END;
CREATE TRIGGER agent_memory_source_private AFTER UPDATE OF archived,configuration ON session_control
WHEN (OLD.archived=0 AND NEW.archived=1) OR
 (coalesce(OLD.configuration->>'incognito',0)=0 AND NEW.configuration->>'incognito'=1) BEGIN
 INSERT INTO agent_memory_changed_sessions VALUES(NEW.id);
END;
CREATE TRIGGER agent_memory_source_retired AFTER INSERT ON session_retirements WHEN NEW.remove_session=1 BEGIN
 INSERT INTO agent_memory_changed_sessions VALUES(NEW.session_id);
END;
CREATE TRIGGER agent_memory_source_removal AFTER UPDATE OF remove_session ON session_retirements
WHEN OLD.remove_session=0 AND NEW.remove_session=1 BEGIN
 INSERT INTO agent_memory_changed_sessions VALUES(NEW.session_id);
END;

-- A bare receipt predates visibility capture. Its text remains available to its
-- human owner. Preserve the plugin store revision and deletion tombstones.
UPDATE plugin_data SET value_json=json_object('visibility',NULL,'receipt',json(value_json))
 WHERE package_id='maka.session-recap' AND scope_id='profile'
 AND value_json->>'kind' IN ('ready','pending','failed');

-- A later Run can inherit context from an earlier Run in the same session.
CREATE TEMP TABLE legacy_candidates(run TEXT PRIMARY KEY) WITHOUT ROWID;
WITH first_read(owner, session, first_run) AS (
 SELECT owner, session, min(admission_sequence) FROM agent_runs
 WHERE run IN (SELECT run FROM agent_memory_recall_calls)
    OR run IN (SELECT run FROM agent_session_history WHERE tool_start=1 AND
               sequence <= (SELECT last_existing_fact FROM agent_memory_history_boundary))
    OR local=0
 GROUP BY owner, session
)
INSERT INTO legacy_candidates(run)
 SELECT r.run FROM first_read f JOIN agent_runs r
 ON r.owner=f.owner AND r.session=f.session AND r.admission_sequence>=f.first_run;

-- A spelling is not a binding. Old file selections have a host-appended
-- paragraph in the frozen definition that was absent from the caller's own
-- declaration. This proves the file contract even for aliases on import slots.
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
 FROM legacy_candidates h JOIN agent_run_specs r ON r.run=h.run
 JOIN contents spec ON spec.id=r.spec_content_id
 JOIN contents selection ON selection.content_sha256=spec.payload->>'$.toolSelection.digest'
 CROSS JOIN json_each(selection.payload,'$.services') a;

CREATE TEMP TABLE legacy_opaque(run TEXT PRIMARY KEY) WITHOUT ROWID;
WITH calls AS (
 SELECT h.owner,h.session,h.run,h.tool_use_id,h.attempt,
  coalesce(b.payload->>'$.fact.part.call.name',b.payload->>'$.fact.event.name',
   b.payload->>'$.fact.output.name',x.payload->>'$.name') AS name,
  coalesce(b.payload->>'$.fact.part.call.input.data.path',b.payload->>'$.fact.output.input.path',
   x.payload->>'$.input.path',i.payload->>'$.path') AS path
 FROM legacy_candidates old JOIN agent_session_history h ON h.run=old.run AND h.tool_start=1
 LEFT JOIN agent_facts f ON f.sequence=h.sequence AND f.run=h.run
 LEFT JOIN contents b ON b.id=f.body_content_id
 LEFT JOIN contents x ON x.content_sha256=b.payload->>'$.fact.event.descriptor.digest'
 LEFT JOIN contents i ON i.content_sha256=b.payload->>'$.fact.event.input.digest'
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
 JOIN legacy_candidates old ON old.run=r.run
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

CREATE TEMP TABLE legacy_boundary(owner TEXT,session TEXT,first_run INTEGER,PRIMARY KEY(owner,session)) WITHOUT ROWID;
INSERT INTO legacy_boundary SELECT r.owner,r.session,min(r.admission_sequence)
 FROM legacy_opaque o JOIN agent_runs r ON r.run=o.run GROUP BY r.owner,r.session;
INSERT INTO agent_memory_history_reads(run,revision)
 SELECT r.run,-1 FROM legacy_boundary b JOIN agent_runs r ON r.owner=b.owner AND r.session=b.session
 AND r.admission_sequence>=b.first_run JOIN legacy_candidates c ON c.run=r.run;
INSERT INTO agent_memory_external_epochs(session)
 SELECT DISTINCT r.session FROM legacy_candidates c JOIN agent_run_specs r ON r.run=c.run
 JOIN session_control s ON s.id=r.session WHERE r.session IN (SELECT session FROM legacy_boundary);
DROP TABLE legacy_candidates;
DROP TABLE legacy_opaque;

-- The immutable request and checkpoint bytes predate the replay field. Record
-- positive evidence once; detached or removed sources have no such authority.
CREATE TABLE agent_memory_legacy_runs (
 run TEXT PRIMARY KEY REFERENCES agent_run_specs(run) ON DELETE CASCADE,
 shared INTEGER NOT NULL, ordinary INTEGER
) WITHOUT ROWID;
INSERT INTO agent_memory_legacy_runs(run,shared)
 SELECT r.run,NOT EXISTS(SELECT 1 FROM legacy_boundary boundary WHERE boundary.owner=r.owner
                        AND boundary.session=r.session AND boundary.first_run<=r.admission_sequence)

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
    (SELECT ordinary FROM legacy_sources WHERE session=i.session AND source=i.run)
  WHEN spec->>'$.trigger.kind' IS NOT 'message' THEN 0
  WHEN input->>'$.kind' IS NOT 'message' THEN NULL
  WHEN coalesce(json_array_length(input,'$.source_messages'),0)=0 THEN
   (SELECT ordinary FROM legacy_sources WHERE session=i.session AND source=spec->>'$.trigger.message_id')
  WHEN json_array_length(input,'$.source_messages')=1 AND input->>'$.request_fingerprint' IS NULL THEN 0
  ELSE (SELECT CASE WHEN min(CASE WHEN m.value->>'$.origin' IS NOT NULL THEN 0 ELSE s.ordinary END)=0 THEN 0
                WHEN count(s.ordinary)=count(*) THEN 1 END
        FROM json_each(input,'$.source_messages') m LEFT JOIN legacy_sources s
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
 LEFT JOIN legacy_sources s ON s.session=q.session AND s.source=q.message
 LEFT JOIN contents origin ON origin.content_sha256=q.entry_json->>'$.request.source.digest'
 WHERE q.state='pending' AND json_type(q.entry_json,'$.request.spec')='object'
 AND q.entry_json->>'$.request.spec.memoryAdmission' IS NULL;
UPDATE agent_queue_items AS q SET entry_json=json_set(entry_json,'$.request.spec.memoryAdmission',l.admission)
 FROM agent_memory_legacy_queue l WHERE q.session=l.session AND q.request=l.request;
DROP TABLE legacy_sources;
