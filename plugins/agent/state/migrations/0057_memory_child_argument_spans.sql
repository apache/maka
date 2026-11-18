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

-- Preparation and approval index the same immutable child input after their
-- respective receipt fields. Keep the restriction relative to the arguments.
DROP VIEW agent_memory_return_segments;
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
