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

-- The global clock orders a search against changes while its result sessions are
-- still unknown. Only changes to one of its returned sources invalidate a read.
CREATE TABLE agent_memory_session_visibility (
 session TEXT PRIMARY KEY REFERENCES session_control(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL
) WITHOUT ROWID;
INSERT INTO agent_memory_session_visibility
 SELECT id,(SELECT revision FROM agent_memory_visibility) FROM session_control
 WHERE (SELECT revision FROM agent_memory_visibility)>0;
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
ALTER TABLE agent_memory_external_epochs ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
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

DROP TRIGGER agent_memory_history_revoke;
DROP TRIGGER agent_memory_hidden_span_revoke;
DROP TRIGGER agent_memory_source_private;
DROP TRIGGER agent_memory_source_retired;
DROP TRIGGER agent_memory_source_removal;
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
