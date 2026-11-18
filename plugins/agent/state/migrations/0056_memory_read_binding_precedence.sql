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

DROP VIEW agent_memory_recall_call_source;
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
 WHERE alias.kind='session' OR calls.name IN ('Recall','RecallMore','RecallMaterial','SessionRead')
    OR ((calls.name='Read' OR alias.kind='file') AND (path GLOB 'maka://*' OR path GLOB 'attachment:*' OR path GLOB 'session:*' OR path GLOB 'archive:*'));
UPDATE agent_memory_recall_calls AS stored SET read_path=NULL
 WHERE stored.read_path IS NOT NULL AND EXISTS (
   SELECT 1 FROM agent_memory_recall_call_source current
   WHERE current.sequence=stored.sequence AND current.read_path IS NULL
 );
