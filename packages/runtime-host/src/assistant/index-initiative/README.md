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
Broad exploration and judgement hold the same investigation slot. Source receipt
continues while an investigation runs. Screening can run alongside broad discovery,
but waits during quick investigation and its cooldown. Foreground Bot work uses
its existing execution path.

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

## Quick discovery cadence

Automatic event and periodic quick investigations both wait `intervalMinutes`
(default 15) after a completed quick investigation. Admission rechecks the deadline,
so an already queued event cannot bypass it. An explicit `check` bypasses timing,
not permissions or the occupied investigation slot. Existing failure retries and
unresolved recovery keep their own rules.

Receipts merge by source and conversation. A new screening batch waits for
`mergeQuietMinutes` (default 3) without new events, or `mergeMaxWaitMinutes`
(default 30) from its oldest pending receipt. Successful screenings, including
empty decisions, also observe the per-conversation `intervalMinutes` gap.
These are eligibility conditions, not a promise to start while the slot is busy.
Original receipts remain durable. Long-record continuations and failed batches
retain their progress and retry rules; they are not new batches. Restart preserves
receipt times, screening history and investigation cooldowns.

The existing `intake_meta` stores bounded per-group screening decisions and the
last associated investigation reference. A multi-group decision is not attributed
as an individual conclusion to every source. Investigation references indicate
which run used a thread's hints, not complete coverage, matter completion or user
delivery. Screening does not copy owner history or run another summary model.
It explicitly requests the selected model's least supported reasoning mode through
the existing Host model path; the owner Session's setting is unchanged.

Quick investigation checks the trigger and necessary related evidence, then may
finish without reporting. Global open-ended exploration remains with broad
discovery. Status exposes merging, cooldown, retry and pending-investigation states.

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

Existing-topic notes use their stored title; only new topics require a title.
Paged reads include a complete `nextRead` request so the model can retain query
and snapshot identity. `ReplyDiscovery` requires Inbox discovery IDs and uses the
same atomic Bot outbox/association commit as `SendUser`. Ordinary chat remains
available; unlinked historical messages are not guessed or backfilled.

Permissions, source scopes, provider retry policy and broad cadence remain unchanged.
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
