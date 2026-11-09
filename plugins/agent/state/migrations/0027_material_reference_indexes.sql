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

CREATE INDEX agent_run_spec_content_refs ON agent_run_specs(spec_content_id);
CREATE INDEX agent_request_content_refs ON agent_request_specs(content_id);
CREATE INDEX agent_answer_content_refs ON agent_answer_parts(content_id);
CREATE INDEX agent_fact_body_refs ON agent_facts(body_content_id);
CREATE INDEX agent_queue_body_refs ON agent_queue_events(body_content_id);
CREATE INDEX agent_artifact_registration_body_refs ON agent_session_artifact_registrations(body_content_id);
CREATE INDEX agent_artifact_registration_provenance_refs ON agent_session_artifact_registrations(provenance_content_id) WHERE provenance_content_id IS NOT NULL;
CREATE INDEX agent_artifact_content_refs ON agent_artifacts(content_id);
CREATE INDEX agent_standalone_cell_body_refs ON agent_standalone_cell_events(body_content_id);
CREATE INDEX agent_usage_aux_spec_content_refs ON agent_usage_aux_specs(spec_content_id);
CREATE INDEX agent_usage_aux_body_refs ON agent_usage_aux_events(body_content_id);
CREATE INDEX agent_session_value_content_refs ON agent_session_values(value_content_id);
CREATE INDEX agent_cell_notification_content_refs ON agent_cell_notifications(content_id);
CREATE INDEX agent_snapshot_run_content_refs ON agent_history_snapshot_run_refs(content_id);
CREATE INDEX agent_history_content_reference_lookup ON agent_history_content_refs(content_id);
CREATE INDEX agent_external_steering_content_refs ON agent_external_steering(descriptor_content_id);
CREATE INDEX agent_snapshot_import_manifest_refs ON agent_history_snapshot_imports(manifest_content_id);
