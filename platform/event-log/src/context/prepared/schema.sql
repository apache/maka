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

-- Host-private working projections. Only live leases and bounded cache slots own roots.
-- Canonical history lives in main; these tables never survive their SQL owner.
PRAGMA prepared_cache.auto_vacuum=INCREMENTAL;
CREATE TABLE prepared_cache.context_prepared_builds (
 id TEXT PRIMARY KEY, cache_key TEXT NOT NULL, selection_json TEXT NOT NULL,
 through_sequence INTEGER NOT NULL, captured_revision INTEGER NOT NULL,
 before_sequence INTEGER NOT NULL, previous_revision INTEGER NOT NULL,
 root TEXT, parent_id TEXT, complete INTEGER NOT NULL DEFAULT 0, discovered INTEGER NOT NULL DEFAULT 0 CHECK(discovered IN (0,1)),
 identity TEXT NOT NULL, retiring INTEGER NOT NULL DEFAULT 0 CHECK(retiring IN (0,1))
) WITHOUT ROWID;
CREATE INDEX prepared_cache.context_prepared_cut ON context_prepared_builds(cache_key,complete,captured_revision DESC,through_sequence DESC);
CREATE TABLE prepared_cache.context_prepared_dirty (
 build_id TEXT NOT NULL, group_sequence INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0, leader_sequence INTEGER, covered INTEGER NOT NULL DEFAULT 0, expanded INTEGER NOT NULL DEFAULT 0,
 content TEXT, cart_left INTEGER, cart_right INTEGER,
 PRIMARY KEY(build_id,group_sequence)
) WITHOUT ROWID;
-- Group membership and pending work must seek the selected cluster rather
-- than scanning every dirty row on each rendered group.
CREATE INDEX prepared_cache.context_prepared_group_members ON context_prepared_dirty(build_id,COALESCE(leader_sequence,group_sequence),group_sequence);
CREATE INDEX prepared_cache.context_prepared_pending ON context_prepared_dirty(build_id,group_sequence) WHERE done=0;
CREATE TABLE prepared_cache.context_prepared_nodes (id TEXT PRIMARY KEY, node_json TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE prepared_cache.context_prepared_groups (id TEXT PRIMARY KEY, group_json TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE prepared_cache.context_prepared_payloads (
 storage_id TEXT PRIMARY KEY, digest TEXT UNIQUE
) WITHOUT ROWID;
-- NULL withdraws a complete body before incremental collection can remove pieces.
CREATE INDEX prepared_cache.context_prepared_payload_retirement ON context_prepared_payloads(storage_id) WHERE digest IS NULL;
CREATE TABLE prepared_cache.context_prepared_chunks (
 storage_id TEXT NOT NULL, piece_index INTEGER NOT NULL, message_index INTEGER NOT NULL,
 item_start INTEGER NOT NULL, item_end INTEGER NOT NULL, metadata_json TEXT, bytes BLOB NOT NULL,
 PRIMARY KEY(storage_id,piece_index)
) WITHOUT ROWID;
CREATE INDEX prepared_cache.context_prepared_wire_seek ON context_prepared_chunks(storage_id,message_index,piece_index);

CREATE TABLE prepared_cache.context_prepared_wire_views (
    id TEXT PRIMARY KEY, build_id TEXT NOT NULL, codec TEXT NOT NULL,
    format_json TEXT NOT NULL, root TEXT, complete INTEGER NOT NULL DEFAULT 0, discovered INTEGER NOT NULL DEFAULT 0 CHECK(discovered IN (0,1)), discovery_root TEXT,
    retiring INTEGER NOT NULL DEFAULT 0 CHECK(retiring IN (0,1))
) WITHOUT ROWID;
CREATE UNIQUE INDEX prepared_cache.context_prepared_wire_identity ON context_prepared_wire_views(build_id,codec,format_json) WHERE retiring=0;
CREATE INDEX prepared_cache.context_prepared_wire_build ON context_prepared_wire_views(build_id,id);

CREATE TABLE prepared_cache.context_prepared_wire_dirty (
 view_id TEXT NOT NULL, group_sequence INTEGER NOT NULL, done INTEGER NOT NULL DEFAULT 0,
 content TEXT, cart_left INTEGER, cart_right INTEGER,
 PRIMARY KEY(view_id,group_sequence)
) WITHOUT ROWID;
CREATE INDEX prepared_cache.context_prepared_wire_pending ON context_prepared_wire_dirty(view_id,group_sequence) WHERE done=0;
CREATE INDEX prepared_cache.context_prepared_metadata_page ON context_prepared_chunks(storage_id,piece_index,message_index) WHERE metadata_json IS NOT NULL;
CREATE INDEX prepared_cache.context_prepared_metadata_seek ON context_prepared_chunks(storage_id,message_index,piece_index) WHERE metadata_json IS NOT NULL;
CREATE TABLE prepared_cache.context_prepared_mcp_ids (
 content_id TEXT NOT NULL, call_id TEXT NOT NULL, message_index INTEGER NOT NULL, group_sequence INTEGER NOT NULL,
 PRIMARY KEY(content_id,call_id,message_index)
) WITHOUT ROWID;
CREATE INDEX prepared_cache.context_prepared_mcp_lookup ON context_prepared_mcp_ids(call_id,group_sequence DESC);

CREATE TABLE prepared_cache.context_prepared_mcp_refs (
 content_id TEXT NOT NULL, call_id TEXT NOT NULL, group_sequence INTEGER NOT NULL,
 PRIMARY KEY(content_id,call_id)
) WITHOUT ROWID;
CREATE INDEX prepared_cache.context_prepared_mcp_reverse ON context_prepared_mcp_refs(call_id,group_sequence);
CREATE INDEX prepared_cache.context_prepared_mcp_boundary ON context_prepared_mcp_refs(group_sequence);

-- Retirement/GC looks only at metadata references, never rendered bodies.
CREATE INDEX prepared_cache.context_prepared_build_owner ON context_prepared_builds(json_extract(selection_json,'$.session'),id);
CREATE INDEX prepared_cache.context_prepared_node_content ON context_prepared_nodes(json_extract(node_json,'$.content'));
CREATE INDEX prepared_cache.context_prepared_group_wire ON context_prepared_groups(json_extract(group_json,'$.wire_id'));

CREATE UNIQUE INDEX prepared_cache.context_prepared_identity ON context_prepared_builds(identity) WHERE retiring=0;
-- Stable slots: selectors, pruning anchors and codecs are replaceable values.
-- A bounded global cache may evict a slot; live requests have independent leases.
CREATE TABLE prepared_cache.context_prepared_heads (
    session_id TEXT PRIMARY KEY, build_id TEXT NOT NULL, wire_view_id TEXT,
    touched INTEGER NOT NULL,
    logical_weight INTEGER NOT NULL DEFAULT 0, wire_weight INTEGER NOT NULL DEFAULT 0,
    weight INTEGER GENERATED ALWAYS AS(logical_weight+wire_weight) STORED
) WITHOUT ROWID;
CREATE INDEX prepared_cache.context_prepared_head_age ON context_prepared_heads(touched,session_id);
CREATE INDEX prepared_cache.context_prepared_head_build ON context_prepared_heads(build_id);
CREATE INDEX prepared_cache.context_prepared_head_wire ON context_prepared_heads(wire_view_id);
CREATE TABLE prepared_cache.context_prepared_retire (
    kind TEXT NOT NULL CHECK(kind IN ('build','wire_view')), id TEXT NOT NULL,
    PRIMARY KEY(kind,id)
) WITHOUT ROWID;

-- Count only strong incoming edges. Zero-reference objects are their own
-- indexed work queue, so collecting one Session never marks another's trees.
CREATE TABLE prepared_cache.context_prepared_refs (
    kind TEXT NOT NULL CHECK(kind IN ('node','group','wire')), id TEXT NOT NULL,
    refs INTEGER NOT NULL CHECK(refs>=0), PRIMARY KEY(kind,id)
) WITHOUT ROWID;
CREATE INDEX prepared_cache.context_prepared_zero_refs ON context_prepared_refs(kind,id) WHERE refs=0;

CREATE TRIGGER prepared_cache.context_prepared_builds_refs_insert AFTER INSERT ON context_prepared_builds
BEGIN
    INSERT INTO context_prepared_refs(kind,id,refs) SELECT 'node', NEW.root, 1 WHERE NEW.root IS NOT NULL ON CONFLICT(kind,id) DO UPDATE SET refs=refs+1;
END;

CREATE TRIGGER prepared_cache.context_prepared_builds_refs_update AFTER UPDATE OF root ON context_prepared_builds
WHEN OLD.root IS NOT NEW.root
BEGIN
    INSERT INTO context_prepared_refs(kind,id,refs) SELECT 'node', NEW.root, 1 WHERE NEW.root IS NOT NULL ON CONFLICT(kind,id) DO UPDATE SET refs=refs+1;
    UPDATE context_prepared_refs SET refs=refs-1 WHERE kind='node' AND id=OLD.root;
END;

CREATE TRIGGER prepared_cache.context_prepared_builds_refs_delete AFTER DELETE ON context_prepared_builds
BEGIN
    UPDATE context_prepared_refs SET refs=refs-1 WHERE kind='node' AND id=OLD.root;
END;

CREATE TRIGGER prepared_cache.context_prepared_wire_views_refs_insert AFTER INSERT ON context_prepared_wire_views
BEGIN
    INSERT INTO context_prepared_refs(kind,id,refs) SELECT 'node', NEW.root, 1 WHERE NEW.root IS NOT NULL ON CONFLICT(kind,id) DO UPDATE SET refs=refs+1;
END;

CREATE TRIGGER prepared_cache.context_prepared_wire_views_refs_update AFTER UPDATE OF root ON context_prepared_wire_views
WHEN OLD.root IS NOT NEW.root
BEGIN
    INSERT INTO context_prepared_refs(kind,id,refs) SELECT 'node', NEW.root, 1 WHERE NEW.root IS NOT NULL ON CONFLICT(kind,id) DO UPDATE SET refs=refs+1;
    UPDATE context_prepared_refs SET refs=refs-1 WHERE kind='node' AND id=OLD.root;
END;

CREATE TRIGGER prepared_cache.context_prepared_wire_views_refs_delete AFTER DELETE ON context_prepared_wire_views
BEGIN
    UPDATE context_prepared_refs SET refs=refs-1 WHERE kind='node' AND id=OLD.root;
END;

CREATE TRIGGER prepared_cache.context_prepared_nodes_refs_insert AFTER INSERT ON context_prepared_nodes
BEGIN
    INSERT INTO context_prepared_refs VALUES('node',NEW.id,0) ON CONFLICT(kind,id) DO NOTHING;
    INSERT INTO context_prepared_refs(kind,id,refs) SELECT 'node', json_extract(NEW.node_json,'$.left'), 1 WHERE json_extract(NEW.node_json,'$.left') IS NOT NULL ON CONFLICT(kind,id) DO UPDATE SET refs=refs+1;
    INSERT INTO context_prepared_refs(kind,id,refs) SELECT 'node', json_extract(NEW.node_json,'$.right'), 1 WHERE json_extract(NEW.node_json,'$.right') IS NOT NULL ON CONFLICT(kind,id) DO UPDATE SET refs=refs+1;
    INSERT INTO context_prepared_refs(kind,id,refs) SELECT 'group', json_extract(NEW.node_json,'$.content'), 1 WHERE json_extract(NEW.node_json,'$.content') IS NOT NULL ON CONFLICT(kind,id) DO UPDATE SET refs=refs+1;
END;
CREATE TRIGGER prepared_cache.context_prepared_nodes_refs_check BEFORE DELETE ON context_prepared_nodes
WHEN COALESCE((SELECT refs FROM context_prepared_refs WHERE kind='node' AND id=OLD.id),0)!=0
BEGIN SELECT RAISE(ABORT,'prepared object still has owners'); END;
CREATE TRIGGER prepared_cache.context_prepared_nodes_refs_delete AFTER DELETE ON context_prepared_nodes
BEGIN
    UPDATE context_prepared_refs SET refs=refs-1 WHERE kind='node' AND id=json_extract(OLD.node_json,'$.left');
    UPDATE context_prepared_refs SET refs=refs-1 WHERE kind='node' AND id=json_extract(OLD.node_json,'$.right');
    UPDATE context_prepared_refs SET refs=refs-1 WHERE kind='group' AND id=json_extract(OLD.node_json,'$.content');
    DELETE FROM context_prepared_refs WHERE kind='node' AND id=OLD.id;
END;

CREATE TRIGGER prepared_cache.context_prepared_groups_refs_insert AFTER INSERT ON context_prepared_groups
BEGIN
    INSERT INTO context_prepared_refs VALUES('group',NEW.id,0) ON CONFLICT(kind,id) DO NOTHING;
    INSERT INTO context_prepared_refs(kind,id,refs) SELECT 'wire', json_extract(NEW.group_json,'$.wire_id'), 1 WHERE json_extract(NEW.group_json,'$.wire_id') IS NOT NULL ON CONFLICT(kind,id) DO UPDATE SET refs=refs+1;
END;
CREATE TRIGGER prepared_cache.context_prepared_groups_refs_check BEFORE DELETE ON context_prepared_groups
WHEN COALESCE((SELECT refs FROM context_prepared_refs WHERE kind='group' AND id=OLD.id),0)!=0
BEGIN SELECT RAISE(ABORT,'prepared object still has owners'); END;
CREATE TRIGGER prepared_cache.context_prepared_groups_refs_delete AFTER DELETE ON context_prepared_groups
BEGIN
    UPDATE context_prepared_refs SET refs=refs-1 WHERE kind='wire' AND id=json_extract(OLD.group_json,'$.wire_id');
    DELETE FROM context_prepared_refs WHERE kind='group' AND id=OLD.id;
END;

-- A head publication uses UPSERT, whose conflict policy overrides trigger OR IGNORE.
-- Explicit key-targeted UPSERT keeps repeated retirement requests idempotent.
CREATE TRIGGER prepared_cache.context_prepared_heads_release_update AFTER UPDATE ON context_prepared_heads
BEGIN
    INSERT INTO context_prepared_retire SELECT 'build',OLD.build_id WHERE OLD.build_id IS NOT NULL AND OLD.build_id IS NOT NEW.build_id ON CONFLICT(kind,id) DO NOTHING;
    INSERT INTO context_prepared_retire SELECT 'wire_view',OLD.wire_view_id WHERE OLD.wire_view_id IS NOT NULL AND OLD.wire_view_id IS NOT NEW.wire_view_id ON CONFLICT(kind,id) DO NOTHING;
END;

CREATE TRIGGER prepared_cache.context_prepared_heads_release_delete AFTER DELETE ON context_prepared_heads
BEGIN
    INSERT INTO context_prepared_retire SELECT 'build',OLD.build_id WHERE OLD.build_id IS NOT NULL ON CONFLICT(kind,id) DO NOTHING;
    INSERT INTO context_prepared_retire SELECT 'wire_view',OLD.wire_view_id WHERE OLD.wire_view_id IS NOT NULL ON CONFLICT(kind,id) DO NOTHING;
END;

-- Each newly composed final node has one generation ownership edge.
CREATE TABLE prepared_cache.context_prepared_generation_nodes (
 kind TEXT NOT NULL, owner_id TEXT NOT NULL, node_id TEXT NOT NULL,
 PRIMARY KEY(kind,owner_id,node_id)
) WITHOUT ROWID;
CREATE TRIGGER prepared_cache.context_prepared_generation_nodes_insert AFTER INSERT ON context_prepared_generation_nodes
BEGIN
 INSERT INTO context_prepared_refs(kind,id,refs) VALUES('node',NEW.node_id,1) ON CONFLICT(kind,id) DO UPDATE SET refs=refs+1;
END;
CREATE TRIGGER prepared_cache.context_prepared_generation_nodes_delete AFTER DELETE ON context_prepared_generation_nodes
BEGIN
 UPDATE context_prepared_refs SET refs=refs-1 WHERE kind='node' AND id=OLD.node_id;
END;
CREATE TRIGGER prepared_cache.context_prepared_dirty_stage_insert AFTER INSERT ON context_prepared_dirty

BEGIN
 INSERT INTO context_prepared_refs(kind,id,refs) SELECT 'group',NEW.content,1 WHERE NEW.content IS NOT NULL ON CONFLICT(kind,id) DO UPDATE SET refs=refs+1;
END;
CREATE TRIGGER prepared_cache.context_prepared_dirty_stage_update AFTER UPDATE OF content ON context_prepared_dirty
WHEN OLD.content IS NOT NEW.content
BEGIN
 INSERT INTO context_prepared_refs(kind,id,refs) SELECT 'group',NEW.content,1 WHERE NEW.content IS NOT NULL ON CONFLICT(kind,id) DO UPDATE SET refs=refs+1;
 UPDATE context_prepared_refs SET refs=refs-1 WHERE kind='group' AND id=OLD.content;
END;
CREATE TRIGGER prepared_cache.context_prepared_dirty_stage_delete AFTER DELETE ON context_prepared_dirty

BEGIN
 UPDATE context_prepared_refs SET refs=refs-1 WHERE kind='group' AND id=OLD.content;
END;
CREATE TRIGGER prepared_cache.context_prepared_wire_dirty_stage_insert AFTER INSERT ON context_prepared_wire_dirty

BEGIN
 INSERT INTO context_prepared_refs(kind,id,refs) SELECT 'group',NEW.content,1 WHERE NEW.content IS NOT NULL ON CONFLICT(kind,id) DO UPDATE SET refs=refs+1;
END;
CREATE TRIGGER prepared_cache.context_prepared_wire_dirty_stage_update AFTER UPDATE OF content ON context_prepared_wire_dirty
WHEN OLD.content IS NOT NEW.content
BEGIN
 INSERT INTO context_prepared_refs(kind,id,refs) SELECT 'group',NEW.content,1 WHERE NEW.content IS NOT NULL ON CONFLICT(kind,id) DO UPDATE SET refs=refs+1;
 UPDATE context_prepared_refs SET refs=refs-1 WHERE kind='group' AND id=OLD.content;
END;
CREATE TRIGGER prepared_cache.context_prepared_wire_dirty_stage_delete AFTER DELETE ON context_prepared_wire_dirty

BEGIN
 UPDATE context_prepared_refs SET refs=refs-1 WHERE kind='group' AND id=OLD.content;
END;
CREATE INDEX prepared_cache.context_prepared_uncovered ON context_prepared_dirty(build_id,group_sequence) WHERE covered=0;
CREATE INDEX prepared_cache.context_prepared_unexpanded ON context_prepared_dirty(build_id,group_sequence) WHERE expanded=0;

-- The previous logical root is needed while discovering codec dependencies.
-- It remains owned even if a cancelled initializer is resumed after its parent
-- build lease has retired, and is released when discovery completes.
CREATE TRIGGER prepared_cache.context_prepared_discovery_root_insert AFTER INSERT ON context_prepared_wire_views
BEGIN
 INSERT INTO context_prepared_refs(kind,id,refs) SELECT 'node',NEW.discovery_root,1 WHERE NEW.discovery_root IS NOT NULL ON CONFLICT(kind,id) DO UPDATE SET refs=refs+1;
END;
CREATE TRIGGER prepared_cache.context_prepared_discovery_root_update AFTER UPDATE OF discovery_root ON context_prepared_wire_views
WHEN OLD.discovery_root IS NOT NEW.discovery_root
BEGIN
 INSERT INTO context_prepared_refs(kind,id,refs) SELECT 'node',NEW.discovery_root,1 WHERE NEW.discovery_root IS NOT NULL ON CONFLICT(kind,id) DO UPDATE SET refs=refs+1;
 UPDATE context_prepared_refs SET refs=refs-1 WHERE kind='node' AND id=OLD.discovery_root;
END;
CREATE TRIGGER prepared_cache.context_prepared_discovery_root_delete AFTER DELETE ON context_prepared_wire_views
BEGIN
 UPDATE context_prepared_refs SET refs=refs-1 WHERE kind='node' AND id=OLD.discovery_root;
END;
