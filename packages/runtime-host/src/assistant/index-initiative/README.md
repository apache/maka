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

# Discovery execution

Periodic broad discovery and quick discovery share one `DiscoveryRunner`.
Broad exploration and judgement hold the same investigation slot. Source intake
and screening can continue while an investigation runs; foreground Bot work
uses its existing execution path.

## Authority and storage

| Data | Authority |
| --- | --- |
| Coalesced FIFO requests | `discovery_requests` in the main `initiative.sqlite`; one row per lane |
| Logical investigation, fixed submissions and settlement | `discovery_jobs` in the same database |
| Enablement, cadence and worker bindings | Existing configuration; quick configuration is under `scopes.quick` |
| Source cursors, receipts and hints | Existing `quick-discovery/initiative.sqlite` |
| Knowledge, corrections, progress and feedback | Existing `notebook.sqlite` journal and rebuildable projections |
| Admission, execution and delivery | Existing Runtime Host and Bot receipts |

The controllers' `active`, `pendingDraft` and quick `pending` fields are views of
job working data, not a second persisted scheduler. Configuration and job updates
commit in one scheduler transaction. The broad and quick payload types are defined
in `work-types.ts`; key writes and projection attachment document this boundary.
A uniqueness constraint permits one occupied job; confirmed failures can wait for
retry without occupying the slot.

The Runner prepares jobs, reconciles exact message ownership and observes the
Host. The two controllers supply investigation-specific preparation and results.
`EventIntake` receives an `IntakeSink` instead of depending on the quick controller.
Repeated wake requests retain their original FIFO position. Events arriving after
capture remain in the receipt store for a later investigation.

A missing Host answer retains the submission and appears in
`coordination.recovering`. Five continuous minutes without a resolved recovery
abandons the investigation and frees its slot. The lane waits for its normal
cadence; it does not immediately replace the investigation. Cancellation is
best-effort. Late memory writes, draft results and unsent reports are discarded;
already committed knowledge, history and unconsumed source hints remain.
The recovery timestamp survives restart and resets when the Host resolves the
execution. Healthy long investigations, queued admission and waiting for user
interaction have no five-minute execution limit. Host handoff is not completion.
The observer uses the existing `TurnMessageExecutionResolution` protocol: `pending`
and `inbox` keep waiting, and `owned` permits observing the actual execution outcome.
A `completed` query reply is invalid; completion is checked separately through the
Host execution snapshot.
Positive absence permits redelivery; confirmed failure permits a new message
identity. Stable notebook operation IDs and Bot message IDs protect settlement.

An intake acknowledgement may commit before the scheduler records completion.
The job retains `executionCompleted`, so recovery finishes settlement without
rerunning the model. A business completion followed by lease expiry is likewise
reconciled before starting a new job. These are separate commit boundaries, not
a cross-database atomic transaction.

## Context continuation

`legacy` keeps its workers; opt-in `scoped` rotates them after successful
completion. Both modes use fresh workers after abandonment so late tool calls
cannot acquire a new investigation's identity. Both retain current knowledge and source references. Initial context
includes at most three short recent progress previews with links to original
records. Broad discovery also receives bounded catalog and feedback pages.
Workers can read current entries and additional history on demand. Progress is
not a coverage certificate, and moderate repeated investigation is allowed.

Permissions, source scopes, provider retry policy and cadence remain unchanged.
This implementation does not add parallel investigation slots, distributed
ownership, semantic deduplication or automatic risk-based execution.

## Cutover

Use a fresh profile, or finish pending discovery work in the previous version
before switching. This Runner starts from idle settings; it does not convert old
in-flight jobs, queue rows or previous handoff records, or reconstruct missing
submission identities from conversation history. Unfinished old state is rejected
without deleting it; scheduler status exposes `coordination.initializationError`.

Existing notebook events, source receipts, settings and restricted worker roles
remain available. Old coordinator tables are left untouched and are not used by
the Runner; normal triggers create new requests from current cadence and hints.
Jobs created by this Runner still recover normally across restart and Host handoff.
A rollback to an older binary requires the pre-upgrade data, not the new job state.
