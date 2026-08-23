<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->


# Agent Swarm

Agent Swarm is an orchestration mode, not a tool. When a Session runs in swarm
mode, the main Agent is instructed to prefer the durable asynchronous Agent
Graph whenever a request splits into independent work, and to supervise that
graph asynchronously instead of blocking on it.

There is no `agent_swarm` tool. A synchronous fan-out tool of that name existed
until #2384, which removed it in favour of asynchronous supervision over the
graph. `agent_swarm` survives only as a tool-result kind on historical records.

Swarm adds no execution machinery of its own. There is one scheduler, one
ledger, and one control plane, and they are the graph's:

- items are ordinary child Sessions and their `AgentRun`s, scheduled as graph work;
- durable schedule, admission, and wake state are stored in the SQLite graph
  control plane;
- `agent_swarm_status` is a compact projection over the same graph snapshot —
  its `swarmId` is the `graphId`;
- there is no `SwarmRun`, second event ledger, or background owner.

What the mode does add is supervision policy over that machinery: which tools
are guaranteed, what the Agent is told to do with them, why the mode was
authorized, and when a checkpoint is worth waking the Agent for. Those four are
described below.

For the mechanism underneath, see
[Graph Is a Schedule, Not a Second Runtime](./architecture/agent-graph-stream-scheduling-draft.md).

## Enabling the mode

`/swarm` is parsed by `parseSwarmCommand` in `packages/core/src/swarm-command.ts`:

| Input | Effect |
| --- | --- |
| `/swarm on` | Set the Session orchestration mode to `swarm` |
| `/swarm off` | Set the Session orchestration mode back to `default` |
| `/swarm` or `/swarm status` | Report the current mode |
| `/swarm <task>` | Run one task in swarm mode without changing the Session mode |

`ORCHESTRATION_MODES` is `['default', 'swarm', 'graph']`.

## What the mode changes

Swarm mode is mostly instruction, but not only instruction. Four things follow
from it:

1. **System prompt.** `AiSdkBackend` appends `renderSwarmModePrompt()`.
2. **Guaranteed tools.** The mode forces `agent_list`, `update_agent_graph`,
   `yield_agent_graph`, `agent_swarm_status` and `agent_output` into the turn's
   tool catalog. Graph mode requires the same set plus `view_agent_graph`; swarm
   deliberately omits it, matching the instruction to read compact status rather
   than the whole graph.
3. **Durable authorization.** `agentSwarmAuthorization` is recorded on the
   `AgentRun` header as `session_mode` (the Session is in swarm mode),
   `turn_override` (one `/swarm <task>` turn), or `none`. It records why swarm
   was authorized, not merely that it was.
4. **Wake policy.** Wake *state* is stored by the graph control plane like any
   other graph wake, but the *trigger* is mode-specific:
   `isSwarmCheckpointTransition` wakes the supervisor when the swarm first
   reaches `settled`, or when the set of `blocked` / `failed` / `aborted` /
   `cancelled` items changes.

## What the prompt instructs

`packages/runtime/src/swarm-mode.ts` is the entire feature: one function
returning an `<orchestration_mode>` block. It asks the main Agent to:

1. decide first whether parallel delegation would materially improve speed,
   quality, coverage, or independent verification, and to continue directly when
   the request is small, conversational, latency-sensitive, or indivisible;
2. keep exploration light, and make every item bounded and self-contained with an
   explicit scope, expected output, and constraints;
3. avoid overlapping writes, preferring read-only investigation unless isolated
   workspaces are available;
4. call `agent_list`, then schedule all independent items together with
   `update_agent_graph` using `target_kind=new_preset` and a user-approved
   `subagent_id`;
5. call `yield_agent_graph`, and **not** poll, sleep, watch child logs, or wait
   synchronously — the host wakes the Agent only when work needs attention or the
   whole swarm has settled;
6. on wake, read `agent_swarm_status` for compact statuses, and reach for
   `agent_output view=result` only for completed final results or narrow
   diagnosis of a failed item;
7. replace failed work with `update_agent_graph` using `replaces=<failed work id>`
   and `replacement_mode=replace`, so a failed item stops holding the swarm in
   `needs_attention`;
8. finish the graph once useful work has settled, then deduplicate, verify, and
   semantically synthesize.

The prompt also states the limit explicitly: do not manufacture parallelism or
create duplicate busywork merely because swarm mode is enabled.

## Choosing the execution model

| Need | Prefer | Why |
| --- | --- | --- |
| One small task or tightly coupled reasoning | Main Agent directly | Delegation overhead would exceed the useful parallelism. |
| One specialist result, or the next task depends on the previous one | `agent_spawn` | The dependency is explicit and each result can refine the next prompt. |
| Several independent items with one final synthesis | Swarm mode | The Agent schedules them as graph work and supervises asynchronously. |
| Dynamic dependent Agent work supervised from the root conversation | Agent Graph directly | Same machinery; the graph tools are used without the swarm prompt. |
| Explicit workflow steps, arbitrary workflow resume, or distributed execution | Rive | Workflow state and recovery need a dedicated workflow authority. |

Swarm mode and graph mode differ only in instruction, not in mechanism. Swarm
mode biases the Agent toward fan-out for every new request; graph mode leaves
the decision to the Agent.

## Status projection

`agent_swarm_status` takes no parameters and returns a bounded snapshot
(`packages/runtime/src/agent-swarm-status-tool.ts`):

```ts
interface AgentSwarmStatusResult {
  kind: 'agent_swarm_status';
  swarmId: string;                                   // the graphId
  status: 'running' | 'needs_attention' | 'settled';
  counts: Record<AgentSwarmItemStatus, number>;
  items: AgentSwarmStatusItem[];
}

interface AgentSwarmStatusItem {
  workId: string;
  status: AgentSwarmItemStatus;
  operatorId?: string;
  childSessionId?: string;
  runId?: string;
  failurePhase?: 'schedule' | 'topology' | 'stop' | 'render' | 'dispatch';
  failureReason?: string;
}
```

Item status is one of `queued`, `running`, `blocked`, `completed`, `failed`,
`aborted`, `cancelled`, `stopped`, `superseded`. The terminal set is everything
except `queued`, `running`, and `blocked`.

The three swarm-level values are derived, not stored:

- `running` — work remains and nothing needs the supervisor;
- `needs_attention` — at least one item is `blocked`, `failed`, `aborted`, or `cancelled`;
- `settled` — every item reached a terminal status.

`settled` is a statement about the current items, not about the user's task.
Closing the graph is still the supervisor's explicit `finish` decision.

The result carries identity, not payload: `childSessionId` and `runId` are
references into the authoritative Runtime read path. Child output is read with
`agent_output` only when it is actually needed, which is what keeps a large
fan-out from consuming the main Agent's context.

## Example

```text
User:    /swarm on
User:    Review the three packages and report concrete evidence.

Agent:   agent_list
         update_agent_graph  target_kind=new_preset  subagent_id=reviewer  (x3)
         yield_agent_graph

         ... host wakes the Agent ...

Agent:   agent_swarm_status
         -> status=needs_attention, 2 completed, 1 failed
         agent_output view=result   (failed item only)
         update_agent_graph  replaces=<failed work id>  replacement_mode=replace
         yield_agent_graph

         ... host wakes the Agent ...

Agent:   agent_swarm_status
         -> status=settled, 3 completed
         agent_output view=result   (each completed item)
         finish, deduplicate, verify, synthesize
```
