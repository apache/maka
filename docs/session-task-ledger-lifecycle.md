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

# Session Task Ledger Lifecycle

This document defines the lifecycle and persistence contract for the task ledger
attached to an interactive session. The ledger tracks model-visible work items
inside a Runtime Host Session; it is not an Eval experiment or cell ledger.

## Scope

Maka has a session-scoped task ledger with `task_create`, `task_update`,
`task_list`, `task_get`, `task-events.jsonl`, `tasks.json`, and turn-tail prompt
injection. The implementation keeps lifecycle validation, event replay, storage
projection, tool access, and recovery classification on one contract.

Non-goals:

- no workflow engine;
- no cron or automation scheduling;
- no project-management editing, dependency graph, drag-and-drop, or bulk
  scheduling UI;
- no replacement for `AgentRun`, `RuntimeEvent`, filesystem, git, test, or tool
  evidence.

Task status is advisory control state. It must not override real filesystem,
git, test, verifier, scorer, or tool evidence.

## Identity and Hierarchy

Every current task has two identifiers:

- `id` is the durable UUID primary key. It is never rewritten.
- `key` is the session-local short reference (`T1`, `T1.1`, and deeper forms)
  used in prompts, tools, and UI.

Read and update operations accept either form. Keys are allocated inside the
per-session serialized write queue. A child stores its parent's UUID in
`parentId`; its short key is allocated under the parent's key. Children cannot
be created under terminal parents, and a parent cannot become `completed`
while any descendant remains non-terminal. A parent/child edge must advance the
short key by exactly one segment (`T1` -> `T1.1`); skipped levels such as a
direct `T1` -> `T1.1.1` edge invalidate the projection and fail closed.

Old `tasks.json` snapshots and JSONL events without `key` or `endedAt` remain
readable. Projection assigns stable keys in first-seen creation-event order
(falling back to timestamps only when event order is unavailable) and derives
missing terminal timestamps from `updatedAt`. The first later mutation appends
compatibility events before the new mutation so the derived fields become
durable without changing UUIDs.

## Task Status

Task statuses are:

- `pending`: declared but not started.
- `in_progress`: actively being worked on.
- `blocked`: cannot continue without external input, dependency, permission, or
  prerequisite repair.
- `completed`: finished with evidence.
- `failed`: attempted and ended unsuccessfully with a reason.
- `cancelled`: intentionally stopped and should not resume automatically.

Allowed transitions:

```text
pending -> in_progress
pending -> cancelled

in_progress -> blocked
in_progress -> completed
in_progress -> failed
in_progress -> cancelled

blocked -> in_progress
blocked -> cancelled
blocked -> failed

failed -> pending
failed -> cancelled

completed -> in_progress   only with explicitReopen: true
cancelled -> pending       only with explicitReopen: true
```

## Evidence

New updates into these states require evidence:

- `blocked` requires `blockedReason`.
- `failed` requires `failureReason`.
- `completed` requires `completionEvidence`.

Evidence is compact text. Later work can replace or supplement it
with first-class run, tool-call, artifact, verifier, or scorer references.

Legacy completed or cancelled tasks that predate this contract may still be
read from `tasks.json`. New updates must satisfy the evidence rules.

## Resume Trust

The source-backed type includes a conservative `resumeTrust` classifier:

- `trusted`: durable evidence is intact.
- `needs_revalidation`: state may still be correct, but related external truth
  should be checked again.
- `stale`: task was active when the session or run was interrupted.
- `repaired`: recovery logic changed the projected state.
- `untrusted`: ledger, references, or state are corrupt or missing.

The type and pure classifier are source-backed. `resumeTrust` is a system
diagnostic and is not injected into the model-visible task ledger until recovery
logic owns the value.

Recovery/read-model classification uses the conservative classifier:

- `in_progress` tasks are `stale`.
- tasks with missing required evidence are `needs_revalidation`.
- corrupt ledgers, invalid projections, or missing references are `untrusted`.
- repaired projections are `repaired`.

## Tool Surface

The model-facing tools are:

- `task_create`
- `task_update`
- `task_list`
- `task_get`

The four ledger tools only mutate/read local session state; they do not dispatch
work themselves. `task_create.tasks[].parent_id`, all task reference inputs,
and `agent_spawn.task_id` accept UUIDs or short keys. `task_list` supports exact
`status`, `include_terminal`, and `include_archived` filters; its no-argument
behavior remains compatible with the original full-list behavior.

`MAKA_TASK_LEDGER_TOOLS=false` disables registration. Legacy
PascalCase aliases are not advertised and require an explicit compatibility
flag in main-process wiring.

### Runtime Host Authority

The non-serving Runtime Host composition opens the interactive Task Ledger
writer under its Storage root owner lease. One per-Session coordinator
implements the Runtime `TaskLedgerStore` port and serves the read-only
`task.ledger.query` Client operation. Reads, mutations, claims, and child
outcomes invoked through that port therefore share the same Session admission
boundary instead of creating a second Task Ledger authority.

The Host binds this port into the real-model task and child-agent tool
composition. Desktop and CLI consume the same Client projection and do not
open an interactive Task Ledger writer.

Client queries return the canonical, sanitized projection in item- and
byte-bounded pages. A content revision pins each traversal; a continuation from
an older projection returns `revision_changed` rather than mixing snapshots
across Host epochs. The authority preserves the existing `task-events.jsonl`,
`tasks.json`, legacy-read, and backfill behavior. Runtime Host is the sole
interactive writer after production activation.

## Child Agent Ownership

`agent_spawn(task_id=...)` resolves the task in the current session and claims
it only after the runtime has allocated the real child turn. The claim sets the
task to `in_progress` and records a `child_agent` owner. Once the child settles,
the owner is enriched with the real run and turn references.

A successful child does not complete the task. The parent agent must verify the
result and supply `completionEvidence`. A failed or cancelled child records the
truthful task outcome; a child waiting for permission leaves the task blocked.
An active task already owned by another child turn cannot be stolen.

## Prompt Budget and Archive

The current-turn task tail is capped at 8,000 characters (approximately 2,000
tokens). It renders short keys rather than UUIDs and prioritizes
`in_progress`, `pending`, and `blocked` branches. Ancestors of included active
tasks are retained so hierarchy remains understandable. Up to three recent
terminal tasks are added when budget permits. When tasks are omitted, the tail
reports the omitted count and points the model to `task_list` / `task_get`.

Terminal tasks receive `endedAt`. They become logically archived after seven
days: storage remains append-only and no task is deleted, while prompt and UI
reads exclude archived terminal tasks. Explicit tool reads may opt back into
them.

Secret redaction, task-ledger tag stripping, evidence validation, and exclusion
of `resumeTrust=untrusted` tasks apply before model-visible rendering.

## Goal Completion Gate

Ordinary interactive turns never trigger an extra model call because tasks are
unfinished. The turn tail is advisory only.

When an autonomous Goal is active, its external evaluator still decides first.
If the evaluator says achieved or impossible, that terminal decision wins. If
the Goal continues and pending or in-progress task keys remain, the continuation
text includes one task reminder per Goal id. Blocked, failed, cancelled, and
completed tasks do not trigger the reminder. The reminder is consumed only
after the final idle check and synchronous turn injection, so a concurrent user
turn cannot spend it without showing it. Later continuations are allowed without
another task-specific reminder. Every injected decision is recorded as a
`task_gate_decided` AgentRun event with the Goal id, decision, and task keys.
When iteration, no-progress, or token caps stop a Goal, the stop event records
the remaining actionable task keys as well.

## Debug and Desktop Read Model

The model-visible task ledger remains compact and omits `resumeTrust`, including
both the turn-tail injection and `task_list` / `task_get` tool results. Debug,
export, and trace/read-model surfaces may include task summaries with
`resumeTrust`, reasons, evidence, and refs.

Desktop reads the same `Task[]` projection through `tasks:list`. Store changes
emit a signal-only `tasks:changed` event; the renderer reloads instead of
merging event payloads into a second projection. Before crossing IPC, every
structured Task DTO is sanitized with the same secret and task-tag redaction
rules used by model-visible text. The chat workspace shows a full-width,
collapsible, read-only task band with the active hierarchy, short keys, status,
owner, reason/evidence summary, and three recent terminal tasks. Session
switches clear the old snapshot and revision guards discard late IPC responses.
The panel provides loading, empty, error, and retry states, but no workflow
editing controls.

This interactive task ledger remains separate from:

- Eval experiments, cells, and attempts;
- Goal state, which owns bounded autonomous continuation;
- ScheduledTask, which owns scheduled execution;
- `AgentRun` / `RuntimeEvent`, which own actual runtime and evidence history.
