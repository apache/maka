-- Licensed to the Apache Software Foundation (ASF) under one
-- or more contributor license agreements. See the NOTICE file
-- distributed with this work for additional information
-- regarding copyright ownership. The ASF licenses this file
-- to you under the Apache License, Version 2.0 (the
-- "License"); you may not use this file except in compliance
-- with the License. You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing,
-- software distributed under the License is distributed on an
-- "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
-- KIND, either express or implied. See the License for the
-- specific language governing permissions and limitations
-- under the License.


CREATE TABLE agent_executor_profile_contents (
 profile_key TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 content_id INTEGER NOT NULL REFERENCES contents(id),
 PRIMARY KEY(profile_key,revision,content_id)
) WITHOUT ROWID;
CREATE INDEX agent_executor_profile_content_owner
 ON agent_executor_profile_contents(content_id);

INSERT INTO agent_executor_profile_contents(profile_key,revision,content_id)
 SELECT p.key,p.revision,m.id FROM plugin_data p
 LEFT JOIN contents m ON m.content_sha256=json_extract(p.value_json,'$.manifest.digest')
   AND length(m.payload)=json_extract(p.value_json,'$.manifest.bytes')
 WHERE p.package_id='maka.agent' AND p.scope_id='profile'
   AND instr(p.key,'executor-profile/')>0 AND p.value_json IS NOT NULL;

INSERT INTO agent_executor_profile_contents(profile_key,revision,content_id)
 SELECT DISTINCT p.profile_key,p.revision,b.id
 FROM agent_executor_profile_contents p
 JOIN contents m ON m.id=p.content_id
 JOIN json_each('['||replace(trim(CAST(m.payload AS TEXT),char(10)),char(10),',')||']') e
 LEFT JOIN contents b ON b.content_sha256=json_extract(e.value,'$.kind.content.digest')
   AND length(b.payload)=json_extract(e.value,'$.kind.content.bytes')
 WHERE json_extract(e.value,'$.kind.kind')='file';

DROP VIEW content_references;
CREATE VIEW content_references AS
    SELECT content_id FROM application_package_files
    UNION ALL SELECT outcome_content_id FROM application_operations WHERE outcome_content_id IS NOT NULL
    UNION ALL SELECT spec_content_id FROM agent_run_specs
    UNION ALL SELECT content_id FROM agent_request_specs
    UNION ALL SELECT content_id FROM agent_answer_parts
    UNION ALL SELECT body_content_id FROM agent_facts
    UNION ALL SELECT content_id FROM agent_content_pins
    UNION ALL SELECT body_content_id FROM agent_queue_events
    UNION ALL SELECT content_id FROM agent_queue_content_pins
    UNION ALL SELECT body_content_id FROM agent_session_artifact_registrations
    UNION ALL SELECT content_id FROM agent_session_artifact_registrations
    UNION ALL SELECT provenance_content_id FROM agent_session_artifact_registrations WHERE provenance_content_id IS NOT NULL
    UNION ALL SELECT content_id FROM agent_artifacts
    UNION ALL SELECT body_content_id FROM agent_standalone_cell_events
    UNION ALL SELECT content_id FROM agent_standalone_cell_pins
    UNION ALL SELECT spec_content_id FROM agent_usage_aux_specs
    UNION ALL SELECT body_content_id FROM agent_usage_aux_events
    UNION ALL SELECT manifest_content_id FROM agent_history_snapshots
    UNION ALL SELECT content_id FROM agent_history_snapshot_pins
    UNION ALL SELECT value_content_id FROM agent_session_values
    UNION ALL SELECT content_id FROM agent_cell_notifications
    UNION ALL SELECT content_id FROM agent_history_snapshot_run_refs
    UNION ALL SELECT content_id FROM agent_history_content_refs
    UNION ALL SELECT descriptor_content_id FROM agent_external_steering
    UNION ALL SELECT manifest_content_id FROM agent_history_snapshot_imports
    UNION ALL SELECT manifest_content_id FROM agent_history_snapshot_ingest_nodes
    UNION ALL SELECT content_id FROM agent_history_snapshot_ingest_frames
    UNION ALL SELECT content_id FROM agent_history_snapshot_inventory_pages
    UNION ALL SELECT content_id FROM agent_executor_profile_contents;

CREATE TRIGGER agent_executor_profile_content_released
 AFTER DELETE ON agent_executor_profile_contents BEGIN
 INSERT OR IGNORE INTO pending_content_releases(content_id) VALUES(old.content_id);
END;
