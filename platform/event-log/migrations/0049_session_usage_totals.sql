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

-- Lifetime counters retain the existing exact JSON-integer limit. Limit + 1
-- is an explicit overflow sentinel; settlement itself must still be durable.
CREATE TABLE session_usage_totals (
    session_id TEXT PRIMARY KEY NOT NULL,
    input_known INTEGER NOT NULL CHECK(input_known BETWEEN 0 AND 9007199254740992),
    input_missing INTEGER NOT NULL CHECK(input_missing BETWEEN 0 AND 9007199254740992),
    output_known INTEGER NOT NULL CHECK(output_known BETWEEN 0 AND 9007199254740992),
    output_missing INTEGER NOT NULL CHECK(output_missing BETWEEN 0 AND 9007199254740992)
) STRICT;

-- Only unsettled physical main-model admissions live here. Terminal invocations
-- can drain current work without revisiting all previously completed attempts.
CREATE TABLE session_usage_pending (
    request_id TEXT PRIMARY KEY NOT NULL REFERENCES event_log(event_id),
    invocation_id TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    session_id TEXT NOT NULL
) STRICT;
CREATE INDEX session_usage_pending_invocation ON session_usage_pending(invocation_id, request_id);
CREATE INDEX auxiliary_usage_meter_observation ON event_log(
    json_extract(COALESCE(event_json, retained_json), '$.request_id')
) WHERE kind = 'auxiliary_model_usage';

-- One-time migration. Nonnegative integer sums below the exact limit are exact;
-- sums above it become the explicit sentinel, never rounded reported totals.
INSERT INTO session_usage_totals
SELECT session_id,
    CAST(MIN(TOTAL(json_extract(usage, '$.input_tokens')), 9007199254740992) AS INTEGER),
    MIN(COUNT(*) - COUNT(json_extract(usage, '$.input_tokens')), 9007199254740992),
    CAST(MIN(TOTAL(json_extract(usage, '$.output_tokens')), 9007199254740992) AS INTEGER),
    MIN(COUNT(*) - COUNT(json_extract(usage, '$.output_tokens')), 9007199254740992)
FROM model_usage WHERE completed_sequence IS NOT NULL AND session_id IS NOT NULL
GROUP BY session_id;
INSERT INTO session_usage_pending
SELECT usage.event_id, source.invocation_id, source.operation_id, usage.session_id
FROM agent_model_usage usage JOIN event_log source ON source.event_id=usage.event_id
WHERE usage.completed_sequence IS NULL;
