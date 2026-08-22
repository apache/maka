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

Agent Swarm is Maka's bounded foreground fan-out for independent child work. The
main Agent plans the batch, calls `agent_swarm` once, waits for every settled
item, and remains responsible for semantic synthesis.

It is intentionally a structured-concurrency convenience over existing child
`AgentRun`s, not a workflow runtime:

- every started item is an ordinary child `AgentRun`;
- the parent tool result is an ordered projection over those child facts;
- there is no `SwarmRun`, second event ledger, checkpoint, or background owner;
- child toolsets exclude `agent_swarm`, so batches cannot nest.

## Choosing the execution model

| Need | Prefer | Why |
| --- | --- | --- |
| One small task or tightly coupled reasoning | Main Agent directly | Delegation overhead would exceed the useful parallelism. |
| One specialist result, or the next task depends on the previous result | `agent_spawn` sequentially | The dependency is explicit and each result can refine the next prompt. |
| Several finite, independent items with one final synthesis | `agent_swarm` | Bounded worker-pool execution, stable ordered results, and isolated failures. |
| Durable ownership, task claiming, or worker communication | Agent Team | Members have roles, mailbox collaboration, and Task Ledger coordination. |
| Dynamic dependent Agent work supervised from the root conversation | Agent Graph | Child Sessions are operators, committed RuntimeEvents are records, and SQLite owns durable schedule and admission state. |
| Explicit workflow steps, arbitrary workflow resume, or distributed execution | Rive | Workflow state and recovery need a dedicated workflow authority. |

The main Agent should call Swarm deliberately. The runtime does not infer that a
request is parallelizable and does not automatically fan work out.

For the deeper boundary between foreground fan-out and durable dynamic
scheduling, see [Graph Is a Schedule, Not a Second Runtime](./architecture/agent-graph-stream-scheduling-draft.md).

## Contract

One call accepts `1..32` items. Local concurrency defaults to `3` and is capped
at `32`. The entire input is validated before any child starts. Results retain
input order even when children finish out of order.

New work has two mutually exclusive forms. Callers may provide the explicit
structured items shown below, or use a homogeneous template batch with one
shared selector, a `prompt_template` containing `{{item}}`, and string
`items`. Template batches replace every placeholder occurrence, reject
duplicate expanded tasks, generate stable ordered IDs (`item-1`, `item-2`,
...), and then enter the same preflight and execution path as explicit items.
They are input shorthand, not a separate scheduler.

### Configurable subagent model routes

Settings → Models can define multiple user-approved subagent presets. Each
preset has a stable `subagent_id`, a capability `profile`, and its own model
connection/model pair. The main Agent discovers these routes with `agent_list`
and selects one by `subagent_id`; it cannot supply an arbitrary provider or
model in a tool call.

The runtime resolves the id against the host-owned catalog and freezes the
resolved connection, model, thinking level, and profile into the new child
Session. Editing or deleting a preset therefore affects future spawns only;
resume and retry continue to use the child Session's durable target. The
legacy `profile` selector remains supported and inherits the parent target.

For a configured route, replace `profile` with `subagent_id` in either an
explicit item or a template batch:

```ts
agent_swarm({
  prompt_template: "Review {{item}} and return concrete evidence.",
  subagent_id: "fast-reader",
  items: ["runtime", "desktop", "tests"],
  max_concurrency: 3
})
```

Either form may also include `resume_run_ids`, a map from an existing child
`runId` to the new prompt that should continue it. A call may contain only
resumes. Resume entries count toward the same 32-item bound, are presented
before new items in map insertion order, and use the same local and shared
concurrency limits as newly spawned children.

## Resuming child runs

Resume creates a fresh child `AgentRun` whose durable lineage names the source
in `resumedFromRunId`. It replays the complete RuntimeEvent history of that
source and its resume ancestors, then sends the new prompt. It does not mutate
or restart the original run, and it does not approximate continuation by
concatenating a summary into a fresh prompt.

The runtime preflights every resume entry before any resumed or new child
starts. Resume fails closed unless all of these invariants hold:

- the source and every resume ancestor are built-in child runs in this session;
- every run has the same Agent profile and current backend, connection, model,
  working directory, and child permission mode;
- every RuntimeEvent ledger has a valid terminal fact and a user-anchored,
  model-replayable history with no indeterminate tool boundary;
- the immediate source does not already have a resume successor.

Completed, failed, and cancelled child runs may be continued. Each source has
at most one direct successor, while that successor may itself be resumed to
form an auditable linear chain. The API deliberately uses `resume_run_ids`
rather than `resume_agent_ids`: built-in `agentId`s identify reusable profiles
such as `local-read`, while `runId`s identify the unique execution and history
being continued.

```ts
agent_swarm({
  resume_run_ids: {
    "child-run-123": "Re-check the failing assertion and propose the smallest fix.",
    "child-run-456": "Continue from your findings and inspect the UI projection."
  },
  items: [
    {
      item_id: "fresh-review",
      profile: "local_read",
      task: "Independently review the updated cancellation invariant."
    }
  ],
  max_concurrency: 3
})
```

Three separate concurrency boundaries remain observable:

1. **Subagent tool admission** limits how many subagent tool calls the model may
   open in one turn.
2. **Local Swarm concurrency** limits workers claimed inside one batch.
3. **Shared child-run permits** cap real child executions across
   `agent_spawn` and `agent_swarm`.

Partial child failure does not erase successful siblings. Parent cancellation
signals active children, prevents locally queued items from starting, joins
active work, and returns explicit cancelled rows for both started and
never-started items.

## Provider backpressure

Swarm uses Kimi-compatible, batch-local rate-limit handling after the backend's
ordinary request retry policy is exhausted:

- launch up to five initial items, then admit one additional pending item every
  700 ms;
- when a child settles with `failureClass: RateLimit`, suspend that item and
  requeue it at the front with a 3 s, 6 s, 12 s, ... retry delay;
- reduce the batch's effective capacity by one (never below one), at most once
  every 2 s;
- after three minutes without another rate limit, recover capacity one slot at
  a time;
- if the rate-limited item is the only unfinished item, fail it instead of
  leaving the foreground tool suspended indefinitely.

A retry is a fresh child `AgentRun` linked through `retriedFromRunId`. It
replays the safely materialized RuntimeEvent history and sends no second user
prompt. This keeps each attempt inspectable while preventing duplicated task
instructions. Artifacts from all attempts are retained in the final ordered
item result, and parent cancellation still covers queued retries and active
retry runs through the shared child-run permit pool.

This mechanism is deliberately reactive and local to one Swarm call. It is not
a provider-global RPM/TPM admission controller and does not coordinate capacity
between independent sessions or processes.

## Presentation and evidence

Desktop and CLI project the same settled `agent_swarm` result:

- aggregate status and completed/failed/cancelled counts;
- bounded per-item summaries;
- child status, profile, duration, failure class, and artifact count;
- real child `runId` and `turnId` references for inspection.

The presentation never copies child prompts, tool arguments, or raw child tool
output. Desktop summaries are bounded per row, the card is scroll-bounded, and
CLI output has per-item and aggregate character caps.

Tool telemetry stores only a bounded result summary: result kind/status, item
counts, started count, and artifact count. Run trace events reuse the existing
parent `AgentRun` diagnostic stream and identify these boundaries with stable
data fields:

| Evidence | Trace data |
| --- | --- |
| Tool-call admission rejection | `boundary: subagent_tool_admission` |
| Local item queued or started | `swarmStage: item_queued` / `item_started`, `boundary: local_swarm_concurrency` |
| Provider-limited item suspended | `swarmStage: item_suspended`, `failureClass: RateLimit`, plus attempt and retry delay |
| Adaptive batch capacity | `swarmStage: capacity_changed`, direction, and effective capacity |
| Waiting for shared capacity | `boundary: shared_child_run_permit`, `stage: waiting` |
| Real child execution | `boundary: child_run_execution`, `stage: started` / `completed` |
| Settled batch | `swarmStage: batch_completed` plus the aggregate projection |

These are diagnostic projections only. Child `AgentRun`s and their artifact
references remain the lifecycle and evidence authority.

## Example: review fan-out and synthesis

For a cross-cutting change, the main Agent can create independent review items:

```ts
agent_swarm({
  items: [
    {
      item_id: "runtime",
      profile: "local_read",
      task: "Review concurrency and cancellation invariants."
    },
    {
      item_id: "presentation",
      profile: "local_read",
      task: "Review bounded UI and CLI result presentation."
    },
    {
      item_id: "tests",
      profile: "local_read",
      task: "Review regression coverage and identify missing cases."
    }
  ],
  max_concurrency: 3
})
```

The same read-only batch can use Kimi-compatible single-placeholder expansion:

```ts
agent_swarm({
  prompt_template: "Review {{item}} and report concrete file or symbol evidence.",
  profile: "local_read",
  items: ["runtime concurrency and cancellation", "UI and CLI presentation", "regression coverage"],
  max_concurrency: 3
})
```

After the batch settles, the main Agent should compare the three summaries,
inspect referenced child runs when evidence conflicts, deduplicate overlapping
findings, rank them by severity, and produce one coherent review. Swarm owns
finite execution and settlement; the main Agent owns judgment.
