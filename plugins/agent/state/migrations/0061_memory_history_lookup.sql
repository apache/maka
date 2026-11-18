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

DROP VIEW agent_memory_read_alias_source;
CREATE VIEW agent_memory_read_alias_source AS
 SELECT run,name,kind FROM (
 SELECT r.run,service.value->>'$.selection.name' AS name,CASE WHEN service.value->>'$.selection.target.kind'='export' AND service.value->>'$.selection.target.name'='agent'
 AND service.value->>'$.selection.method' IN ('execution','continuationAvailability') THEN 'session'
 ELSE coalesce(service.value->>'$.history_reader',CASE
 WHEN service.value->>'$.selection.target.kind'='import' AND service.value->>'$.selection.target.name'='files' AND service.value->>'$.selection.method'='read' THEN 'file'
 WHEN service.value->>'$.selection.target.kind'='export' AND service.value->>'$.selection.target.name'='agent' AND service.value->>'$.selection.method' IN
   ('memory','memories','work','sessionRead','history','historyLandmarks','historyPrompt','historyRequests','source','search','toolImage','attachmentImage') THEN 'session'
 WHEN service.value->>'$.selection.name' IN ('Read','SessionRead','Recall','RecallMore','RecallMaterial')
 AND service.value->>'$.selection.method' NOT IN ('read','memory','memories','execution','continuationAvailability','work','sessionRead','history','historyLandmarks','historyPrompt','historyRequests','source','search','toolImage','attachmentImage')
 THEN 'other' END) END AS kind
 FROM agent_run_specs r CROSS JOIN contents spec ON spec.id=r.spec_content_id
 CROSS JOIN contents selection ON selection.content_sha256=json_extract(CAST(spec.payload AS TEXT),'$.toolSelection.digest')
 CROSS JOIN json_each(CAST(selection.payload AS TEXT),'$.services') service)
 WHERE kind IS NOT NULL;
INSERT OR REPLACE INTO agent_memory_read_aliases
 SELECT s.* FROM agent_memory_read_alias_source s LEFT JOIN agent_memory_read_aliases a USING(run,name)
 WHERE a.kind IS NOT s.kind;
INSERT OR REPLACE INTO agent_memory_recall_calls
 SELECT s.* FROM agent_memory_recall_call_source s LEFT JOIN agent_memory_recall_calls k USING(sequence)
 WHERE k.sequence IS NULL OR k.read_path IS NOT s.read_path;

CREATE INDEX agent_memory_run_termination ON agent_session_history(run) WHERE kind='run_terminated';

-- Keep the unique fact lookup on the outside. Each dependency is checked only
-- for the requested history row, including the prefix of its observed cell.
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
     OR EXISTS(SELECT 1 FROM agent_memory_cell_events e JOIN agent_session_history src ON src.sequence=e.sequence
       WHERE e.cell=obs.cell AND e.sequence<=obs.through_sequence AND
         (EXISTS(SELECT 1 FROM agent_memory_hidden_spans s WHERE s.namespace=h.owner AND s.fact=src.fact_id)
          OR EXISTS(SELECT 1 FROM agent_memory_operation_spans s WHERE s.namespace=h.owner AND s.fact=src.fact_id)
          OR EXISTS(SELECT 1 FROM agent_memory_sibling_spans s WHERE s.namespace=h.owner AND s.fact=src.fact_id)))
 ));
