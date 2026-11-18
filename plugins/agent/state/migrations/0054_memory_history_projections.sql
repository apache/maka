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

-- Provider-hosted tools record the observed output and the accepted output
-- under the same run/attempt/call. The indexed JSON body has the same coordinates.
DROP VIEW agent_memory_sibling_spans;
DROP VIEW agent_memory_return_segments;
CREATE VIEW agent_memory_return_segments AS
 SELECT h.owner,h.session,h.run,h.tool_use_id,h.fact_id,h.sequence,d.ordinal, h.kind,d.body,
    CASE h.kind WHEN 'tool_result_accepted' THEN d.references_json->>'$[2].digest'
                ELSE d.references_json->>'$[1].digest' END AS content,
    CASE h.kind WHEN 'tool_result_accepted' THEN d.fields_json->>'$[#-1].start'
                ELSE d.fields_json->>'$[0].start' END AS start,
    CASE h.kind WHEN 'tool_result_accepted' THEN d.fields_json->>'$[#-1].end'
                ELSE d.fields_json->>'$[0].end' END AS end
 FROM agent_session_history h
 JOIN agent_recall_messages d ON d.owner=h.owner AND d.session=h.session AND d.sequence=h.sequence AND d.ordinal=0
 WHERE h.kind IN ('tool_result_accepted','local_tool_returned','host_tool_result_recorded')
    OR (h.kind='model_observed' AND h.tool_use_id IS NOT NULL AND h.tool_start=0);

CREATE VIEW agent_memory_sibling_spans(namespace,fact,ordinal,start,end,session,sequence) AS
 SELECT dest.owner,dest.fact_id,dest.ordinal,
        dest.start + max(hidden.start,src.start) - src.start,
        dest.start + min(hidden.end,src.end) - src.start,dest.session,dest.sequence
 FROM agent_memory_return_segments dest CROSS JOIN agent_memory_return_segments src
 CROSS JOIN agent_memory_hidden_spans hidden
 WHERE src.owner=dest.owner AND src.session=dest.session AND src.run=dest.run
 AND src.tool_use_id=dest.tool_use_id AND src.fact_id<>dest.fact_id AND (
    src.content=dest.content OR
    ((src.kind='tool_result_accepted' AND dest.kind='model_observed' OR
      dest.kind='tool_result_accepted' AND src.kind='model_observed')
     AND src.content IS NULL AND dest.content IS NULL AND src.body=dest.body))
 AND src.end-src.start=dest.end-dest.start
 AND hidden.namespace=src.owner AND hidden.fact=src.fact_id AND hidden.ordinal=src.ordinal
 AND hidden.start<src.end AND hidden.end>src.start;

-- Retain normalized import metadata once, including snapshots predating this migration.
CREATE TABLE agent_memory_imported_outputs(
 snapshot TEXT NOT NULL REFERENCES agent_history_snapshots(snapshot) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 message INTEGER NOT NULL,part INTEGER NOT NULL,PRIMARY KEY(snapshot,message,part)
) WITHOUT ROWID;
CREATE VIEW agent_memory_imported_output_source AS
 SELECT e.snapshot,e.position AS message,part.key AS part FROM agent_history_snapshot_entries e
 CROSS JOIN contents m ON m.content_sha256=e.entry_json->>'$.message.digest'
 CROSS JOIN json_each(CAST(m.payload AS TEXT),'$.parts') part
 CROSS JOIN contents b ON b.content_sha256=part.value->>'$.digest'
 WHERE e.kind='imported' AND
 CASE json_extract(CAST(b.payload AS TEXT),'$.kind')
 WHEN 'tool_return' THEN json_extract(CAST(b.payload AS TEXT),'$.name')
 WHEN 'model' THEN CASE WHEN json_extract(CAST(b.payload AS TEXT),'$.part.kind')='tool_result'
 THEN json_extract(CAST(b.payload AS TEXT),'$.part.name') END
 END IN ('Recall','RecallMore','RecallMaterial','SessionRead');
INSERT INTO agent_memory_imported_outputs SELECT * FROM agent_memory_imported_output_source;
CREATE TRIGGER agent_memory_imported_output_insert AFTER INSERT ON agent_history_snapshot_entries
 WHEN NEW.kind='imported' BEGIN
 INSERT INTO agent_memory_imported_outputs SELECT * FROM agent_memory_imported_output_source
 WHERE snapshot=NEW.snapshot AND message=NEW.position;
END;
