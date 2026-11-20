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

-- Index child foreign-key and deletion columns so releasing a removed Session's
-- history never triggers full-table scans under PRAGMA foreign_keys = ON.
CREATE INDEX IF NOT EXISTS agent_artifact_run_bindings_fact ON agent_artifact_run_bindings(fact);
CREATE INDEX IF NOT EXISTS agent_attempt_ids_step_fk ON agent_attempt_ids(step);
CREATE INDEX IF NOT EXISTS agent_catalog_messages_sequence ON agent_catalog_messages(sequence);
CREATE INDEX IF NOT EXISTS agent_cell_notifications_session ON agent_cell_notifications(session);
CREATE INDEX IF NOT EXISTS agent_computer_facts_run ON agent_computer_facts(run);
CREATE INDEX IF NOT EXISTS agent_computer_grants_run ON agent_computer_grants(run);
CREATE INDEX IF NOT EXISTS agent_computer_native_bindings_run ON agent_computer_native_bindings(run);
CREATE INDEX IF NOT EXISTS agent_computer_subjects_run ON agent_computer_subjects(run);
CREATE INDEX IF NOT EXISTS agent_continuation_successors_run ON agent_continuation_successors(run);
CREATE INDEX IF NOT EXISTS agent_diagnostic_coverage_run_revision ON agent_diagnostic_coverage(run, revision);
CREATE INDEX IF NOT EXISTS agent_diagnostic_coverage_sequence ON agent_diagnostic_coverage(sequence);
CREATE INDEX IF NOT EXISTS agent_external_effects_run_revision ON agent_external_effects(run, revision);
CREATE INDEX IF NOT EXISTS agent_external_publication_items_run_revision ON agent_external_publication_items(run, revision);
CREATE INDEX IF NOT EXISTS agent_external_publications_run_revision ON agent_external_publications(run, revision);
CREATE INDEX IF NOT EXISTS agent_external_steering_admitted_fact ON agent_external_steering(admitted_fact);
CREATE INDEX IF NOT EXISTS agent_external_steering_prepared_fact ON agent_external_steering(prepared_fact);
CREATE INDEX IF NOT EXISTS agent_history_content_refs_first_sequence ON agent_history_content_refs(first_sequence);
CREATE INDEX IF NOT EXISTS agent_history_content_refs_run ON agent_history_content_refs(run);
CREATE INDEX IF NOT EXISTS agent_history_queue_requests_session_revision ON agent_history_queue_requests(session, revision);
CREATE INDEX IF NOT EXISTS agent_history_snapshot_adoptions_fact ON agent_history_snapshot_adoptions(fact);
CREATE INDEX IF NOT EXISTS agent_interaction_requests_run ON agent_interaction_requests(run);
CREATE INDEX IF NOT EXISTS agent_model_items_fact_id ON agent_model_items(fact_id);
CREATE INDEX IF NOT EXISTS agent_recall_messages_run ON agent_recall_messages(run);
CREATE INDEX IF NOT EXISTS agent_recall_messages_sequence ON agent_recall_messages(sequence);
CREATE INDEX IF NOT EXISTS agent_request_specs_run ON agent_request_specs(run);
CREATE INDEX IF NOT EXISTS agent_session_history_run_fk ON agent_session_history(run);
