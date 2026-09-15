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

# Draft: Revision-consistent Usage screen reads

- Status: Proposed; Storage semantics require review.
- Implementation status: Design only; no runtime behavior changes.
- Delivery scope: [Issue #4058](https://github.com/apache/maka/issues/4058).
- Design constraints: [Storage and protocol rules](https://github.com/apache/maka/discussions/4876).
- Source baseline inspected: `1ae4d5b89` on 2026-09-15.
- Review follow-up: [screen capacity and filter transitions](https://github.com/apache/maka/pull/5023#issuecomment-5682698338).

This document defines the consistency contract for Settings Usage. It does not
set new performance targets, historical-size guarantees, admission budgets, or
latency requirements.

## Problem

On the inspected baseline, Desktop builds one Usage screen from independent
summary, LLM-log, tool-log, and pricing reads. The log reads are drained into
Desktop and provider/model/tool breakdowns are computed there. A Usage write,
repair, pricing mutation, or Host replacement between those reads can therefore
produce one rendered screen whose parts describe different database states.

The renderer now paginates the already-loaded activity array, which reduces the
number of rows rendered at once but does not give the screen a shared Storage
revision. Issue #4058 is about that consistency defect.

## Decision

One initial Storage operation returns the Usage statistics, breakdowns,
pricing/coverage, and first activity page from one read transaction and stamps
the result with one opaque revision. A continuation supplies that revision and
receives a page only when it still matches. A mismatch returns
`revision_changed` without rows.

Host retains no per-reader Usage dataset. Desktop retains the visible result and
the cursor metadata needed for navigation, but it never assembles a new screen
from responses carrying different revisions.

## Scope

This design includes:

- one Storage read transaction for every value installed as the initial screen;
- one opaque Usage-screen revision and complete invalidation coverage;
- revision-checked, query-bound activity continuation;
- Host-generation fencing across reconnect or Host replacement;
- preservation of current accounting, pricing, coverage, activity-filter, and
  historical-retention semantics;
- atomic Desktop installation and an explicit stale-screen state;
- whole-request failure when the complete screen exceeds its wire limits;
- whole-screen reload on activity-filter changes.

This design does not include:

- scan/admission thresholds or a scan-budget `limit_exceeded` product state;
- a guarantee that exact queries complete for arbitrary history sizes;
- incremental aggregate or completeness projections;
- new latency, memory, scan, sort, or availability targets;
- additional breakdown/pricing pagination or general-purpose query APIs;
- retention changes, retroactive repricing, exports, or coverage UI redesign.

Existing protocol item and encoded-byte limits remain in force. They are wire
safety constraints, not a new performance contract in this design. The screen
capacity failure below is in scope; it does not introduce a history-size or
query-work admission budget.

## User-visible behavior

### Initial load

Selecting a range obtains one complete screen result. Desktop installs that
result atomically; it never preserves a summary from one attempt while replacing
logs or pricing from another.

If the selected Host changes before the result is installed, Desktop discards
the result and reloads from the new Host. An initial revision race may retry the
whole load a finite number of times. It may not degrade into independently
accepted fragments.

### Screen capacity failure

The initial Host operation returns either one complete screen or a typed
`screen_response_too_large` failure without screen fields or continuation tokens.
The wire boundaries are defined below. No summary, breakdown, or pricing entries
may be omitted to turn an oversized screen into a successful response. Activity
remains an explicitly paginated list with `hasMore` and a continuation cursor.

On first load, Desktop shows a load error instead of empty or zero-valued Usage.
If a screen from the same Host is already visible, Desktop retains that complete
result, labels it as the previous result, displays the failed-load error, and
disables continuation until a new screen is successfully installed. Its range
and filters remain attached to the retained result; pending controls must not
mislabel old rows as matching a new selection. Host replacement still discards
the old Host's result and tokens.

Capacity failure is not `revision_changed` and does not enter the automatic
revision-race or reconnect retry path. A user may explicitly retry, but the same
oversized result deterministically fails again. A smaller range or activity
filter is not guaranteed to help: pricing is not reduced by activity filtering,
and the complete range-wide breakdowns remain required. This design accepts
that some screens cannot be displayed within the wire limits. Supporting them
through same-revision segmented reads would require a separate scope decision.

### Activity-filter changes

Changing activity filters starts `readUsageScreen(currentResolvedRange,
newActivityFilters)`. Reuse the current fixed `from` and `to`, including the fixed
upper bound for `All`; editing a search does not advance the time window.
The new read obtains its transaction's revision and the query identity for the
new filters; the revision can equal the previous screen's if nothing changed.
On success, Desktop atomically replaces statistics, breakdowns, pricing/coverage,
and activity page one, resetting navigation. Filters affect only activity;
headline statistics and breakdowns still cover the entire selected range.

Do not fetch only a new activity page and preserve old statistics. There is no
operation for starting a different activity query against an old revision.
While loading, a retained screen stays associated with its original range and
filters and cannot continue paging. Failure leaves it visibly identified as the
previous result. Refresh retries the requested range/filter selection as a whole.
Every filter change supersedes earlier screen and continuation requests, even
when the old and new responses happen to carry the same Storage revision.

### Activity continuation

The first activity page belongs to the initial screen revision. Each later page
uses the same resolved range, activity filters, query identity, and expected
revision.

When the revision still matches, Storage returns the next page. When it has
changed, Storage returns `revision_changed` without a page. Desktop keeps the
already visible, internally consistent screen, marks it stale, and offers
Refresh. It does not append rows from the new revision or maintain a frozen copy
of the old Storage state.

This means continuous writes may interrupt continuation. The contract guarantees
consistency and bounded retry, not indefinite browsing of an old revision.

## Storage contract

The interface names below are illustrative; Storage review owns their final
placement and naming.

```text
readUsageScreen(resolvedRange, activityFilters)
  -> screen(revision, queryIdentity, summary, provenance,
            providerBreakdown, modelBreakdown, toolBreakdown,
            pricing, activityPage)

readUsageActivityPage(queryIdentity, cursor, expectedRevision)
  -> page(revision, rows, nextCursor, hasMore)
   | revision_changed(expectedRevision, actualRevision)
```

`readUsageScreen` executes its accounting queries and first activity selection
on one SQLite handle inside one read transaction. It does not compose independent
asynchronous store reads whose transactions can observe different states.

`readUsageActivityPage` opens a new read transaction, compares the expected and
actual revisions, and selects the page within that same transaction. It returns
no rows on mismatch. No transaction survives the request or awaits IPC, metadata
hydration, or user input.

The resolved range has fixed `from` and `to` values. `All` also receives a fixed
upper bound for this screen. The query identity binds that range and the activity
filters, so a cursor cannot be reused with a different query.

### Host screen wire boundary

Storage returns the transactional screen; Host owns projection, wire validation,
and the typed capacity outcome. The proposed screen protocol explicitly adopts
these limits; the old pricing-page limits alone do not define a screen response:

| Boundary | Maximum | Completeness on success |
| --- | --- | --- |
| Each provider/model/tool breakdown | 100 entries and 48 KiB of encoded JSON for that array | All groups for the selected range |
| Pricing | 128 entries and 48 KiB of encoded JSON for that array | All entries required by the existing screen pricing semantics |
| Activity page | 100 rows and 48 KiB for the encoded page, including cursor metadata | One page, with explicit continuation when more rows exist |
| Entire screen result | 640 KiB of encoded JSON, including revision, query identity, summary, provenance, all collections, and navigation metadata | One complete screen |
| Entire Host message | Existing `RUNTIME_HOST_MAX_MESSAGE_BYTES` (768 KiB on the inspected baseline) | Includes the protocol envelope |

The collection counts reuse the existing Usage/pricing page counts as explicit
screen-section limits, not as assumptions about the maximum stored collection.
The 640 KiB result limit leaves room for the envelope; it does not replace the
final encoded-message check. UTF-8 bytes after JSON escaping are counted, not
string length. Existing field bounds and accounting semantics still apply.
These are wire capacities, not bounds on SQLite scan, sort, or aggregation work.

If any complete section, the screen result, or its enclosing message cannot fit,
Host returns `screen_response_too_large`. It must detect capacity failure before
submitting an oversized success frame to transport, preserving the connection.
The bounded error contains only a fixed failure code and a bounded section enum
(`provider_breakdown`, `model_breakdown`, `tool_breakdown`, `pricing`,
`activity_page`, `screen`, or `message`); it carries no partial data or diagnostic
copy of the payload. If activity has remaining rows, page sizing must either
return a nonempty fitting page with a cursor or fail, never silently end the list.

The new operation's strict codec validates these boundaries. Reuse encoded bytes
or trusted lengths for the same value/version/boundary where available, rather
than repeatedly serializing collections. Independently valid sections must still
pass the total result and message limits. No breakdown/pricing drain loop,
per-reader Host cache, or segmented screen assembly is introduced.

### Author proposals for Storage review

The consistency contract above is fixed by this design. The mechanisms below are
author proposals for likun to accept, replace, or request evidence for; they are
not decisions made on Storage's behalf.

| Decision | Author proposal | Alternative | Confirmation requested from likun |
| --- | --- | --- | --- |
| Query boundary | Add screen and activity-page reads to the existing Usage stores facade, delegating the synchronous multi-query transaction to one internal module on the current SQLite handle | Implement the transaction directly in the facade | Confirm the placement reuses the existing lease and creates no competing root owner |
| Repair boundary | Host explicitly asks the existing Usage writer to repair, waits for that transaction to finish, then calls the screen read | Expose an explicitly writable Storage operation that performs repair followed by the read | Confirm repair authority and failure handling remain with the current owner and no transaction spans both requests |
| Revision | Start with one root-scoped durable Usage counter advanced explicitly in every relevant mutation transaction, combined with the existing pricing revision and Host-generation fence | Use narrowly scoped SQLite triggers or another mutation-sensitive Storage revision | Confirm complete writer coverage, rollback/no-op behavior, and old-token rejection after restore or replacement |
| Cursor | Use `(timestamp, source, stableStorageIdentity)` with physical indexes matching its exact newest-first comparator | Use another globally unique stable ordering key supplied by Storage | Confirm uniqueness across canonical, legacy, and tool sources and validate the exact seek predicate |
| Restore fencing | Include a durable database-incarnation identity in the opaque revision and also require the existing Host-generation match | Rotate an equivalent Storage lifecycle identity on restore/rebuild | Confirm a repeated numeric counter can never validate a token issued for an earlier database incarnation |

These defaults deliberately avoid a new durable query cache, retained snapshot,
or aggregate authority. Selecting an alternative must preserve the same public
screen/page consistency behavior.

The review supports these directions but does not approve a concrete Storage
implementation. Before implementation, record the chosen mechanisms and a writer
coverage table mapping each invalidating mutation below to its actual writer,
transactional revision update, and rollback/restore test. Fine-grained revisions
and a new aggregate authority are not prerequisites for this design.

### Repair ordering

The existing Usage repair authority remains unchanged. An initial request may
ask that writer to perform the existing repair/catch-up pass before the screen
read. The repair transaction ends before the read transaction begins.

Storage derives summary, provenance, and coverage inside the screen transaction;
it does not trust an earlier repair result as a snapshot. A source commit between
repair and read is represented by the revision and coverage observed by the read
transaction. Continuation does not initiate repair; a later repair that changes
the screen invalidates its revision.

## Revision identity

The revision is invalidation metadata, not another copy or authority for Usage
facts. Its concrete representation is a Storage decision and is opaque on the
wire.

It must change in the same committed transaction as every mutation that can
change a screen result, including:

- legacy LLM and tool Usage insert, update, or delete;
- canonical model-call attempt and repair-checkpoint changes;
- source changes that affect pending, unreadable, or completeness evidence;
- pricing override changes;
- supported migration, rebuild, restore, or database replacement that changes
  the interpretation or contents of a screen.

Rollback must roll back invalidation. A no-op need not invalidate. Tokens from a
previous database incarnation or Host generation must not validate merely
because a numeric counter repeats.

Storage review must choose the update mechanism and audit the real writer paths.
An explicit counter and narrowly scoped triggers are implementation alternatives;
this consistency contract does not select between them. Existing pricing
revision and Desktop Host-generation fencing may form part of the opaque screen
revision rather than creating a second pricing owner.

`MAX(ts)`, row count, a request ID, or a full-table hash is not sufficient: the
revision must cheaply detect corrections and changes that do not advance the
maximum timestamp or row count.

## Activity cursor and filters

Activity ordering is newest first with a deterministic, unique tie-breaker. The
logical cursor is:

```text
(timestamp, source, stableStorageIdentity)
```

Displayed IDs are not assumed unique. Storage validates the cursor, its query
identity, and its position in the resolved range. Equal timestamps, duplicate
display IDs, multiple sources, empty pages, and deleted/corrected rows require
contract tests.

Existing activity filters retain their current meaning. Model/provider/tool
substring search and status filtering apply to the selected range before page
selection, not merely to the visible rows. Changing filters follows the
whole-screen reload above and uses a query identity for the new filter values.
Headline statistics and breakdowns continue to describe the selected range, as
they do on the baseline.

Moving activity filtering into Storage is required because Desktop no longer
owns the complete activity array. This document does not add a new search index,
search budget, or matching semantics.

## Accounting and presentation invariants

The unified read reuses the existing canonical and legacy accounting rules. In
particular:

- provider grouping preserves connection identity with the existing fallback;
- model and tool grouping preserve their current keys and calculations;
- token fields retain current cache-read, cache-write, reasoning, and total
  semantics;
- unpriced usage remains distinct from priced zero;
- canonical and legacy contributions retain their existing composition rules;
- Usage history that currently survives Session deletion continues to survive;
- pricing mutations and historical cost interpretation do not change.

Session titles are presentation enrichment, not Usage accounting. If they are
hydrated outside the read transaction, they do not participate in the Usage
revision and may not change totals, ordering, cursor identity, or coverage.

## Host, IPC, and Desktop responsibilities

Storage owns the transaction, revision comparison, accounting composition, and
cursor predicates. Host validates and projects the result but retains no dataset
between requests.

Runtime Host's Usage protocol gains an initial-screen result, a typed
`screen_response_too_large` failure, and a revision-checked continuation result.
Desktop's existing `usage:summary` IPC entry point returns the complete initial
screen or propagates the typed capacity failure. The compatibility epoch rises
above main when this wire change is implemented.

Desktop owns presentation and request supersession:

- a newer range, filter, Refresh, or Host generation invalidates older replies;
- request supersession and query identity are checked even at equal revisions;
- filter changes read and replace the whole screen using the fixed range;
- a complete initial result replaces the previous screen atomically;
- continuation appends only a page for the current request/query and revision;
- capacity failure installs no fragments and follows the failed-load UI above;
- `revision_changed` preserves the visible result, marks it stale, and stops
  continuation until Refresh;
- no background loop drains activity pages or rebuilds breakdowns from them.

## Verification contract

Storage tests exercise the selected public screen/page interface with real
SQLite:

- a write before, during, or after the initial read cannot mix revisions;
- repair, source/checkpoint, pricing, legacy, canonical, and tool mutations
  invalidate exactly as selected by the revision contract;
- rollback, no-op, restore, and repeated counter values cannot validate a stale
  token incorrectly;
- continuation compares revision and reads the page in one transaction;
- cursor ordering and query binding cover equal timestamps, duplicate display
  IDs, multiple sources, empty results, filters, corrections, and deletions;
- accounting and coverage match the existing public Usage behavior.

Protocol and Desktop tests cover malformed or mismatched tokens, Host
replacement, delayed replies, rapid range/filter changes, finite initial retry,
atomic screen replacement, stale-screen presentation, and rejection of a page
from another revision. Compatibility tests cover the epoch change.

In particular, implementation acceptance includes:

- item-count and encoded-byte boundaries at the limit and one above it for each
  complete collection, the result, and the message; include multibyte and escaped
  text, envelope overhead, and individually valid sections whose total exceeds
  the screen limit;
- oversized screen failure carries no partial data or tokens, remains a valid
  bounded error frame, and does not disconnect or automatically retry;
- initial-load, Refresh, and filter-load capacity failures display the specified
  error and retain only correctly labelled previous results when applicable;
- display revision A, commit B, then change filters: install the complete B
  screen or fail as a unit, never A statistics beside B activity;
- rapid filter changes at the same revision reject older replies and old
  continuation pages; changing filters preserves fixed time bounds, resets
  pagination only on successful installation, and leaves headline/breakdown
  accounting unfiltered.

This design makes no performance claim. Performance benchmarks, admission
limits, and arbitrary-history availability are not acceptance criteria for
issue #4058.

## Relevant implementation seams

- Storage ownership and transactions: `packages/storage/src/usage-stores.ts`.
- SQLite schema and legacy/tool queries: `packages/storage/src/sqlite-usage-schema.ts`
  and `packages/storage/src/sqlite-usage-store.ts`.
- Canonical accounting: `packages/storage/src/model-call-ledger.ts` and
  `packages/storage/src/model-call-usage-sql.ts`.
- Host protocol and coordination:
  `packages/runtime-host/src/protocol/usage-pricing.ts` and
  `packages/runtime-host/src/server/usage-pricing-coordinator.ts`.
- Desktop adaptation: `apps/desktop/src/main/runtime-host-usage-ipc-main.ts`,
  preload contracts, and renderer Usage services/UI.
