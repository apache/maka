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

ALTER TABLE discovery_pending_actions ADD COLUMN authority_json TEXT;
ALTER TABLE discovery_watches ADD COLUMN authority_json TEXT;
ALTER TABLE discovery_watches ADD COLUMN action_id TEXT;
ALTER TABLE discovery_watches ADD COLUMN next_check_at INTEGER;
ALTER TABLE discovery_watches ADD COLUMN interval_ms INTEGER NOT NULL DEFAULT 60000 CHECK(interval_ms>0);
ALTER TABLE discovery_watches ADD COLUMN followup_at INTEGER;

-- Pre-runner rows have no captured session or connector authority.
UPDATE discovery_watches SET expires_at=min(coalesce(expires_at,updated_at),updated_at);
UPDATE discovery_pending_actions SET status='stale',receipt_json='{"reason":"authorization_unavailable"}'
WHERE status='awaiting_confirm';

CREATE INDEX discovery_watch_due ON discovery_watches(owner,kind,next_check_at) WHERE next_check_at IS NOT NULL;
CREATE INDEX discovery_watch_file ON discovery_watches(owner,target) WHERE kind='file_hash' AND next_check_at IS NOT NULL;
CREATE INDEX discovery_action_watches ON discovery_watches(owner,action_id) WHERE action_id IS NOT NULL;
CREATE INDEX discovery_watch_followups ON discovery_watches(owner,followup_at) WHERE followup_at IS NOT NULL;
CREATE INDEX discovery_action_expiry ON discovery_pending_actions(owner,expires_at) WHERE status='awaiting_confirm';
CREATE INDEX discovery_executing_actions ON discovery_pending_actions(owner,action_id) WHERE status='executing';
CREATE INDEX discovery_open_actions ON discovery_pending_actions(owner,topic_id,action_id) WHERE status!='done';
