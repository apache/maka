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

-- Rebuildable Agent projections only; the original facts and content pins own evidence.
CREATE TABLE agent_external_publications (
 run TEXT PRIMARY KEY REFERENCES agent_run_specs(run),
 publication TEXT NOT NULL UNIQUE, task TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 body TEXT NOT NULL CHECK(json_valid(body)),
 UNIQUE(run,publication),
 FOREIGN KEY(run,revision) REFERENCES agent_facts(run,revision)
);
CREATE TABLE agent_external_publication_items (
 run TEXT NOT NULL, publication TEXT NOT NULL,
 item_index INTEGER NOT NULL CHECK(item_index>=0),
 revision INTEGER NOT NULL CHECK(revision>0),
 retained INTEGER NOT NULL CHECK(retained IN (0,1)),
 body TEXT NOT NULL CHECK(json_valid(body)),
 PRIMARY KEY(run,publication,item_index),
 FOREIGN KEY(run,publication) REFERENCES agent_external_publications(run,publication),
 FOREIGN KEY(run,revision) REFERENCES agent_facts(run,revision)
);
CREATE INDEX agent_external_publication_items_retained ON agent_external_publication_items(run,publication,retained,item_index);
