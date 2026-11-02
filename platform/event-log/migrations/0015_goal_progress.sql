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

UPDATE plugin_data
SET value_json = json_set(
    json_remove(value_json, '$.arm.maxIterations', '$.lastOperationId'),
    '$.status', CASE json_extract(value_json, '$.status')
        WHEN 'active' THEN CASE json_extract(value_json, '$.report.status')
            WHEN 'achieved' THEN 'achieved'
            WHEN 'waiting' THEN 'blocked'
            WHEN 'impossible' THEN 'blocked'
            ELSE 'active' END
        WHEN 'max_iterations' THEN 'paused'
        WHEN 'budget_unknown' THEN 'paused'
        WHEN 'waiting' THEN 'blocked'
        WHEN 'impossible' THEN 'blocked'
        WHEN 'cancellation_unknown' THEN 'cancelled'
        ELSE json_extract(value_json, '$.status') END,
    '$.note', CASE WHEN json_extract(value_json, '$.status') = 'active'
        THEN coalesce(json_extract(value_json, '$.report.note'), json_extract(value_json, '$.note'))
        ELSE json_extract(value_json, '$.note') END,
    '$.createdAt', CAST(unixepoch('subsec') * 1000 AS INTEGER),
    '$.updatedAt', CAST(unixepoch('subsec') * 1000 AS INTEGER),
    '$.activeSince', CASE WHEN json_extract(value_json, '$.status') = 'active'
        AND coalesce(json_extract(value_json, '$.report.status'), 'progress') = 'progress'
        THEN CAST(unixepoch('subsec') * 1000 AS INTEGER) ELSE NULL END,
    '$.elapsedMs', 0,
    '$.retryAt', NULL,
    '$.pending', json(CASE WHEN json_type(value_json, '$.pending') = 'object'
        THEN json_set(json_extract(value_json, '$.pending'), '$.kind', 'dispatch')
        ELSE 'null' END),
    '$.report', json(CASE WHEN json_type(value_json, '$.report') = 'object'
        THEN json_set(json_extract(value_json, '$.report'), '$.status',
            CASE json_extract(value_json, '$.report.status')
                WHEN 'waiting' THEN 'blocked'
                WHEN 'impossible' THEN 'blocked'
                ELSE json_extract(value_json, '$.report.status') END)
        ELSE 'null' END)
), revision = revision + 1
WHERE package_id = 'maka.agent.goal'
    AND key LIKE 'session/%'
    AND json_type(value_json, '$.arm.maxIterations') = 'integer';
