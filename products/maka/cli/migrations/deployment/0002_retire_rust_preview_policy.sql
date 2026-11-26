/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

-- Retire the removed rust-preview npm channel by resetting persisted
-- rust_preview policies to manual so deployments migrate cleanly to v2.
UPDATE deployment_update_policy
SET configuration = json_set(
    configuration,
    '$.policy', 'manual',
    '$.nextCheckMs', 0,
    '$.lastError', NULL
)
WHERE singleton = 1
  AND json_extract(configuration, '$.policy') = 'rust_preview';

PRAGMA user_version = 2;
