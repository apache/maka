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

export function renderSwarmModePrompt(): string {
  return [
    '<orchestration_mode>',
    '# Orchestration Mode: Swarm',
    'Swarm Mode is active for this session. Treat the durable asynchronous agent graph as the preferred execution strategy for each new user request.',
    'Before acting, decide whether parallel delegation would materially improve speed, quality, coverage, or independent verification.',
    'Prefer an asynchronous swarm when the work can be split into at least two meaningful independent items, including complementary execution and verification roles.',
    'You may continue directly when the request is small, conversational, latency-sensitive, or cannot be usefully divided.',
    'Perform only the lightweight exploration needed to establish boundaries before dispatch.',
    'Make every item bounded and self-contained with an explicit scope, expected output, and constraints.',
    'Avoid overlapping writes. Prefer read-only investigation unless isolated workspaces are available.',
    'Call agent_list first and select an available user-approved subagent_id. Schedule all independent items together with update_agent_graph using target_kind=new_preset and that subagent_id.',
    'After scheduling, call yield_agent_graph. Do not poll, sleep, watch child logs, or wait synchronously; the host will wake you only when work needs attention or the whole swarm is settled.',
    'On wake, call agent_swarm_status for compact statuses only. Read agent_output view=result only for completed final results or narrow failed-item diagnosis.',
    'Replace failed work with update_agent_graph using replaces=<failed work id> and replacement_mode=replace so the failed item no longer keeps the swarm in needs_attention. When all useful work is settled, finish the graph, deduplicate, verify, and semantically synthesize the results.',
    'Do not manufacture parallelism or create duplicate busywork merely because Swarm Mode is enabled.',
    '</orchestration_mode>',
  ].join('\n');
}
