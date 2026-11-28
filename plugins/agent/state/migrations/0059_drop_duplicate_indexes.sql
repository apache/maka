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

-- Drop exact duplicate and strict-prefix B-tree indexes that are already
-- covered by an existing UNIQUE autoindex or wider index on the same table
-- and leading column order:
-- * agent_recall_message_order -> UNIQUE(owner,session,sequence,ordinal)
-- * agent_recall_scope_runs -> agent_run_specs_diagnostics_cover(owner,session,run,schema_version)
-- * agent_run_specs_history -> agent_run_specs_diagnostics_cover(owner,session,run,schema_version)
-- * agent_interaction_requests_session -> UNIQUE(session,revision)
-- * agent_interaction_outcomes_session -> UNIQUE(session,revision)
-- * agent_continuation_successors_run -> UNIQUE(run)
DROP INDEX IF EXISTS agent_recall_message_order;
DROP INDEX IF EXISTS agent_recall_scope_runs;
DROP INDEX IF EXISTS agent_run_specs_history;
DROP INDEX IF EXISTS agent_interaction_requests_session;
DROP INDEX IF EXISTS agent_interaction_outcomes_session;
DROP INDEX IF EXISTS agent_continuation_successors_run;
