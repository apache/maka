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

ALTER TABLE agent_session_history ADD COLUMN historical INTEGER NOT NULL DEFAULT 0 CHECK(historical IN(0,1) AND (historical=0 OR kind='run_admitted'));
ALTER TABLE agent_history_snapshot_entries ADD COLUMN historical INTEGER NOT NULL DEFAULT 0 CHECK(historical IN(0,1) AND (historical=0 OR kind='run'));
UPDATE agent_session_history AS h SET historical=(SELECT CASE WHEN s.schema_version=1 AND json_extract(CAST(b.payload AS TEXT),'$.schemaVersion')=1 AND json_extract(CAST(b.payload AS TEXT),'$.backend.kind') IN('historical','model','executor') THEN json_extract(CAST(b.payload AS TEXT),'$.backend.kind')='historical' ELSE 2 END FROM agent_run_specs s JOIN contents b ON b.id=s.spec_content_id WHERE s.run=h.run) WHERE h.kind='run_admitted';
UPDATE agent_history_snapshot_entries AS e SET historical=(SELECT CASE WHEN json_extract(CAST(b.payload AS TEXT),'$.schemaVersion')=1 AND json_extract(CAST(b.payload AS TEXT),'$.backend.kind') IN('historical','model','executor') THEN json_extract(CAST(b.payload AS TEXT),'$.backend.kind')='historical' ELSE 2 END FROM contents b WHERE b.content_sha256=json_extract(e.entry_json,'$.spec.digest') AND length(b.payload)=json_extract(e.entry_json,'$.spec.bytes')) WHERE e.kind='run';
CREATE INDEX agent_session_history_historical ON agent_session_history(owner,session,sequence DESC) WHERE historical=1;
CREATE INDEX agent_history_snapshot_historical ON agent_history_snapshot_entries(snapshot,sequence DESC) WHERE historical=1;
CREATE INDEX agent_run_specs_diagnostics_cover ON agent_run_specs(owner,session,run,schema_version);
CREATE INDEX agent_facts_diagnostics_tail ON agent_facts(run,revision DESC,sequence,schema_version);
CREATE INDEX agent_session_history_prepared ON agent_session_history(run,sequence DESC,step) WHERE kind='step_prepared';
CREATE INDEX agent_attempt_ids_step ON agent_attempt_ids(run,step);
