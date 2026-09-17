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

# Revision-consistent Settings Usage

Implements [#4058](https://github.com/apache/maka/issues/4058) using the contract
reviewed in [#5023](https://github.com/apache/maka/pull/5023). A complete screen
comes from one synchronous SQLite read transaction. Continuation checks the
revision and selects its page in another single read transaction. No transaction
spans an await, and Host holds no per-reader dataset.

## Selected mechanisms

`InteractiveUsageStores.readUsageScreen` delegates to the internal
`usage-screen.ts` module on the existing operational database owner. The initial
Host request first awaits the existing `catchUpModelCallProjection` writer.
Coverage is then read again inside the screen transaction; a repair outcome is
never reused as evidence for that screen.

SQL combines canonical and frozen legacy accounting, groups providers by
connection (falling back to provider), groups models by model identity, and
aggregates tools separately. Activity search/status predicates apply before the
page limit, including Unicode lowercase substring matching. They never filter
headline statistics or breakdowns. A filtered activity count is read in the same
transaction as the initial screen, so numbered pagination knows its exact total
from the first page. The three source indexes support timestamp
and stable storage identity ordering; the cross-source comparator is
`(timestamp DESC, source DESC, stableStorageIdentity DESC)`. Display IDs may repeat.
Cursors bind that tuple and the fixed query identity. The tuple must identify a
stored row in the selected range.

The opaque revision combines the durable database incarnation and Usage counter
with a reader lifecycle identity; Host adds its own generation fence. A restored
backup may repeat the durable incarnation and counter, but reopening the stores
changes the lifecycle identity. Database replacement/restore requires closing
its existing owner, as with the existing SQLite ownership contract. In-place
external replacement of an open SQLite file is not a supported restore path.

## Writer coverage

Usage schema version 8 adds one singleton revision row; version 9 also fences
Session titles. Activity titles are read from `session_metadata` inside the same
read transaction as the page and revision. Narrow SQLite triggers
advance its counter in the same transaction as the mutation, including foreign
key cascades. Rollback rolls back the counter. Usage-table updates may invalidate
even when values compare equal; existing no-op pricing and repair paths issue no
mutation and remain stable. Ordinary non-Usage run metadata/events do not bump it.

| Mutating owner | Tables/evidence | Invalidation and regression evidence |
| --- | --- | --- |
| `SqliteTelemetryRepo.insertLlmCall` | `usage_llm_calls` | INSERT/UPDATE/DELETE triggers; correction without count/timestamp change, rollback, WAL race and stable-identity page tests |
| `SqliteTelemetryRepo.insertToolInvocation` | `usage_tool_invocations` | INSERT/UPDATE/DELETE triggers; mixed-source duplicate IDs, tool mutation and deletion tests |
| `SqliteModelCallLedger.catchUpProjection` | attempts and projection checkpoints | INSERT/UPDATE/DELETE triggers; repair, correction, unreadable checkpoint and no-op catch-up tests |
| `agent-run-store.ts` append/repair writers | model-call events and `latest_model_call_sequence` | Source triggers limited to model-call events/high-water or run identity changes; pending-source and source deletion tests |
| Session metadata owner | `session_metadata` | INSERT/DELETE and name/identity UPDATE invalidate continuation; unrelated metadata updates remain stable; real Host rename-between-pages regression |
| Session purge (`conversation-operational-state.ts`) | run/event/checkpoint cascades | Triggers follow cascades; canonical/legacy Usage facts remain retained and counted |
| `SqlitePricingStore.upsert/delete` | overrides and pricing authority | INSERT/UPDATE/DELETE triggers; mutation invalidates, identical upsert stays stable |
| Operational owner migration/restore | singleton incarnation, lifecycle, schema | Existing atomic migration and schema guard; actual backup restore with repeated durable counter rejects old tokens |

The operational database owns the singleton and its indexes/triggers. It lives
as long as that database and is retired with the root/database by its existing
lifecycle owner. No per-query durable rows, leases, cleanup queue, retention
change, or second accounting authority are introduced.

## Wire and Desktop behavior

`usage.query` gains `screen` and `activity` request/result variants. Complete
breakdowns are limited to 100 groups each, pricing to 128 entries, each collection
to 48 KiB, and activity pages to 100 rows/48 KiB including navigation metadata.
Storage selects 50 activity rows plus one look-ahead and at most one sentinel
past a collection limit. A sentinel means whole-screen failure, never success
with truncated groups. Pricing retains the existing Settings override semantics.

The result limit is 640 KiB; the actual envelope is checked against the existing
768 KiB message limit before outbound transport. Section measurements are reused
in the result count. A deeply frozen response carries its trusted result byte
count through in-process validation; the weak measurement map does not retain
responses. Decoded network objects are independently validated. At today's
limits, five individually valid sections plus bounded metadata cannot reach
640 KiB; the total and envelope checks remain separate safeguards.

Capacity failure is `screen_response_too_large` with only a bounded section enum.
It has no rows, totals, revision, or cursor and does not trigger reconnect/retry.
The first load displays an error; an existing same-Host complete screen remains
visible with a retained-result notice and disabled continuation. The query remains
bound to that retained snapshot, but its raw range/search/status metadata is not
displayed as a separate row.

Desktop's existing Settings `settings:usageStats` IPC now returns the complete
screen; `usage:activity` requests a single continuation. The Session Inspector's
separate `usage:summary` API keeps its existing contract. No activity drain loop
or activity-derived breakdown remains in the Settings adapter. The existing table
pagination shows numbered pages from the initial response. Selecting an unloaded
page follows the existing keyset continuations up to that page, then installs
the matching-revision records together; already loaded pages are local. There
is no separate Load more control or unknown-total pagination mode. Failed or
superseded reads do not advance the visible page.

Range/filter/Refresh requests supersede both screen and page replies, even when
revisions are equal. Filter edits preserve the resolved time bounds (including
All), install a complete new screen, and reset page navigation only on success.
The text input keeps its identity/focus across successful loads. Refresh resolves
a new time window. `revision_changed` retains the complete visible result and
stops paging until Refresh. A Host generation change discards the old screen and
tokens synchronously.

## Verification and limits

Real SQLite tests cover canonical/legacy accounting, free versus unpriced calls,
range-wide filters, pending/unreadable evidence, equal timestamps and duplicate
IDs, correction/deletion, transaction rollback, WAL writes during a read, and
backup restore. Protocol tests cover strict shapes, count and escaped UTF-8 byte
boundaries, cursor/envelope overhead, bounded capacity failure and replacement
Host fencing. Desktop tests cover atomic installation, same-revision filter
supersession, late pages, stale/error retention, fixed ranges, and Host changes.
Storybook exercises the production Settings frame in stale and capacity states.

This change sets no scan/latency/admission budget or arbitrary-history availability
guarantee. SQL aggregation can still scan/group historical rows. Continuous Usage
writes can interrupt pagination, and a complete screen exceeding wire capacity
cannot be displayed without a separate segmented-read design.
