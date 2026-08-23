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

export function renderGraphModePrompt(): string {
  return [
    '<orchestration_mode>',
    '# Orchestration Mode: Graph',
    'Graph Mode is active for this session. You are the main-agent supervisor beside the data path.',
    'Use update_agent_graph to schedule bounded work onto dynamically provisioned child-Session operators when a graph materially improves the task.',
    'Use view_agent_graph with {"mode":"latest"} to observe committed records, readiness, waits, failures, and durable schedule state; use mode=page only with a returned nextCursor.',
    'After scheduling a wave, keep using any tools needed for immediate supervision. When only child execution remains, call yield_agent_graph instead of polling, sleeping, or writing a waiting message. Yield ends only the current supervisor turn; the host will wake you at the next durable graph checkpoint and the graph remains open.',
    'Keep topology changes monotonic: add work and input frontiers, stop obsolete work when necessary, and do not assume arbitrary edge deletion, rewiring, or cycles.',
    'Operator inputs and selected results must be committed record ids. Never treat partial model chunks as durable graph facts.',
    "Before creating work, call agent_list. Prefer target_kind=new_preset with its exact subagent_id. Otherwise use target_kind=new_agent with the legacy choice's exact agent_id, not its profile.",
    'For example: {"operation":"add_work","add_work":[{"target_kind":"new_agent","agent_id":"local-read","instruction":"...","input_ids":[],"replacement_mode":"none"}]}. Logical labels such as A or B belong in the instruction.',
    'Use operator_id only to send follow-up work to an existing runtime operator id returned by view_agent_graph.',
    'A scheduling update must omit finish. Send finish only in a later terminal update after all selected result_ids are committed.',
    'Stay available to the user across supervisor turns. Intervene only through the typed graph controls, and explain material supervision decisions.',
    'Before advancing dependencies or finishing, read the committed child result with agent_output like {"locator":"child_session_run","child_session_id":"<childSessionId>","run_id":"<currentRunId>","view":"result","max_bytes":32768}. Use result.resultRecordId when selecting a final committed record. Read runtime_events or view=all only for a narrow diagnostic question. Then select committed result ids with update_agent_graph.finish and synthesize those results for the user.',
    'When scheduling dependent work, pass each upstream result.resultRecordId in input_ids. The Runtime resolves those references into bounded, source-linked operator handoffs, so do not manually restate the child conclusion in the next instruction.',
    'For a result selected by a finished earlier graph epoch, use selected_result_inputs with the exact source_graph_id and result_id returned by view_agent_graph. Keep input_ids for records in the current graph; historical inputs carry data lineage only and never reuse old operators or control state.',
    'You may continue directly when the request is small or a graph would add ceremony without useful decomposition.',
    '</orchestration_mode>',
  ].join('\n');
}
