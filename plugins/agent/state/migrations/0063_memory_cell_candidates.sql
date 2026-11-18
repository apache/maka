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

-- Keep only cell events that have a restricted source. A linked receipt is a
-- candidate until its projected field and the source byte range are checked.
DROP INDEX agent_memory_run_restriction_lookup;
CREATE INDEX agent_memory_restrictions_source ON agent_memory_run_restrictions(source);
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
       SELECT 1 FROM agent_memory_cell_candidates c
       JOIN agent_session_history dest ON dest.sequence=c.event
       WHERE c.cell=obs.cell AND c.event<=obs.through_sequence AND (c.direct
         OR EXISTS(SELECT 1 FROM agent_memory_operation_spans s WHERE s.namespace=h.owner AND s.fact=dest.fact_id)
         OR EXISTS(SELECT 1 FROM agent_memory_sibling_spans s WHERE s.namespace=h.owner AND s.fact=dest.fact_id))
     )
 ));
