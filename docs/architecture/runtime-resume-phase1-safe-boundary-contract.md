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

# Runtime Resume Phase 1 Safe-Boundary Contract

Phase 1 adds an explicit, fail-closed continuation path on top of the Phase 0
`RuntimeEvent` replay projection. It can create a new Run and Invocation only
when the committed source boundary is complete and the host supplies every
required external safety fact.

Planning and execution remain separate operations. Hosts expose them only when
`MAKA_RUNTIME_SAFE_BOUNDARY_RESUME=1`: desktop provides a **Safe resume** action
on the interrupted-turn banner, CLI/TUI provide `/resume`, and desktop may
automatically continue an eligible interrupted session after its startup repair
pass. With the flag absent, normal turns do not run continuation safety
inspection and preserve the pre-Phase-1 happy path.

## Continuation unit

A continuation never revives an old provider stream, JavaScript stack, Promise,
or operating-system process. It creates fresh execution identity:

```text
source Session / Invocation / Run / Turn
  -> validated committed RuntimeEvent high-water
  -> new Invocation / Run / Turn
  -> continuation-start RuntimeEvent
  -> provider replay without a duplicate user message
```

The new Run records `parentRunId` and `parentTurnId`. Its first canonical event
is a system-owned continuation-start fact referencing:

- source Invocation, Run, and Turn IDs;
- source RuntimeEvent high-water;
- the new execution identity.

The continuation-start event must be durable before the provider is called.

## Planner gates

`RuntimeContinuationPlanner` reads the source AgentRun and RuntimeEvent ledger.
The plan is `continue` only when all of the following are true:

- the source run and RuntimeEvent ledger are readable;
- the run header has exactly one matching, non-partial terminal RuntimeEvent;
- every RuntimeEvent belongs to one source Session, Invocation, Run, and Turn;
- the Phase 0 projection is `safe_replay`;
- every accepted tool call has a committed matching response;
- no permission request remains unresolved;
- no background or child operation is reported as unsettled;
- source and current cwd values match after platform normalization;
- source and current workspace identities match;
- every historical tool required by the boundary is available;
- provider-visible history ends at a user or tool boundary;
- the continuation uses fresh Invocation, Run, and Turn IDs;
- an optional workspace checkpoint has a ref, was restored, and covers the
  same RuntimeEvent high-water.

Any missing or contradictory fact produces a stable `park` reason. Phase 1
does not convert uncertainty into a retry.

## Execution revalidation

Planning is not an execution lease. Immediately before starting the new Run,
the Runtime re-reads durable state and rejects the continuation when:

- another Run is active in the same local Runtime;
- the source run identity, terminal status, cwd, or RuntimeEvent high-water
  changed after planning;
- the source replay projection no longer equals the planned replay context;
- the target Run ID already exists.

The source boundary is also an idempotency claim. A continuation Run persists
`continuationSource` in its header before the provider is called. Repeated
planning parks with `continuation_already_exists`; stale or concurrent plans
are rejected before provider execution. Failure to create this durable claim is
fail-closed.

This is single-process ownership, not distributed fencing. Store uniqueness
remains the final guard against duplicate target Run creation.

## Provider history

Normal turns synthesize one initial user RuntimeEvent and append the current
user message to the provider request. Continuations do neither. The provider
receives the validated committed replay context directly, while system prompt
and current tool configuration are rebuilt normally.

This avoids duplicating the original request and prevents a completed tool call
from being executed merely because a new model turn was created.

## Failure behavior

If continuation-start persistence fails:

1. the provider is not called;
2. no terminal AgentRun header is committed without a terminal RuntimeEvent;
3. the incomplete target Run remains recoverable;
4. existing startup recovery later writes a recovered terminal RuntimeEvent
   and then commits the matching failed run header.

The source ledger is never mutated by continuation execution.

## Current storage boundary

Phase 1 continues to read and write the existing RuntimeEvent and AgentRun
stores. It does not make JSONL transactional across tool effects and events.
Consequently, only boundaries where every tool outcome is already committed
can continue.

SQLite canonical storage, Tool Journal T1/T2 transactions, operation IDs,
reconciliation, and idempotent re-execution remain later phases. Phase 1 adds
no hashing policy, lease, fencing token, or distributed scheduler ownership.

## Host responsibilities

Workspace identity, background-operation settlement, current tool catalog, and
optional checkpoint restoration are trusted host facts in this phase. A host
must not expose continuation execution until it can produce those facts from
authoritative local state. The Runtime still revalidates the durable source
ledger and cwd immediately before execution.

The local inspector canonicalizes the session cwd with `realpath` and records a
filesystem identity derived from device, inode, and canonical path. It also
checks ShellRun and child-run state and rebuilds the current tool catalog. The
plan captures these facts in a safety snapshot and execution revalidates them.

## Host entry points and observability

- desktop interrupted-turn banner action: **Safe resume**;
- desktop main IPC: `sessions:resumeLatest`;
- CLI TUI command: `/resume`;
- desktop startup auto-continuation: enabled only by the same feature flag and
  only after interrupted-run repair;
- structured operational events: `plan_approved`, `plan_parked`,
  `execution_started`, `execution_completed`, and `execution_failed`.

Lifecycle events contain only identities, rejection codes, and error classes;
they do not log prompts, tool arguments, tool results, or secrets. Telemetry is
best-effort and cannot change resume behavior.

## Validation

Linux and macOS are the primary support targets for this contract. Portable
tests use POSIX workspace fixtures and must not depend on a Windows drive
letter or write to a fixed host path. Windows behavior is best-effort unless a
test is explicitly scoped to a Windows-only adapter.

The Phase 1 test surface covers:

- safe and parked planner decisions;
- terminal header/ledger disagreement;
- missing permission decisions and unresolved tool calls;
- workspace, cwd, checkpoint, tool-catalog, and background-operation gates;
- fresh lineage and continuation-start persistence;
- provider replay without a duplicate user message;
- source mutation between planning and execution;
- continuation-start write failure and subsequent startup recovery;
- durable claim creation failure before provider execution;
- repeated, stale, and concurrent continuation claims;
- actual child-process SIGKILL at run-created, continuation-start committed,
  terminal-event committed, and terminal-header committed boundaries;
- desktop IPC/preload/renderer/startup routing contracts;
- CLI `/resume` routing without a duplicate prompt;
- the complete Phase 0 P0-P11 SIGKILL prefix harness (covered by the main unit-test job via package `test:dist`).
