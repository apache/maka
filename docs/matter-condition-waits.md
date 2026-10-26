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

# Matter condition waits

Matter can wait for a tested, machine-checkable condition as well as an absolute
fallback time. It keeps its own session, settlement review and inbox; no Goal is
created. Time-only waits remain supported by `MatterSettle`.

## Agent workflow

1. Do useful work now. Only wait when immediate continuation cannot help.
2. Call `MatterConditionTest` with either custom JavaScript or a preset. It executes
   against real permitted data and returns `checkerId`, `testedAt` and the result.
   Inspect that result and the evidence: a syntactically valid checker can still
   express the wrong condition. Fix and retest if necessary.
3. Call `MatterSettle` with `disposition: "wait"`,
   `waitingFor`, `condition: {checkerId, intervalMs}`, and an absolute fallback
   time in `wakes`. The existing settlement review must approve this submission.
4. The Host observes without model calls. A match, repeated observation failure,
   or the fallback deadline creates one durable task event. The ordinary Matter
   dispatcher resumes the same session; the Agent reassesses current facts.

Testing does not install a wait. A checker ID binds the task, code and parameters;
another task cannot reuse it. Changing the code or parameters requires another
test. Repeating the same test does not mutate an installed code version.

Example, using an already configured source whose `queryHelp` describes the
following query parameters:

```json
{
  "preset": "source-appeared",
  "input": {
    "source": "supplier.orders",
    "query": {"orderId": "example-order", "status": "shipped"}
  }
}
```

Use the returned checker ID in a normal settlement, for example:

```js
{
  summary: "Shipment is not ready; awaiting confirmation before proceeding.",
  // Optional note retains useful working context. No draft or revision is required.
  disposition: "wait",
  waitingFor: "Supplier confirms this order has shipped",
  condition: {checkerId: "<tested ID>", intervalMs: 60_000},
  wakes: [{kind: "at", at: /* future absolute Unix milliseconds */}]
}
```

The shipped presets are:

- `source-appeared`: a narrowed source query returns at least one object.
- `session-revision`: a permitted session's `historyRevision` differs from the
  supplied baseline. Input: `{source?, id, revision}`.

Custom code is an async JavaScript body, with `input` and `checkpoint` available.
It returns:

```js
return {
  status: "pending", // or "triggered"
  reason: "Still awaiting a confirmed shipment",
  evidence: [],      // optional, at most seven short source references
  checkpoint: {}     // optional, bounded JSON cursor carried to the next check
};
```

The first background check starts with `checkpoint = null`. Successful pending
checks persist their cursor. Errors do not advance it. For history queries, only
advance past records the checker has actually examined.

## Read boundary

Both testing and background observation use Maka's existing isolated Code Mode
executor, with four explicit read capabilities:

| Capability | Arguments and behavior |
| --- | --- |
| `tools.SourceList({})` | Lists installed source IDs, descriptions, query help and scopes. |
| `tools.SourceQuery({source, query})` | Queries metadata and checks current permission for every returned object. Source-specific pagination stays explicit. |
| `tools.SourceRead({source, object})` | Reads a source object with current permission and version checks. Deleted objects retain their deletion status; unavailable versions are errors. |
| `tools.SessionRead({source, id, query})` | Reads permitted history using the existing source/session query service. `source` defaults to `maka`; type selection and pagination use that service's query parameters. |

No shell, Node imports, arbitrary network client, write tools, or model tools are
exposed to checker code. External services need an installed read-only source
adapter. This first version does not add file watching, webhooks or remote-host
checker execution. Existing source adapters determine data freshness; checking a
cached source does not implicitly synchronize it.

The existing executor bounds memory, CPU work, bridge calls and result sizes.
Each observation also has a 30-second read deadline. These bounds apply to a
small background probe, **not** to the Agent activation or the duration of the
task. One blocked source cannot occupy unbounded Host capacity.

## Persistence and scheduling

- Checker definitions and observation records live in the existing Matter
  SQLite database. Installing a condition is part of the same transaction as
  settlement, event acknowledgement and fallback registration.
- The shared event observation engine supplies reconciliation, bounded
  concurrency, durable attempts/checkpoints, backoff, cancellation and deadlines.
  Its Goal bridge still requires authenticated Goal storage and Goal ownership.
  Matter uses a separate owner-neutral store guarded by its Host lease and wait
  revision, rather than fabricating a Goal.
- `intervalMs` defaults to 60 seconds and accepts 1 second through 24 hours.
  Source cooldowns, errors and Host availability can delay a check. This is
  polling, not a real-time notification guarantee.
- Repeated failed checks wake the worker for repair. A deadline independently
  wakes it even if source checks cannot run. The shared observation budget also
  wakes the worker on exhaustion; it never silently completes or pauses Matter.
- Observation starts only after the current activation ends. Review time uses
  the original submission timestamp, so a fallback that passes during review
  remains valid and becomes due after the activation finishes.
- Condition resolution and the unique inbox event commit atomically. A late
  result, duplicate callback, or simultaneous fallback cannot enqueue a second
  condition wake. Claiming the next activation retires the old condition.
- User amendments, pause, cancel and manual checks retire the condition and its
  fallback. Old observation writes fail revision/ownership checks. Restart
  resumes committed waits, including their cursor and retry state.
- `MatterTasks` includes the condition ID, state, attempts, next check time and
  diagnostic, alongside the existing time fallback.

## Verification

`packages/runtime-host/src/__tests__/matter-conditions.test.ts` exercises the real
code sandbox and SQLite store with controlled source responses and business time.
It covers presets, isolation, permission failure, immutable test IDs, review
rejection/invalidation, restart, checkpoints, concurrent waits, lost leases,
deadline races, cancellation and source recovery.

The native Host integration test in
`packages/runtime-host/test/assistant/proactive-matters/test/plugin.test.ts` runs
the registered tools through the actual assistant service: test a source query,
settle, change the source, wake the same session, read inbox evidence and complete.
Its Agent and review responses are controlled fixtures, not a paid-model test.

## Settlement and task tools

`MatterSettle` accepts `disposition`, `summary`, optional `note` and `update`, plus
the existing wait condition and fallback fields. It does not require writing a
draft or entering a revision. Omitted notes preserve the existing note.

The Host validates the exact task input materialized in the Runtime ledger before
the calling tool event, then captures a revision for settlement/review. New input
before submission or during review invalidates the old decision. Observation-only
revision changes do not resend an unchanged Inbox. `wait` and `complete` still
require independent review; `continue` does not. Rejection/transport errors leave
the task active. Persisted submission identity prevents duplicate notifications.

Delegated workers see their own lifecycle tools directly, without the Bot's
Matter delegation/management tools; ordinary business tools remain available.
`MatterRead` can claim a queued activation and inspect context, but no separate
file reads or draft write are required for submission. Legacy files and stored
notes remain readable; existing tasks are not rebuilt.
