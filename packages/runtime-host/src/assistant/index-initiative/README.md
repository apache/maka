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
commit in one scheduler transaction. A uniqueness constraint permits one occupied
job; confirmed failures can wait for retry without occupying the slot.

The Runner prepares jobs, reconciles exact message ownership and observes the
Host. The two controllers supply investigation-specific preparation and results.
`EventIntake` receives an `IntakeSink` instead of depending on the quick controller.
Repeated wake requests retain their original FIFO position. Events arriving after
capture remain in the receipt store for a later investigation.

A missing Host answer retains the submission and appears in
`coordination.recovering`. It does not release the slot after a timer. Host handoff,
queued admission and waiting for user interaction are not execution completion.
Positive absence permits redelivery; confirmed failure permits a new message
identity. Stable notebook operation IDs and Bot message IDs protect settlement.

An intake acknowledgement may commit before the scheduler records completion.
The job retains `executionCompleted`, so recovery finishes settlement without
rerunning the model. A business completion followed by lease expiry is likewise
reconciled before starting a new job. These are separate commit boundaries, not
a cross-database atomic transaction.

## Context continuation

`legacy` keeps its workers; opt-in `scoped` rotates them only after successful
completion. Both retain current knowledge and source references. Initial context
includes at most three short recent progress previews with links to original
records. Broad discovery also receives bounded catalog and feedback pages.
Workers can read current entries and additional history on demand. Progress is
not a coverage certificate, and moderate repeated investigation is allowed.

Permissions, source scopes, provider retry policy and cadence remain unchanged.
This implementation does not add parallel investigation slots, distributed
ownership, semantic deduplication or automatic risk-based execution.

## Upgrade

Stop the old scheduler before opening the data with this version. Under the
scheduler lease, legacy lane working data and queue entries migrate transactionally
into jobs and requests. Quick configuration is imported from its old database once;
source receipts remain there. Existing worker bindings and notebook events retain
their identities. The obsolete coordinator tables are retired after conversion.

If both legacy lanes describe potentially live executions, migration rolls back
and reports `coordination.migrationError`; resolve the old executions before
retrying. It never chooses one and drops the other.

Use a pre-upgrade backup for rollback to an older binary. The old quick JSON is
not a synchronized rollback copy, and older schedulers do not understand jobs.
No live-profile migration is necessary to run the synthetic regression suite.
