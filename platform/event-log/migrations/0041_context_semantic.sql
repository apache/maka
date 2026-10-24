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

-- Rebuildable, write-time semantic history. Row metadata has immutable MVCC
-- revisions; payload pieces are shared by copied Sessions and frozen views.
CREATE TABLE context_semantic_heads (
    session_id TEXT PRIMARY KEY,
    through_sequence INTEGER NOT NULL,
    unavailable_at INTEGER,
    unavailable_reason TEXT
) WITHOUT ROWID;
CREATE TABLE context_semantic_frontiers (
    invocation_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    through_sequence INTEGER NOT NULL,
    frontier_json TEXT NOT NULL
) WITHOUT ROWID;
CREATE INDEX context_semantic_frontier_session ON context_semantic_frontiers(session_id,invocation_id);
CREATE TABLE context_semantic_copies (
    session_id TEXT PRIMARY KEY
) WITHOUT ROWID;
CREATE TABLE context_semantic_rows (
    owner_session_id TEXT NOT NULL,
    source_sequence INTEGER NOT NULL,
    source_index INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    order_sequence INTEGER NOT NULL,
    order_index INTEGER NOT NULL,
    invocation_id TEXT NOT NULL,
    revision_invocation TEXT NOT NULL,
    event_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    archived INTEGER NOT NULL,
    inherited INTEGER NOT NULL,
    visible INTEGER NOT NULL,
    unknown_only INTEGER NOT NULL,
    row_json TEXT NOT NULL,
    PRIMARY KEY(owner_session_id,source_sequence,source_index,revision)
) WITHOUT ROWID;
CREATE INDEX context_semantic_row_order ON context_semantic_rows(owner_session_id,order_sequence,order_index,source_sequence,source_index,revision);
CREATE INDEX context_semantic_row_revision ON context_semantic_rows(owner_session_id,revision,order_sequence);
CREATE INDEX context_semantic_row_event ON context_semantic_rows(owner_session_id,event_id,revision);
CREATE INDEX context_semantic_invocation_rows ON context_semantic_rows(owner_session_id,invocation_id,kind,source_sequence,source_index,revision);
CREATE INDEX context_semantic_unknown_rows ON context_semantic_rows(owner_session_id,unknown_only,source_sequence,order_sequence) WHERE unknown_only=1;
CREATE INDEX context_semantic_notifications ON context_semantic_rows(owner_session_id,invocation_id,source_sequence,source_index,revision) WHERE kind='notification';
CREATE TABLE context_semantic_fragments (
    source_sequence INTEGER NOT NULL,
    source_index INTEGER NOT NULL,
    part_sequence INTEGER NOT NULL,
    part_index INTEGER NOT NULL,
    PRIMARY KEY(source_sequence,source_index)
) WITHOUT ROWID;
CREATE INDEX context_semantic_part_fragments ON context_semantic_fragments(part_sequence,part_index,source_sequence,source_index);
CREATE TABLE context_semantic_fragment_pieces (
    source_sequence INTEGER NOT NULL,
    source_index INTEGER NOT NULL,
    piece_index INTEGER NOT NULL,
    bytes BLOB NOT NULL,
    PRIMARY KEY(source_sequence,source_index,piece_index)
) WITHOUT ROWID;
CREATE TABLE context_semantic_cuts (
    owner_session_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    cut_sequence INTEGER NOT NULL,
    cut_index INTEGER NOT NULL,
    PRIMARY KEY(owner_session_id,invocation_id,revision)
) WITHOUT ROWID;
CREATE INDEX context_semantic_cut_revision ON context_semantic_cuts(owner_session_id,revision);
CREATE TABLE context_semantic_checkpoints (
    session_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    event_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    checkpoint_json TEXT NOT NULL,
    PRIMARY KEY(session_id,sequence)
) WITHOUT ROWID;
CREATE TABLE context_semantic_changes (
    change_id INTEGER PRIMARY KEY,
    owner_session_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    source_sequence INTEGER NOT NULL,
    source_index INTEGER NOT NULL,
    order_sequence INTEGER NOT NULL,
    order_index INTEGER NOT NULL,
    invocation_id TEXT NOT NULL,
    revision_invocation TEXT NOT NULL,
    archived INTEGER NOT NULL,
    inherited INTEGER NOT NULL,
    deleted INTEGER NOT NULL
);
CREATE INDEX context_semantic_change_revision ON context_semantic_changes(owner_session_id,revision,change_id);

CREATE TRIGGER context_semantic_append AFTER INSERT ON event_log
WHEN NEW.invocation_id IS NOT NULL AND NEW.event_json IS NOT NULL
BEGIN
    SELECT context_semantic_record(NEW.sequence,NEW.event_json);
END;
CREATE TRIGGER context_semantic_copy_member AFTER INSERT ON session_history_members
BEGIN
    SELECT context_semantic_copy(NEW.session_id,NEW.sequence,NEW.archive_sequence);
END;

-- One installation derivation. Ordinary startup only loads committed heads.
SELECT context_semantic_record(sequence,event_json) FROM runtime_events ORDER BY sequence;
SELECT context_semantic_copy(session_id,sequence,archive_sequence)
FROM session_history_members ORDER BY sequence,session_id;
