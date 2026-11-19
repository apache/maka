-- Licensed to the Apache Software Foundation (ASF) under one
-- or more contributor license agreements. See the NOTICE file
-- distributed with this work for additional information
-- regarding copyright ownership. The ASF licenses this file
-- to you under the Apache License, Version 2.0 (the
-- "License"); you may not use this file except in compliance
-- with the License. You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing,
-- software distributed under the License is distributed on an
-- "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
-- KIND, either express or implied. See the License for the
-- specific language governing permissions and limitations
-- under the License.


CREATE TABLE agent_history_snapshot_inventory_pages (
 snapshot TEXT NOT NULL REFERENCES agent_history_snapshots(snapshot) DEFERRABLE INITIALLY DEFERRED,
 first_ordinal INTEGER NOT NULL CHECK(first_ordinal>=0),
 content_id INTEGER NOT NULL REFERENCES contents(id),
 PRIMARY KEY(snapshot,first_ordinal)
) WITHOUT ROWID;
CREATE INDEX agent_history_snapshot_inventory_page_content
 ON agent_history_snapshot_inventory_pages(content_id);

WITH RECURSIVE pages(snapshot,depth,content_id,entries,previous) AS (
 SELECT s.snapshot,0,b.id,json_array_length(b.payload,'$.entries'),json_extract(b.payload,'$.previous.digest')
 FROM agent_history_snapshots s
 JOIN contents m ON m.id=s.manifest_content_id
 LEFT JOIN contents b ON b.content_sha256=json_extract(m.payload,'$.inventory.digest')
 WHERE json_type(m.payload,'$.inventory')='object'
 UNION ALL
 SELECT p.snapshot,p.depth+1,b.id,json_array_length(b.payload,'$.entries'),json_extract(b.payload,'$.previous.digest')
 FROM pages p LEFT JOIN contents b ON b.content_sha256=p.previous
 WHERE p.previous IS NOT NULL
)
INSERT INTO agent_history_snapshot_inventory_pages(snapshot,first_ordinal,content_id)
 SELECT snapshot,coalesce(sum(entries) OVER (
  PARTITION BY snapshot ORDER BY depth ROWS BETWEEN 1 FOLLOWING AND UNBOUNDED FOLLOWING
 ),0),content_id FROM pages;

DELETE FROM agent_history_snapshot_entries WHERE kind='payload';
