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

-- Disposable projections of the original Computer journal, never native capabilities.
CREATE TABLE agent_computer_native_bindings (
 id TEXT PRIMARY KEY REFERENCES agent_computer_facts(id),
 run TEXT NOT NULL REFERENCES agent_run_specs(run),
 source_json TEXT NOT NULL CHECK(json_valid(source_json))
);
CREATE TABLE agent_computer_native_turn_fences (
 run TEXT PRIMARY KEY REFERENCES agent_run_specs(run),
 turn TEXT NOT NULL,
 binding TEXT NOT NULL REFERENCES agent_computer_native_bindings(id)
);
