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

-- Keep the sparse set of restricted conversation evidence indexed by Run.
-- Cell observations can depend on earlier events or on fields shared with
-- later receipts. The observation cutoff applies to the derived cell event.
-- Match the TEXT and INTEGER affinities of the history join keys so SQLite
-- can seek the full expression index when the lookup value comes from a row.
DROP INDEX agent_memory_evidence_address;
CREATE INDEX agent_memory_evidence_address ON agent_memory_evidence(namespace,
 CAST(json_extract(source,'$.reference.factId') AS TEXT),CAST(json_extract(source,'$.reference.itemIndex') AS INTEGER));
DROP VIEW agent_memory_hidden_spans;
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

CREATE TABLE agent_memory_run_restrictions(
 evidence INTEGER PRIMARY KEY REFERENCES agent_memory_evidence(sequence) ON DELETE CASCADE,
 run TEXT NOT NULL, source INTEGER NOT NULL REFERENCES agent_session_history(sequence) ON DELETE CASCADE
);
CREATE INDEX agent_memory_run_restriction_lookup ON agent_memory_run_restrictions(run,source);
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

DROP VIEW agent_memory_recall_outputs;
CREATE VIEW agent_memory_recall_outputs(owner,fact) AS
 SELECT h.owner,h.fact_id FROM agent_session_history h WHERE
 ((h.result_source=1 OR h.kind IN ('cell','operation_observed','external_task_observed','model_observed'))
  AND EXISTS(SELECT 1 FROM agent_memory_recall_calls k
      WHERE k.run=h.run AND k.tool_use_id=h.tool_use_id AND k.sequence<h.sequence
        AND (k.read_path IS NULL OR maka_reads_history_resource(k.read_path))))
 OR (h.kind='cell' AND h.tool_use_id IS NULL AND EXISTS(
     SELECT 1 FROM agent_memory_cell_events e JOIN agent_memory_recall_calls k ON k.run=h.run AND k.cell=e.cell
     WHERE e.sequence=h.sequence AND k.sequence<h.sequence
       AND (k.read_path IS NULL OR maka_reads_history_resource(k.read_path))))
 OR EXISTS(SELECT 1 FROM agent_memory_cell_observations obs WHERE obs.sequence=h.sequence AND (
     EXISTS(SELECT 1 FROM agent_memory_recall_calls k
       WHERE k.cell=obs.cell AND k.sequence<obs.through_sequence
         AND (k.read_path IS NULL OR maka_reads_history_resource(k.read_path)))
     OR EXISTS(
       SELECT 1 FROM agent_memory_run_restrictions er
       CROSS JOIN agent_session_history src ON src.sequence=er.source
       CROSS JOIN agent_memory_evidence ev ON ev.sequence=er.evidence
       -- Wait/acceptance can run outside the observed cell's owning Run.
       WHERE er.run=CASE WHEN h.kind='cell' THEN h.run ELSE (
         SELECT origin.run FROM agent_memory_cell_events first_event
         CROSS JOIN agent_session_history origin ON origin.sequence=first_event.sequence
         WHERE first_event.cell=obs.cell AND first_event.sequence<=obs.through_sequence
         ORDER BY first_event.sequence LIMIT 1) END
       AND (
         EXISTS(SELECT 1 FROM agent_memory_cell_events e WHERE e.sequence=src.sequence
           AND e.cell=obs.cell AND e.sequence<=obs.through_sequence)
         OR EXISTS(SELECT 1 FROM agent_memory_shared_fields a
           CROSS JOIN agent_memory_shared_fields d ON d.run=a.run AND d.tool=a.tool
           CROSS JOIN agent_recall_messages message ON message.id=d.message
           CROSS JOIN agent_memory_cell_events e ON e.sequence=message.sequence
           WHERE a.fact=src.fact_id AND e.cell=obs.cell AND e.sequence<=obs.through_sequence
             AND (a.fact,a.start)<>(d.fact,d.start) AND ev.source->>'$.reference.itemIndex'=0
             AND ev.source->>'$.reference.start'<a.end AND ev.source->>'$.reference.end'>a.start)
         OR EXISTS(SELECT 1 FROM agent_session_history dest CROSS JOIN agent_memory_cell_events e ON e.sequence=dest.sequence
           WHERE dest.owner=src.owner AND dest.session=src.session AND dest.run=src.run AND dest.tool_use_id=src.tool_use_id
             AND e.cell=obs.cell AND e.sequence<=obs.through_sequence
             AND EXISTS(SELECT 1 FROM agent_memory_sibling_spans span WHERE span.namespace=h.owner AND span.fact=dest.fact_id))
       )
     )
 ));
