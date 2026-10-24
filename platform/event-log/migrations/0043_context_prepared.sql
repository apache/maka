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

-- Immutable prepared projections. Roots retain old cuts across process restarts;
-- only dirty semantic groups create payloads and persistent treap paths.
CREATE TABLE context_prepared_builds (
 id TEXT PRIMARY KEY, cache_key TEXT NOT NULL, selection_json TEXT NOT NULL,
 through_sequence INTEGER NOT NULL, captured_revision INTEGER NOT NULL,
 before_sequence INTEGER NOT NULL, previous_revision INTEGER NOT NULL,
 root TEXT, parent_id TEXT, complete INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
CREATE INDEX context_prepared_cut ON context_prepared_builds(cache_key,complete,captured_revision DESC,through_sequence DESC);
CREATE TABLE context_prepared_dirty (
 build_id TEXT NOT NULL, group_sequence INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, leader_sequence INTEGER,
 PRIMARY KEY(build_id,group_sequence)
) WITHOUT ROWID;
-- Group membership and pending work must seek the selected cluster rather
-- than scanning every dirty row on each rendered group.
CREATE INDEX context_prepared_group_members ON context_prepared_dirty(build_id,COALESCE(leader_sequence,group_sequence),group_sequence);
CREATE INDEX context_prepared_pending ON context_prepared_dirty(build_id,group_sequence) WHERE done=0;
CREATE TABLE context_prepared_nodes (id TEXT PRIMARY KEY, node_json TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE context_prepared_groups (id TEXT PRIMARY KEY, group_json TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE context_prepared_chunks (
 wire_id TEXT NOT NULL, piece_index INTEGER NOT NULL, message_index INTEGER NOT NULL,
 item_start INTEGER NOT NULL, item_end INTEGER NOT NULL, metadata_json TEXT, bytes BLOB NOT NULL,
 PRIMARY KEY(wire_id,piece_index)
) WITHOUT ROWID;
CREATE INDEX context_prepared_wire_seek ON context_prepared_chunks(wire_id,message_index,piece_index);

CREATE TABLE context_prepared_wire_views (
 id TEXT PRIMARY KEY, build_id TEXT NOT NULL, codec TEXT NOT NULL, format_json TEXT NOT NULL, root TEXT,
 complete INTEGER NOT NULL DEFAULT 0, UNIQUE(build_id,codec,format_json)
) WITHOUT ROWID;
CREATE TABLE context_prepared_wire_dirty (
 view_id TEXT NOT NULL, group_sequence INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(view_id,group_sequence)
) WITHOUT ROWID;
CREATE INDEX context_prepared_wire_pending ON context_prepared_wire_dirty(view_id,group_sequence) WHERE done=0;
CREATE INDEX context_prepared_metadata_page ON context_prepared_chunks(wire_id,piece_index,message_index) WHERE metadata_json IS NOT NULL;
CREATE INDEX context_prepared_metadata_seek ON context_prepared_chunks(wire_id,message_index,piece_index) WHERE metadata_json IS NOT NULL;
CREATE TABLE context_prepared_wire_groups (
 content_id TEXT NOT NULL, codec TEXT NOT NULL, format_json TEXT NOT NULL, context_key TEXT NOT NULL, wire_id TEXT NOT NULL,
 PRIMARY KEY(content_id,codec,format_json,context_key)
) WITHOUT ROWID;

CREATE TABLE context_prepared_mcp_ids (
 content_id TEXT NOT NULL, call_id TEXT NOT NULL, message_index INTEGER NOT NULL, group_sequence INTEGER NOT NULL,
 PRIMARY KEY(content_id,call_id,message_index)
) WITHOUT ROWID;
CREATE INDEX context_prepared_mcp_lookup ON context_prepared_mcp_ids(call_id,group_sequence DESC);

CREATE TABLE context_prepared_mcp_refs (
 content_id TEXT NOT NULL, call_id TEXT NOT NULL, group_sequence INTEGER NOT NULL,
 PRIMARY KEY(content_id,call_id)
) WITHOUT ROWID;
CREATE INDEX context_prepared_mcp_reverse ON context_prepared_mcp_refs(call_id,group_sequence);
CREATE INDEX context_prepared_mcp_boundary ON context_prepared_mcp_refs(group_sequence);

-- Retirement/GC looks only at metadata references, never rendered bodies.
CREATE INDEX context_prepared_build_owner ON context_prepared_builds(json_extract(selection_json,'$.session'),id);
CREATE INDEX context_prepared_node_content ON context_prepared_nodes(json_extract(node_json,'$.content'));
CREATE INDEX context_prepared_group_wire ON context_prepared_groups(json_extract(group_json,'$.wire_id'));
CREATE INDEX context_prepared_cached_wire ON context_prepared_wire_groups(wire_id);
CREATE TABLE context_prepared_orphan_wires (wire_id TEXT PRIMARY KEY) WITHOUT ROWID;
