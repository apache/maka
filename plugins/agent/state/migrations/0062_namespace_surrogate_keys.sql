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

-- Intern repeated (owner, session) namespace strings once and replace them with
-- integer surrogate keys on agent_session_history, agent_recall_messages, and
-- agent_usage_calls in namespace::migrate_namespace_surrogate_keys.
CREATE TABLE agent_namespaces (
    id INTEGER PRIMARY KEY,
    owner TEXT NOT NULL,
    session TEXT NOT NULL,
    UNIQUE(owner, session)
);
CREATE INDEX agent_namespaces_session ON agent_namespaces(session);
