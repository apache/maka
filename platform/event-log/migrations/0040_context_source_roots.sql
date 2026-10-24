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

-- Fixed-size admitted source progress; scope/cut are outer identity fields.
CREATE TABLE context_source_prefixes (
    kind TEXT NOT NULL,
    owner TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    hash BLOB NOT NULL,
    ordinal INTEGER NOT NULL,
    PRIMARY KEY(kind,owner,sequence)
) WITHOUT ROWID;
CREATE UNIQUE INDEX context_source_ordinals ON context_source_prefixes(kind,owner,ordinal);
-- Retain these immutable references independently of Session deletion so that
-- a descendant never needs its parent's payload or mutable catalog entry.
CREATE TABLE context_source_copies (
    owner TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    through_sequence INTEGER NOT NULL,
    base_high INTEGER,
    base_hash BLOB
) WITHOUT ROWID;
CREATE TABLE context_source_lineages (
    invocation_id TEXT PRIMARY KEY,
    parent_invocation_id TEXT,
    base_sequence INTEGER NOT NULL,
    ancestor_through INTEGER NOT NULL,
    ancestry_hash BLOB NOT NULL,
    opening_sequence INTEGER NOT NULL,
    identity_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX context_run_opening ON event_log(
    json_extract(event_json,'$.invocation.session_id'),
    json_extract(event_json,'$.invocation.run_id'),invocation_id
) WHERE kind='invocation_opened' AND event_json IS NOT NULL;
CREATE TABLE context_archive_records (
    sequence INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    target_sequence INTEGER NOT NULL,
    target_invocation_id TEXT NOT NULL,
    target_event_id TEXT NOT NULL,
    hash BLOB NOT NULL,
    placeholder_json TEXT NOT NULL,
    target_invocation_json TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    is_error INTEGER NOT NULL
);
CREATE UNIQUE INDEX context_archive_target ON context_archive_records(session_id,target_event_id);
CREATE INDEX context_archive_owner_sequence ON context_archive_records(session_id,sequence);
CREATE TABLE context_archive_copy_prefixes (
    owner TEXT NOT NULL,
    target_sequence INTEGER NOT NULL,
    hash BLOB NOT NULL,
    PRIMARY KEY(owner,target_sequence)
) WITHOUT ROWID;
CREATE TRIGGER context_source_append AFTER INSERT ON event_log
WHEN NEW.invocation_id IS NOT NULL AND NEW.event_json IS NOT NULL
BEGIN
    SELECT context_source_record(NEW.sequence,NEW.event_session,NEW.invocation_id,NEW.event_json,NEW.kind);
END;
CREATE TRIGGER context_source_copy AFTER INSERT ON session_history_copies
BEGIN
    INSERT INTO context_source_copies(owner,source,through_sequence)
    VALUES(NEW.session_id,NEW.source_session_id,NEW.through_sequence)
    ON CONFLICT(owner) DO NOTHING;
END;
-- One installation backfill. Subsequent opens read committed progress.
INSERT INTO context_source_copies(owner,source,through_sequence)
SELECT session_id,source_session_id,through_sequence FROM session_history_copies;
SELECT context_source_record(sequence,event_session,invocation_id,event_json,kind)
FROM runtime_events ORDER BY sequence;
SELECT context_source_pin_copy(owner) FROM context_source_copies;
