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

-- Event identity lookup serves tool-result archival, including copied and
-- already archived revisions. Other semantic rows are addressed by position.
DROP INDEX context_semantic_row_event;
CREATE INDEX context_semantic_row_event
    ON context_semantic_rows(owner_session_id, event_id, revision)
    WHERE kind = 'tool_result';

-- Incremental readers use context_semantic_changes. Historical source reads
-- use the source-position primary key; a revision prefix instead scans the
-- owner's history when copying one source.
DROP INDEX context_semantic_row_revision;
