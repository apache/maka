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

-- Immutable source revisions live in Root control. Source existence is checked
-- inside each journal write transaction through the read-only source view.
CREATE TABLE application_operations_partition (
    deployment TEXT NOT NULL,
    namespace TEXT NOT NULL,
    operation TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    outcome_json TEXT NOT NULL CHECK(json_valid(outcome_json)),
    cleanup_json TEXT NOT NULL CHECK(json_valid(cleanup_json)),
    contract_digest TEXT NOT NULL REFERENCES application_operation_contracts(digest),
    PRIMARY KEY(deployment, namespace, operation)
);
INSERT INTO application_operations_partition SELECT deployment,namespace,operation,source_revision,request_json,outcome_json,cleanup_json,contract_digest FROM application_operations;
DROP TABLE application_operations;
ALTER TABLE application_operations_partition RENAME TO application_operations;

CREATE TABLE application_intents_partition (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    deployment TEXT NOT NULL,
    consumer TEXT NOT NULL CHECK(json_valid(consumer)),
    operation TEXT NOT NULL,
    source_revision INTEGER NOT NULL,
    reference_json TEXT NOT NULL CHECK(json_valid(reference_json)),
    recovery_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(recovery_json)),
    UNIQUE(deployment, consumer, operation)
);
INSERT INTO application_intents_partition SELECT cursor,deployment,consumer,operation,source_revision,reference_json,recovery_json FROM application_intents;
-- Preserve issued cursor high water even when the highest rows were removed.
UPDATE sqlite_sequence SET seq=max(seq,coalesce((SELECT seq FROM sqlite_sequence WHERE name='application_intents'),0)) WHERE name='application_intents_partition';
INSERT INTO sqlite_sequence(name,seq) SELECT 'application_intents_partition',seq FROM sqlite_sequence WHERE name='application_intents' AND NOT EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='application_intents_partition');
DROP TABLE application_intents;
ALTER TABLE application_intents_partition RENAME TO application_intents;
CREATE INDEX application_intent_history ON application_intents(deployment, consumer, cursor);
