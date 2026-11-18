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

-- A legacy Web, Skill or Shell input projection was validated against its service
-- contract at admission. Its method can share a name with an Agent method.
DROP VIEW agent_memory_read_alias_source;
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

CREATE TEMP TABLE legacy_search_aliases AS
 SELECT s.run,s.name FROM agent_memory_read_alias_source s
 WHERE s.kind='other' AND NOT EXISTS (
   SELECT 1 FROM agent_memory_read_aliases a WHERE a.run=s.run AND a.name=s.name
 );
INSERT INTO agent_memory_read_aliases SELECT run,name,'other' FROM legacy_search_aliases;
DELETE FROM agent_memory_recall_calls AS stored
 WHERE run IN (SELECT run FROM legacy_search_aliases)
   AND NOT EXISTS (SELECT 1 FROM agent_memory_recall_call_source c WHERE c.sequence=stored.sequence);
DROP TABLE temp.legacy_search_aliases;
