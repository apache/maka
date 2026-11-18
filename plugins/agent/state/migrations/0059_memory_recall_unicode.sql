-- Licensed to the Apache Software Foundation (ASF) under one
-- or more contributor license agreements.  See the NOTICE file
-- distributed with this work for additional information
-- regarding copyright ownership.  The ASF licenses this file
-- to you under the Apache License, Version 2.0 (the
-- "License"); you may not use this file except in compliance
-- with the License.  You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing,
-- software distributed under the License is distributed on an
-- "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
-- KIND, either express or implied.  See the License for the
-- specific language governing permissions and limitations
-- under the License.

-- Search tokens use NFC; assertion and evidence offsets address the original bytes.
DROP VIEW agent_memory_recall_current;
CREATE VIEW agent_memory_recall_current AS
 SELECT k.seq, hex(m.namespace)||'x'||hex(m.scope) AS location, maka_nfc(v.body) AS body
 FROM agent_memory_recall_keys k JOIN agent_memories m USING(namespace,scope,id)
 JOIN agent_memory_versions v ON v.namespace=m.namespace AND v.scope=m.scope
 AND v.id=m.id AND v.revision=m.assertion
 WHERE m.state='active' AND v.disposition='current';

UPDATE agent_memory_recall_terms SET body=maka_nfc(body) WHERE body<>maka_nfc(body);
