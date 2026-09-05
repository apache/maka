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

/**
 * Stable compatibility handle for subagent work during the child-session migration.
 *
 * New work is addressed by its durable child Session. Historical child AgentRuns
 * remain readable in the parent Session without rewriting their ledgers.
 */
export type SubagentExecutionRef =
  | {
      kind: 'child_session';
      sessionId: string;
      currentRunId?: string;
    }
  | {
      kind: 'legacy_child_run';
      sessionId: string;
      runId: string;
    };
