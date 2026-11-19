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


DELETE FROM agent_history_content_refs
WHERE (owner,session,run,content_id,first_sequence) IN (
 SELECT r.owner,r.session,a.run,p.content_id,f.sequence
 FROM agent_history_snapshot_adoptions a
 JOIN agent_run_specs r ON r.run=a.run
 JOIN agent_facts f ON f.id=a.fact AND f.run=a.run
 JOIN agent_history_snapshot_pins p ON p.snapshot=a.snapshot
);
DELETE FROM agent_content_pins
WHERE (run,content_id) IN (
 SELECT a.run,p.content_id FROM agent_history_snapshot_adoptions a
 JOIN agent_history_snapshot_pins p ON p.snapshot=a.snapshot
);

CREATE VIEW agent_run_content AS
 SELECT run,content_id FROM agent_content_pins
 UNION ALL
 SELECT a.run,p.content_id
 FROM agent_history_snapshot_adoptions a
 JOIN agent_history_snapshot_pins p ON p.snapshot=a.snapshot
 WHERE NOT EXISTS (
  SELECT 1 FROM agent_content_pins d WHERE d.run=a.run AND d.content_id=p.content_id
 );

CREATE VIEW agent_history_content AS
 SELECT d.owner,d.session,d.run,d.content_id,d.first_sequence,0 AS inherited
 FROM agent_history_content_refs d
 WHERE NOT EXISTS (
  SELECT 1 FROM agent_history_snapshot_adoptions a
  JOIN agent_facts f ON f.id=a.fact AND f.run=a.run
  JOIN agent_history_snapshot_pins p ON p.snapshot=a.snapshot AND p.content_id=d.content_id
  WHERE a.run=d.run AND f.sequence<d.first_sequence
 )
 UNION ALL
 SELECT r.owner,r.session,a.run,p.content_id,f.sequence,1
 FROM agent_run_specs r
 JOIN agent_history_snapshot_adoptions a ON a.run=r.run
 JOIN agent_facts f ON f.id=a.fact AND f.run=a.run
 JOIN agent_history_snapshot_pins p ON p.snapshot=a.snapshot
 WHERE NOT EXISTS (
  SELECT 1 FROM agent_history_content_refs d
  WHERE d.owner=r.owner AND d.session=r.session AND d.run=a.run AND d.content_id=p.content_id
    AND d.first_sequence<=f.sequence
 );
