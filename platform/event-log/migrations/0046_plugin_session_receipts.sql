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

-- Re-key existing canonical receipts once; runtime reads only explicit Session keys.
ALTER TABLE plugin_message_receipts RENAME TO plugin_message_receipts_unscoped;
CREATE TABLE plugin_message_receipts (
    package_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
        CHECK(json_extract(receipt_json, '$.invocation.session_id') IS target_session_id),
    PRIMARY KEY(package_id, scope_id, target_session_id, operation_id)
) WITHOUT ROWID;
INSERT INTO plugin_message_receipts
    SELECT package_id, scope_id, json_extract(receipt_json, '$.invocation.session_id'), operation_id, receipt_json
    FROM plugin_message_receipts_unscoped;
DROP TABLE plugin_message_receipts_unscoped;

ALTER TABLE plugin_execution_receipts RENAME TO plugin_execution_receipts_unscoped;
CREATE TABLE plugin_execution_receipts (
    package_id TEXT NOT NULL,
    scope_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json))
        CHECK(json_extract(receipt_json, '$.invocation.session_id') IS target_session_id),
    PRIMARY KEY(package_id, scope_id, target_session_id, operation_id)
) WITHOUT ROWID;
INSERT INTO plugin_execution_receipts
    SELECT package_id, scope_id, json_extract(receipt_json, '$.invocation.session_id'), operation_id, receipt_json
    FROM plugin_execution_receipts_unscoped;
DROP TABLE plugin_execution_receipts_unscoped;
