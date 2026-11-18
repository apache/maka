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

-- The returned and accepted records name the same projection within one tool
-- operation. Host acceptance prepends a separate receipt to that projection.
CREATE VIEW agent_memory_return_segments AS
 SELECT h.owner,h.session,h.run,h.tool_use_id,h.fact_id,h.sequence,d.ordinal,
    CASE h.kind WHEN 'tool_result_accepted' THEN d.references_json->>'$[2].digest'
                ELSE d.references_json->>'$[1].digest' END AS content,
    CASE h.kind WHEN 'tool_result_accepted' THEN d.fields_json->>'$[#-1].start'
                ELSE d.fields_json->>'$[0].start' END AS start,
    CASE h.kind WHEN 'tool_result_accepted' THEN d.fields_json->>'$[#-1].end'
                ELSE d.fields_json->>'$[0].end' END AS end
 FROM agent_session_history h
 JOIN agent_recall_messages d ON d.owner=h.owner AND d.session=h.session AND d.sequence=h.sequence AND d.ordinal=0
 WHERE h.kind IN ('tool_result_accepted','local_tool_returned','host_tool_result_recorded');

CREATE VIEW agent_memory_sibling_spans(namespace,fact,ordinal,start,end,session,sequence) AS
 SELECT dest.owner,dest.fact_id,dest.ordinal,
        dest.start + max(hidden.start,src.start) - src.start,
        dest.start + min(hidden.end,src.end) - src.start,dest.session,dest.sequence
 FROM agent_memory_return_segments dest CROSS JOIN agent_memory_return_segments src
 CROSS JOIN agent_memory_hidden_spans hidden
 WHERE src.owner=dest.owner AND src.session=dest.session AND src.run=dest.run
 AND src.tool_use_id=dest.tool_use_id AND src.fact_id<>dest.fact_id AND src.content=dest.content
 AND src.end-src.start=dest.end-dest.start
 AND hidden.namespace=src.owner AND hidden.fact=src.fact_id AND hidden.ordinal=src.ordinal
 AND hidden.start<src.end AND hidden.end>src.start;
