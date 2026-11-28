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

ALTER TABLE discovery_source_cursors ADD COLUMN parent_uri TEXT;
ALTER TABLE discovery_source_cursors ADD COLUMN burst_times_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE discovery_source_cursors ADD COLUMN probe_at INTEGER;
ALTER TABLE discovery_source_cursors ADD COLUMN probe_created INTEGER NOT NULL DEFAULT 0;
ALTER TABLE discovery_source_cursors ADD COLUMN delta_kind TEXT CHECK(delta_kind IN ('created','modified','directory'));
ALTER TABLE discovery_source_cursors ADD COLUMN delta_at INTEGER;

CREATE INDEX discovery_cursor_probes ON discovery_source_cursors(owner, probe_at) WHERE probe_at IS NOT NULL;
CREATE INDEX discovery_cursor_deltas ON discovery_source_cursors(owner, delta_at DESC) WHERE delta_kind IS NOT NULL;
CREATE INDEX discovery_cursor_pending_children ON discovery_source_cursors(owner, parent_uri, updated_at) WHERE probe_at IS NOT NULL;
CREATE INDEX discovery_cursor_siblings ON discovery_source_cursors(owner, parent_uri) WHERE delta_kind IS NOT NULL;
CREATE INDEX discovery_cursor_cooldowns ON discovery_source_cursors(owner, cooldown_until) WHERE cooldown_until > 0;

-- Rebuild the derived scheduler index from its authoritative plans on the next tick.
UPDATE plugin_data SET value_json=NULL,revision=revision+1
WHERE package_id='maka.agent.scheduler' AND scope_id='profile' AND substr(key,-5)='ready'
  AND json_type(value_json,'$.pending')='array' AND json_type(value_json,'$.due')='object';
