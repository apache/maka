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

ALTER TABLE agent_history_snapshot_entries ADD COLUMN fact_kind TEXT;
ALTER TABLE agent_history_snapshot_entries
 ADD COLUMN model_json TEXT CHECK(model_json IS NULL OR json_valid(model_json));

CREATE INDEX agent_history_snapshot_metrics_prepared
 ON agent_history_snapshot_entries(snapshot,sequence DESC,run)
 WHERE kind='fact' AND fact_kind='model_attempt_prepared';
CREATE INDEX agent_history_snapshot_metrics_attempt
 ON agent_history_snapshot_entries(snapshot,run,json_extract(entry_json,'$.attempt'),fact_kind,sequence)
 WHERE kind='fact';
