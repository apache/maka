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

-- Derived only from agent_facts; queue ownership remains with agent_queue_events.
CREATE TABLE agent_external_steering (
 run TEXT NOT NULL REFERENCES agent_run_specs(run),
 steering TEXT NOT NULL, task TEXT NOT NULL,
 descriptor_content_id INTEGER NOT NULL REFERENCES contents(id),
 prepared_fact TEXT NOT NULL REFERENCES agent_facts(id),
 admitted_fact TEXT REFERENCES agent_facts(id),
 PRIMARY KEY(run,steering)
);
