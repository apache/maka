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

ALTER TABLE discovery_preferences ADD COLUMN broad_cycle INTEGER NOT NULL DEFAULT 0 CHECK(broad_cycle BETWEEN 0 AND 3);

-- Pre-staging attachments have no verified file digest.
UPDATE discovery_dossiers SET artifacts_json=(
    SELECT json_group_array(json_insert(value,'$.sha256',NULL) ORDER BY key)
    FROM json_each(artifacts_json)
) WHERE json_array_length(artifacts_json)>0;

-- Already frozen openings keep their FollowUp semantics across the upgrade.
UPDATE plugin_data SET value_json=json_insert(value_json,'$.mode','follow_up'), revision=revision+1
WHERE package_id='maka.agent.scheduler' AND scope_id='profile' AND substr(key,-16)='discovery/active'
  AND value_json IS NOT NULL AND json_extract(value_json,'$.input.text')!='';
