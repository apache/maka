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

-- Use the same message identity as executor history rows.
INSERT INTO agent_catalog_messages(owner,session,sequence,message,at,preview)
SELECT r.owner,r.session,f.sequence,
    'executor/'||f.run||'/'||json_extract(b.payload,'$.fact.task')||'/'||
        json_extract(b.payload,'$.fact.output.messageId'),
    f.at,substr(json_extract(b.payload,'$.fact.output.text'),1,160)
FROM agent_runs r
CROSS JOIN agent_facts f ON f.run=r.run
CROSS JOIN contents b ON b.id=f.body_content_id
WHERE r.external IS NOT NULL
  AND json_extract(b.payload,'$.fact.kind')='external_task_observed'
  AND json_extract(b.payload,'$.fact.output.type')='output_delta'
  AND json_extract(b.payload,'$.fact.output.text')<>'';
