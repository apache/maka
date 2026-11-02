-- Licensed to the Apache Software Foundation (ASF) under one
-- or more contributor license agreements. See the NOTICE file
-- distributed with this work for additional information
-- regarding copyright ownership. The ASF licenses this file
-- to you under the Apache License, Version 2.0 (the
-- "License"); you may not use this file except in compliance
-- with the License. You may obtain a copy of the License at
--
-- http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing,
-- software distributed under the License is distributed on an
-- "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
-- KIND, either express or implied. See the License for the
-- specific language governing permissions and limitations
-- under the License.

ALTER TABLE native_approval_checkpoints ADD COLUMN suspension_kind TEXT NOT NULL DEFAULT 'native_approvals' CHECK(suspension_kind IN ('native_approvals','model_retry'));
ALTER TABLE native_approval_checkpoints ADD COLUMN not_before_unix_ms INTEGER;
CREATE INDEX activation_retry_deadline ON native_approval_checkpoints(not_before_unix_ms,id,session_id) WHERE active=1 AND suspension_kind='model_retry';
CREATE INDEX activation_retry_revoked ON native_approval_checkpoints(not_before_unix_ms,id,session_id) WHERE active=1 AND suspension_kind='model_retry' AND revoked=1;
UPDATE native_approval_checkpoints SET checkpoint_json=json_set(checkpoint_json,'$.suspension',json('{"kind":"native_approvals"}'));
