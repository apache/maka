---
last_verified: 2026-10-10
---
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

# Runtime Resume Phase 0 Crash Contract

Phase 0 defines replay safety for a fully committed `RuntimeEvent` prefix. It
does not resume execution or reconcile tool side effects. Phase 0 runs against
the canonical SQLite RuntimeEvent store. The SQLite tool journal (T1/T2) that
this contract once described as future work has since landed; the committed
prefix this contract reasons about remains a `RuntimeEvent` prefix.

The production API is pure:

```text
committed RuntimeEvent prefix
  -> ToolOperation projection
  -> ResumePlan
  -> safe_replay or blocked
```

## Stable failpoints

`RUNTIME_RESUME_FAILPOINTS` is the machine-readable source of truth. The
`committedPrefix` column means the last complete RuntimeEvent prefix available
after a crash: the last row committed to `runtime_events`.

| ID | Injection boundary | Last fully committed RuntimeEvent prefix |
|---|---|---|
| P0 | Before tool preparation (T1) | `before_function_call` |
| P1 | Function call committed, prepared journal not committed | `after_function_call` |
| P2 | Prepared journal committed, implementation not started | `after_function_call` |
| P3 | Tool implementation in progress | `after_function_call` |
| P4 | Side effect finished, outcome transaction (T2) not committed | `after_function_call` |
| P5 | Function response committed, outcome journal not committed | `after_function_response` |
| P6 | Outcome committed, result not delivered to the model | `after_function_response` |
| P7 | Result delivered, next provider step not started | `after_function_response` |
| P8 | Terminal RuntimeEvent commit | `after_function_response` |
| P9 | Terminal run-header commit | `after_terminal_event` |
| P10 | Recovery-decision commit | `after_terminal_event` |
| P11 | Continuation-run creation | `after_terminal_event` |

For P8, Phase 0 reasons only about the prefix before the terminal append. The
post-terminal prefix is represented by P9. A torn row in `runtime_events` is
storage corruption, not a legal committed prefix, and must not be upgraded into
a recovery fact.

## Required decisions

| Prefix | Expected result |
|---|---|
| `before_function_call` | `safe_replay`; no tool operation exists |
| `after_function_call` | `blocked`; operation is `indeterminate`; reason is `dangling_tool_state`; unresolved call is absent from provider replay |
| `after_function_response` | `safe_replay`; operation is `succeeded` or `failed`; call and response remain paired in provider replay |
| `after_terminal_event` | Same tool decision as the preceding prefix; the terminal fact remains in the canonical ledger |

An expected RuntimeEvent high-water that differs from the reopened prefix is
always rejected with `runtime_offset_mismatch`.

## Process harness

The Phase 0 crash test must use the real SQLite-backed `RuntimeEventStore`
(`createWorkspaceRuntimeStore`):

1. Create a temporary workspace.
2. Start a child Node.js process.
3. Append the failpoint's complete prefix through `RuntimeEventStore`.
4. Signal the parent only after the append promises resolve.
5. Have the parent terminate the child with `SIGKILL`.
6. Verify a `finally` cleanup marker was not written.
7. Reopen the workspace with a new `RuntimeEventStore` instance.
8. Project the reopened prefix twice and require identical `ResumePlan` values.
9. Verify projection did not mutate the durable ledger.

The harness covers all twelve stable failpoint IDs on Windows, macOS, and
Linux. It tests process-crash recovery, not power-loss durability or filesystem
`fsync` guarantees.

## Phase boundary

Phase 0 changes no tool execution behavior. The following remain out of scope:

- automatic continuation;
- workspace restoration;
- side-effect reconciliation;
- idempotent tool re-execution.

The T1/T2 transactional tool boundaries and the SQLite canonical RuntimeEvent
and tool-journal store were also out of scope when this contract was written;
both have since landed, and Phase 0 now runs against them. Phase 0 only makes
the decision over the evidence currently available deterministic and
fail-closed.
