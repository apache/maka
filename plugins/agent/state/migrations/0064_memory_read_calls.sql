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

-- Decode Read continuations once per immutable call. Only historical calls
-- need to participate in the observation cutoff of future notifications.
DELETE FROM agent_memory_recall_calls
 WHERE read_path IS NOT NULL AND NOT maka_reads_history_resource(read_path);
DROP TRIGGER agent_memory_recall_call_insert;
CREATE TRIGGER agent_memory_recall_call_insert AFTER INSERT ON agent_session_history WHEN NEW.tool_start=1 BEGIN
 INSERT INTO agent_memory_recall_calls SELECT * FROM agent_memory_recall_call_source
 WHERE sequence=NEW.sequence AND (read_path IS NULL OR maka_reads_history_resource(read_path));
END;

-- Bound foreign-key cleanup to the messages removed by a Session index rebuild.
CREATE INDEX agent_memory_shared_fields_message ON agent_memory_shared_fields(message);

DROP VIEW agent_memory_recall_outputs;
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
