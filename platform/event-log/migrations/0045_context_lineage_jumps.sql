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

-- Immutable ancestry index. Each opening adds O(log depth) jump pointers;
-- selection tests membership without enumerating the ancestor chain.
CREATE TABLE context_lineage_depths (
 invocation_id TEXT PRIMARY KEY, depth INTEGER NOT NULL CHECK(depth>=0)
) WITHOUT ROWID;
CREATE TABLE context_lineage_jumps (
 invocation_id TEXT NOT NULL, level INTEGER NOT NULL, ancestor_id TEXT NOT NULL,
 PRIMARY KEY(invocation_id,level)
) WITHOUT ROWID;
CREATE TRIGGER context_lineage_index_depth AFTER INSERT ON context_lineage_depths
BEGIN
 INSERT INTO context_lineage_jumps(invocation_id,level,ancestor_id)
 WITH RECURSIVE jumps(level,ancestor_id) AS (
   SELECT 0,parent_invocation_id FROM context_source_lineages
    WHERE invocation_id=NEW.invocation_id AND parent_invocation_id IS NOT NULL
   UNION ALL
   SELECT p.level+1,j.ancestor_id FROM jumps p JOIN context_lineage_jumps j
    ON j.invocation_id=p.ancestor_id AND j.level=p.level
 ) SELECT NEW.invocation_id,level,ancestor_id FROM jumps;
END;
CREATE TRIGGER context_lineage_index_opening AFTER INSERT ON context_source_lineages
BEGIN
 INSERT INTO context_lineage_depths(invocation_id,depth)
 VALUES(NEW.invocation_id,CASE WHEN NEW.parent_invocation_id IS NULL THEN 0
   ELSE (SELECT depth+1 FROM context_lineage_depths WHERE invocation_id=NEW.parent_invocation_id) END);
END;
-- Populate in parent-before-child order; this is O(N log depth), not closure.
INSERT INTO context_lineage_depths(invocation_id,depth)
WITH RECURSIVE depths(invocation_id,depth) AS (
 SELECT invocation_id,0 FROM context_source_lineages WHERE parent_invocation_id IS NULL
 UNION ALL SELECT n.invocation_id,p.depth+1 FROM depths p JOIN context_source_lineages n
 ON n.parent_invocation_id=p.invocation_id
) SELECT invocation_id,depth FROM depths ORDER BY depth;
