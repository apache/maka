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

# Draft: Revision-consistent, bounded Usage screen reads

- Status: Proposed; Storage semantics and product scope require review.
- Implementation status: Design only; no runtime behavior changes.
- Delivery scope: [Issue #4058](https://github.com/apache/maka/issues/4058).
- Design constraints: [Storage and protocol rules](https://github.com/apache/maka/discussions/4876).
- Source baseline inspected: `93a8dd785` on 2026-09-08.

This document describes a proposed cross-package contract. Implementation tasks,
review questions, and progress belong in the accompanying draft pull request.
It is not an accepted architecture decision or a claim of measured performance.

## Decision boundary

The core direction follows the [maintainer's P1 review](https://github.com/apache/maka/pull/4068#pullrequestreview-5124372706):
a single-transaction first screen, narrow SQL aggregation, bounded on-demand
activity pages, and revision-checked continuation without a retained Host dataset.

The concrete Storage boundaries and implementation mechanisms remain for
likun (@likun666661) to decide before production implementation begins. This
includes the query interface, revision identity and writer coverage, schema and
indexes, cursor comparator, repair/read ordering, source-accounting composition,
and scan/sort budget enforcement on the project's SQLite setup. The mechanisms
below are candidates for that review, not decisions already made on his behalf.

The author recommends preserving existing activity search and status filtering
by applying them in Storage before pagination. Removing them or restricting them
to the visible page requires explicit product approval. Additional breakdown/pricing
pagination and the automatic refresh policy remain product decisions, with their
Storage support subject to likun's review. Recommendations below are proposals
for acceptance or replacement, not accepted decisions. Mechanism-specific tests
apply only after selection; consistency and bounded reads remain mandatory.

## User outcome

Selecting a Usage range displays summary cards, provider/model/tool breakdowns,
pricing information, and one bounded activity page from one database revision.
Selecting **All** expands the statistical time window; it does not cause Desktop
to retrieve every activity record. Additional pages are fetched only on demand.

If the underlying revision changes while the user browses, the screen reports
that its data changed and obtains a new first-page result. It never combines a
new activity page with older summary or pricing data.

## Scope and invariants

1. Storage owns the transaction, aggregation, source composition, cursor
   predicates, completeness metadata, and revision comparison behind one query
   interface. Host performs protocol projection; Desktop handles presentation.
2. All values in an initial screen result are read on the same SQLite handle in
   one short read transaction. No transaction survives a request or awaits IPC,
   session metadata I/O, or user input.
3. Subsequent reads compare the expected revision and read their data inside
   the same transaction. A mismatch returns `revision_changed` without a page.
4. Every variable-length output has item, text, and encoded-byte limits.
   Activity limits apply before record payloads enter application memory.
5. The renderer retains the visible page and bounded navigation metadata. It
   does not prefetch until exhaustion or compute statistics from loaded rows.
6. Usage records, canonical accounting rules, pricing mutation semantics, and
   repair ownership stay with their existing durable owners.

The proposed core product scope includes activity pagination, preservation of
existing search/status filters across the selected range, and a visible
revision-change state. Additional breakdown/pricing pagination needs scope
confirmation, including what users see when an unpaged collection exceeds its
cap. Exports, retention-policy changes, retroactive repricing, and general-purpose
query infrastructure are outside this design.

## Storage decisions and trade-offs

The options below give likun a comparison to accept, reject, or replace before
implementation. They preserve the single-transaction first screen, Storage-owned
revision checks, and absence of a retained Host dataset. They do not select a
mechanism or transfer any existing writer's authority.

### Author proposals for maintainer decision

These starting proposals make the choices reviewable. Record acceptance,
replacement, or a request for evidence in the PR; do not infer implementation
approval from agreement with the core direction alone.

| Decision | Author proposal and code basis | Alternative / acceptance condition | Decision owner |
| --- | --- | --- | --- |
| Query boundary | Expose screen/page reads on `usage-stores.ts`, delegating synchronous SQL to one internal module using the existing operational database lease | Direct facade implementation is also valid; demonstrate one handle/transaction and no duplicate root owner | likun |
| Repair boundary | Host requests one explicit bounded pass through the existing writer, then reads the screen; `canonical-usage-reader.ts` already orchestrates repair | Storage may wrap both steps with an explicitly writable API; either choice must bound selection, event bytes, and completeness work below | likun |
| Revision | Start with a root-wide counter advanced in existing write transactions, plus pricing revision and Host/query fencing | Triggers are an alternative if explicit coverage is too fragile; accept only after the writer matrix below and live-write refresh measurements | likun |
| Schema and cursor | Reuse canonical columns; add legacy/tool scalar projections and indexes matching source-qualified storage identity | Choose the minimum columns after accounting/query-plan review; resumable backfill must preserve orphaned historical Usage | likun |
| Work enforcement | Evaluate bounded admission before exact SQL aggregation, as specified below; refuse the whole screen when admission fails | This can reject All, or every time range on root-wide completeness overflow. Product must accept that outcome or request another bounded design before implementation | likun + product maintainer |
| Existing filters | Preserve model/provider/tool substring search and status filtering in Storage; the baseline UI already exposes both | Any removal or changed matching semantics needs explicit product approval; sparse search must consume a finite scan budget | product maintainer; Storage feasibility by likun |
| Refresh and other lists | Propose at most one automatic first-screen reload per user action, then manual Refresh; defer extra list navigation only if an explicit whole-screen limit outcome is accepted | Confirm pagination versus failure for oversized breakdown/pricing lists; never silently truncate or drain pages | product maintainer; Storage support by likun |

### Query module placement

| Option | Benefit | Cost / constraint |
| --- | --- | --- |
| Add screen/page operations to the existing Usage stores facade | Reuses the current root lease, admission, and lifecycle integration | Adds cross-source query responsibilities to that module; the implementation must still use one transaction rather than compose independent asynchronous reads |
| Introduce a dedicated Usage query module inside Storage | Concentrates transaction, accounting, cursor, and budget logic behind one interface | Needs explicit integration with the existing lease and lifecycle; must not acquire a competing root owner or duplicate accounting rules |

These options can be combined: the existing facade can expose a dedicated
internal query module. Compare the actual change footprint and reuse of existing
SQL before choosing. Results should carry Usage data, with display formatting
and UI state remaining outside Storage. Verify consistency and budgets through
the public screen/page interface, whichever placement is selected.

### Repair orchestration

| Option | Benefit | Cost / constraint |
| --- | --- | --- |
| Host explicitly requests one bounded repair through the existing writer, then calls the unified Storage read | Keeps the write step and its failure handling visible to the caller | Callers must apply the agreed repair policy consistently; Storage must derive completeness inside the read transaction rather than trust the earlier repair result |
| A Storage operation explicitly wraps bounded repair followed by the read transaction | Centralizes ordering and failure handling for all callers | The operation requires writer authority and must advertise its write effect; it cannot masquerade as a read-only reader method |

Both candidates retain the existing repair owner and end the repair transaction
before opening the read transaction. Compare writer-admission integration and
test repair failure, a source event committed between repair and read, and
pending work after the permitted pass. Neither candidate requires repair on
continuation or repairing history to completion.

### Revision maintenance and invalidation scope

If a durable Usage counter is selected, its update mechanism and invalidation
scope are separate decisions:

| Update mechanism | Benefit | Cost / evidence needed |
| --- | --- | --- |
| Advance it explicitly within each relevant write transaction | Keeps invalidation next to the mutation and can avoid no-op updates | Enumerate every writer, source-event update, repair, cascade, and supported rebuild path; demonstrate that none bypasses invalidation |
| Use narrowly scoped SQLite triggers | Covers changes to selected tables regardless of the calling writer | Define the relevant tables and columns, no-op predicates, and migration lifecycle; measure extra writes and prove source/checkpoint coverage as well as Usage-row coverage |

A root-wide counter simplifies comparison but also invalidates queries for
unrelated writes. Finer scopes can reduce that disruption, but require a proof
that cross-scope changes and corrections moving older records into or out of a
query still invalidate it. Compare continuation success and refresh frequency
under active writes alongside write cost. Neither scope is selected here; the
existing pricing revision and Host identity fencing remain part of the contract.

### Required evidence before implementation

Storage review must establish enforceable work boundaries and acceptance criteria
for the whole first-screen path: repair, completeness queries, aggregation, and
activity selection, plus continuation and the preserved filters. Specify fixture
sizes, scan/sort work limits, latency targets, and the behavior when a limit is
reached. Mechanisms remain open, but bounded output alone is insufficient.
Use the performance fixtures below to validate the selected implementation;
partial totals must never be presented as complete. Product confirmation of
filter behavior, oversized collections, and refresh remains separate from the
Storage mechanism. The following candidate supplies a concrete starting point;
its row ceilings are proposed experiment parameters, not project guarantees.

### Candidate: bounded admission before exact work

A conservative implementation can bound work without a new SQLite interruption
API: in the same transaction as the expensive operation, first admit a finite
indexed relation. Probe at most the remaining row budget plus one, selecting only
narrow keys/measurements; refuse before aggregation if the range exceeds it.
Do not compute a full `COUNT(*)` to make that decision. Across Usage sources,
consume one shared allowance rather than granting the full allowance per source.

For an admitted relation, SQL can compute exact totals and groups with a bounded
number of input rows. Each string/payload also needs a byte allowance, checked
before decoding or filtering it; row count alone cannot bound arbitrarily large
legacy values. Maintained scalar byte measurements, or bounded per-row checks
proved against the selected schema, are part of this candidate. Migrations must
establish them before admitting reads. Admission is repeated inside the initial
repair write transaction and the later read transaction where needed, so writes
between the two cannot bypass the read budget.

| Path | Proposed work boundary | Enforcement and result when exhausted |
| --- | --- | --- |
| Repair | At most 10k source runs considered, 16 repaired runs, 512 events per repaired run, plus an explicit shared event-byte cap | Bound candidate-run selection before joining/sorting; measure event bytes before loading JSON. Existing run/event limits alone are insufficient. Refuse this attempt rather than calling the old unbounded helper |
| Completeness | At most 10k source/checkpoint entries per relation, with bounded key bytes | Admit source and checkpoint relations before exact pending/unreadable SQL; no full pending `COUNT` or checkpoint `SUM` before admission. Failure is a limited screen result, never complete coverage |
| Summary and groups | At most 250k scalar Usage rows total across sources, with explicit scalar-byte and group/output caps | Probe range indexes with `remaining + 1`; aggregate only if the entire range is admitted. Refuse the whole screen on overflow, never sum just the admitted prefix |
| Activity and search | 100 output items / 48 KiB; propose at most 10k examined candidates across sources per request, plus scalar-byte cap | Seek first, then inspect only a bounded candidate relation with the same search normalization as the UI. If a page or definitive end cannot be established, return a limit outcome, not an empty/exhaustive page |

The row numbers are proposed starting values for review. Byte caps and the whole
frame cap must be selected alongside protocol fields before implementation; the
activity 48 KiB cap is not a repair, aggregate, or frame budget. Wall-clock targets
are measured acceptance criteria, not enforced deadlines: bounded rows still
incur index navigation, disk I/O, and sorting. Review actual plans to exclude a
hidden full scan or sort before the cap, and do not use an event-loop timer as an
interruption mechanism.

This candidate deliberately refuses an exact result above admission limits.
Completeness on this baseline is root/session scoped, not filtered by the Usage
time range: `projectionScope` only accepts session/run constraints. A root above
the source/checkpoint cap can therefore reject Today and 7d as well as All.
Range-aware completeness would require a separate correctness design; it cannot
be obtained by simply applying the activity timestamp predicate to checkpoints.
This candidate is suitable only if product accepts that limited/unavailable state,
with an explicit explanation of which limit was reached. A narrower range helps
only range-scoped limits; manual retry helps only if relevant state changed. If
exact All results must remain available beyond that boundary, review an aggregate
projection or another architecture that can meet that availability requirement.
An interruption-capable execution design is an alternative only when bounded
failure is acceptable; interruption alone cannot guarantee exact All results.
Increasing a fixture limit
is not proof of bounded latency. The existing repair implementation also needs
attention: `model-call-ledger.ts:490-584` limits repaired runs/events but still
computes pending `COUNT` and checkpoint `SUM` over the full relevant relations.

### Minimal SQL feasibility example

For one legacy source, a candidate index is `(ts DESC, storage_key DESC)`. A
bounded admission probe and continuation seek can be expressed as:

```sql
-- $probe_limit is the remaining shared allowance plus one.
SELECT COUNT(*) FROM (
  SELECT ts FROM usage_llm_calls INDEXED BY candidate_usage_seek
  WHERE ts >= $from AND ts <= $to
  ORDER BY ts DESC, storage_key DESC LIMIT $probe_limit
);

-- Validate that the cursor belongs to the query and lies within $from/$to.
-- Its upper bound then replaces the first page's $to predicate.
SELECT ts, storage_key
FROM usage_llm_calls INDEXED BY candidate_usage_seek
WHERE ts >= $from AND (ts, storage_key) < ($cursor_ts, $cursor_key)
ORDER BY ts DESC, storage_key DESC LIMIT $page_lookahead;
```

The index name is illustrative. These queries prove neither multi-source
composition nor byte enforcement. The implementation must translate the global
source-qualified comparator correctly for each source. In particular, inspect
the plan with the exact predicates: keeping a redundant `ts <= $to` alongside
the tuple cursor can select the wider timestamp bound and scan the skipped
prefix. Equal timestamps and repeated display IDs belong in the probe fixture.
The PR carries the reproducible experiment and its evidence boundary; it is not
an end-to-end performance claim.

## Storage query interface

The candidate interface below illustrates the core contract and optional list
pagination together. The section parameter and individual breakdown/pricing page
fields are not fixed interface requirements; likun will determine the Storage
query boundary after scope confirmation. Wire names are also provisional:

```text
readUsageScreen(range, activityFilters, budget)
  -> screen(revision, resolvedRange, summary, provenance,
            providersPage, modelsPage, toolsPage, pricingPage, activityPage)
   | limit_exceeded

readUsagePage(query, section, cursor, expectedRevision, budget)
  -> page(revision, rows, nextCursor, hasMore, completeness)
   | revision_changed
   | limit_exceeded
```

Under the admission candidate, first-screen `limit_exceeded` contains no partial
totals. The renderer displays an explicit unavailable state, or keeps an already
visible screen marked stale; it never installs a partial replacement. Wire error
names remain provisional, but this outcome must be represented before approval.

`range` resolves once to concrete `from`/`to` timestamps, including a fixed upper
bound for All. The returned query identity binds the resolved range and activity
filters; continuation must not resolve a moving range again. Activity filters
apply to the activity table, while headline statistics and breakdowns continue
to describe the selected time range. This preserves that distinction in the UI.

Breakdown and pricing collections must have bounded output. Paging them is one
candidate, subject to scope confirmation; a large number of providers, models,
tools, or overrides must not turn the initial response into an unbounded array.
If selected, their continuation reads use the same revision check and are
requested by the user, not drained by a background loop. Exact summary
counts are statistical results; pagination uses `hasMore`, without a separate
full scan solely to compute a table's exact total or omitted count.

## Transaction and repair ordering

One candidate ordering admits at most one repair pass through the existing
Usage writer, using its existing run/event ceilings plus the admission and byte
checks above, and commits it before the initial screen read transaction. likun will determine the repair/read boundary
and how the existing repair authority participates. Repair is a write and must
not be hidden inside a read-only transaction. The screen read does not repeatedly repair until history is caught up.

Inside the read transaction, Storage reads the revision and all requested
projections, including the coverage/completeness state associated with that
revision. A repair result returned before the transaction is not sufficient
evidence that the transaction's data is complete: a new source event can commit
between repair and read. Durable checkpoint/source state must describe that
condition without an unbounded scan. Failure and incompleteness retain the
project's existing accounting semantics; they cannot silently become zero spend.

In this candidate ordering, page continuation performs no new repair pass.
Independently committed repair or source changes invalidate the expected revision when they affect the screen.
The read transaction ends before optional session-title hydration or transport
encoding. Metadata labels are presentation enrichment: only returned page IDs
are hydrated with bounded concurrency, and labels are outside the Usage revision.
If strict title consistency is required, that is a separate scope decision.

## Revision identity

One candidate is a root-scoped durable Usage change counter read alongside the
existing pricing revision, bound on the wire to the Host generation and a query
identity. It would be invalidation metadata, not a second collection of Usage
facts. The author proposes this conservative starting point for review; likun
may replace it with the cheapest correct revision identity and writer coverage.

If a counter is selected, it must advance in the same committed transaction as
any mutation that changes a screen result. Any selected mechanism must detect
relevant changes, including:

- canonical attempt insert/update/delete, including correction of an older row;
- legacy LLM and tool record insert/update/delete;
- repair checkpoint or unreadable-evidence changes affecting provenance;
- relevant source-event changes that make previously complete coverage pending;
- supported migration/rebuild operations that change query interpretation.

Pricing changes use the pricing owner's existing revision. Built-in pricing and
interpretation changes are fenced by Host generation/compatibility. Rollback
must roll back invalidation as well. No-op mutations need not invalidate.

Storage review must enumerate real writer paths, including cascade deletion
and repair, before choosing the revision mechanism. If a counter is selected,
write-admission updates and narrowly scoped SQLite triggers are alternatives
for likun to assess. A root-wide counter would be conservative: writes
outside the selected range may also invalidate it. Range-specific revisions are
not a prerequisite, but invalidation frequency must be measured under active use.

Neither `MAX(ts)`, row count, a random request ID, nor a full-table hash supplies
the required cheap, mutation-sensitive revision. Reconnect, Host replacement,
and a supported database restore must invalidate earlier tokens even if a
durable counter value repeats. Page tokens are validated as untrusted inputs;
an invalid token/query combination is `invalid_request`, not an empty page.

### Writer coverage to validate before selecting the counter

The baseline paths below are concrete audit inputs, not a claim that invalidation
is already implemented. Counter updates must be part of each originating write
transaction, never a later Host notification. Tests must call the real paths.

| Mutation / durable owner | Baseline path | Required invalidation and verification |
| --- | --- | --- |
| Legacy LLM and tool insert/upsert | `sqlite-usage-store.ts`: `insertLlmCall`, `insertToolInvocation`, `enqueueMutation` | Advance with stored changes, including older-row corrections; rollback leaves both row and counter unchanged |
| Canonical source event and high-water | `agent-run-store.ts`: `insertAgentRunEvent` updates `core_agent_runs.latest_model_call_sequence` | Invalidate pending coverage at source commit, even if subsequent Usage projection fails; watching only Usage tables misses this transition |
| Canonical row and repair checkpoint | `model-call-ledger.ts`: `catchUpProjection`, `writeModelCallAttempt`, checkpoint upsert | Advance atomically with repaired rows, applied-through sequence, and unreadable-event changes; exercise partial/failed repair |
| Session purge and cascades | `conversation-operational-state.ts`: `purge`; `sqlite-usage-schema.ts`: checkpoint foreign key | Invalidate changed coverage when runs/events/checkpoints disappear; preserve surviving Usage rows and all-time spend |
| Pricing overrides | `sqlite-usage-store.ts`: `SqlitePricingStore` mutation transaction | Read its existing revision in the screen transaction; do not add a second pricing owner or recompute historical cost |
| Migration / backfill / supported rebuild | `sqlite-usage-schema.ts`, `sqlite-core-execution-schema.ts` and any selected new migration | Update invalidation or rotate interpretation identity before read admission resumes; test interruption/resumption and old-token rejection |
| Database restore or replacement | Storage lifecycle plus Host/query fencing | A repeated numeric counter must not validate old tokens; require reconnect/generation rotation or an explicit database-incarnation fence |

The inspected baseline has no ordinary delete API for the three Usage fact tables;
Session purge deliberately leaves them intact. Do not invent a retention path
for this PR. Any newly introduced delete/correction path must be added to the
matrix and advance revision in its own transaction. AgentRun events are appended
on the baseline; migration or future in-place source corrections cannot be
covered merely by assuming the high-water always changes. Trigger selection
requires the same table/column inventory and cascade/restore tests.

### Lifecycle of candidate metadata

| Candidate | Owner and lifetime | Retirement / recovery |
| --- | --- | --- |
| Usage revision counter | Storage schema and existing mutation transactions; lives with the Usage database, not a reader/session | Removed with the database or an explicit schema migration; restore/recreation invalidates tokens even if its number repeats |
| Legacy/tool scalar columns, search normalization, byte measurements, and indexes | Storage schema; maintained with each corresponding source row | Follow source-row/schema lifecycle; resumable backfill reads retained original records and never deletes historical Usage to rebuild it |
| Backfill watermark | Schema migration owner; exists until all relevant rows satisfy the new read contract | Resume after failure; retire marker only after validation and writer maintenance are established; incomplete migration refuses dependent reads |

These lifetimes preserve current Usage retention. Root deletion/restore remains
with existing lifecycle authority; this proposal adds no independent cleanup
worker or competing root owner.

## Query projections and accounting semantics

Canonical model calls already have typed columns and SQL aggregate fragments in
`packages/storage/src/model-call-usage-sql.ts`, used by `model-call-ledger.ts`.
Reuse their token, status, price, and coverage rules. The existing generic bucket
grouping is not automatically the Settings screen's grouping contract.

Legacy LLM and tool tables still contain `record_json` with limited indexed
columns. The proposed direction is to maintain the narrow scalar columns needed
for filtering, aggregation, ordering, and a bounded display projection alongside
their existing records. Avoid routing screen reads through helpers that decode
every JSON record. Indexes, migration cost, and scalar-column ownership need
review before fixing the schema.

If schema changes are selected, any migration must preserve historical records.
Some Usage rows intentionally survive Session deletion and cannot be reconstructed by replaying surviving
AgentRun events. Any scalar backfill is an explicit, resumable migration with a
watermark and bounded batches, not work performed by clicking All. The migration
marker belongs to the schema owner and is retired there after completion. Query
admission while a backfill is incomplete must be explicit; it cannot return a
partial total as complete or fall back to an unbounded JSON traversal.

The logical model-call query composes legacy and canonical contributions using
the existing source-accounting rules. Legacy history remains additive; history
compaction still writes legacy records on this baseline. Do not assume the
canonical table replaces those facts, infer deduplication from display IDs, or
invent missing legacy usage/cost classifications.

SQL projections must preserve:

| Concern | Required result |
| --- | --- |
| Provider breakdown | Settings connection identity: `connectionSlug` with provider fallback; distinct configured connections remain distinct |
| Model breakdown | Preserve Settings model-key semantics unless a product change is agreed |
| Tool breakdown | Calls, success/error counts, and weighted duration average over the selected range |
| Token accounting | Existing cache-read clamping, cache-write, reasoning, and total-token rules |
| Costs | Missing/unpriced is distinct from priced zero; recorded costs are not retroactively recomputed from current pricing |
| Coverage | Canonical coverage, legacy contribution, unreadable records, and pending repair remain visible |
| Empty ranges | Empty pages and valid zero counts, with no invented complete/free-spend claim |

If group pagination is selected, aggregate over the composed scalar relation
before paginating groups. Taking each source's top groups independently and merging them can omit the true top
combined group. Use deterministic group ordering with a unique tie-breaker.

## Activity cursor and filters

The conceptual cursor is `(timestamp, stableUniqueKey)`, ordered newest first
with a deterministic tie-breaker. Existing legacy/tool indexes are `(ts DESC,
id)`, but `storage_key`, not the displayed `id`, is their primary key. Therefore
`(ts, id)` alone must not be assumed unique.

A proposed logical identity is `(source, storage_key)` for legacy/tool rows and
`(source, attempt_id)` for canonical rows. The cursor includes the timestamp and
that source-qualified identity. Storage can seek independently into each indexed
source and merge only bounded candidate pages. The physical index ordering must
match the comparator, including the tie direction; tests cover equal timestamps
and repeated display IDs across and within sources.

Preserve existing activity filtering in Storage before pagination unless product
explicitly approves a changed interaction. The query/index strategy remains for
likun to decide. Current activity search is a case-insensitive substring over
model/provider/tool names plus a status filter (`usage-settings-view.tsx:96-108`).
Normalize the search query with the existing JavaScript `trim().toLowerCase()`
and compare against lowercased field values. A SQL collation or `LOWER()` is not
automatically equivalent for non-ASCII text.
It must search the requested range, not only the visible page. Scalar columns
avoid JSON decoding, but an arbitrary substring is not made indexable by an
ordinary B-tree. Preserve the semantics with a bounded scan/time outcome, or
agree an appropriate search index before implementation; do not silently switch
to exact matching. Low-selectivity filters need their own query-plan evidence.

## Budgets and encoded size

Proposed starting limits reuse the existing activity ceiling of 100 items per
page and 48 KiB per activity page, with bounded text fields. Any selected
group/pricing pages and the complete screen envelope require separate explicit caps in the protocol;
multiple individually valid fragments must still fit the total frame budget.
These are output limits, not a claim that SQL execution is constant-time.

SQL selects scalar projections and a bounded number of candidate keys before
reading large payloads. A row's conservative byte bound includes UTF-8 content,
JSON escaping, field overhead, and optional enrichment. A bounded SQL prefix can
use those per-row bounds to stop before exceeding the page budget; it must not
calculate a running sum over the entire historical range just to choose a page.
Any supporting stored measurements must be updated with their source values.

Only selected projections enter application memory. Encode each normalized item
once and reuse its measurement for that value and boundary, reserving envelope
overhead and checking the final frame separately. An oversized item must produce
a defined bounded projection or `limit_exceeded`, never a silent omission or an
empty page that repeats the same cursor forever. `hasMore` can use a bounded
lookahead key rather than decoding the next large record.

## Host, IPC, and renderer behavior

The initial screen result is delivered through Desktop's existing `usage:summary`
IPC entry point. Runtime Host's Usage protocol gets an initial-screen query and
revision-checked page queries; preload and renderer services expose explicit
on-demand continuation. Operation names and codecs are finalized together.

Host retains no per-reader dataset between requests. It validates query/cursor
budgets and projects the Storage result. Desktop does not aggregate activity
rows, drain page cursors, or fetch all pricing/group pages behind the UI.

The renderer uses query tickets and Host-generation fencing for both initial
and continuation requests. An older range/filter response cannot overwrite the
newer selection. A Host change clears all prior data and navigation tokens.

On `revision_changed`, discard the pending continuation, mark the visible screen
as stale, and reload the first screen with a bounded automatic-refresh policy.
The retry count remains subject to product-scope confirmation; at most one
automatic reload per user action is a candidate, not a fixed requirement. Install
the complete new screen atomically. Do not append new rows to old statistics.
After the agreed retry budget is exhausted, a failed refresh retains an explicitly
stale screen with manual Refresh available; it never retries indefinitely.
Continuous writes may interrupt browsing, so that trade-off must be exercised under live activity.

The UI shows page counts or “more available” instead of presenting the currently
loaded row count as the historical total. Range/filter changes reset pagination.
If breakdown/pricing pagination is selected, its navigation is visible.
Navigation memory has a fixed bound and never grows with all visited activity rows.

## All-range performance contract

Application-side activity memory, payload decoding, and network output scale
with the page budget, not the number of historical calls. Additional pages must
seek from their cursor without an increasing offset-prefix read.

Exact all-time aggregates can still scan narrow indexed columns. SQL `GROUP BY`
may also sort many groups. The proposal does not promise constant-time All reads
or a fixed latency improvement without measurement. Query-plan and timing
evidence must inform likun's decision on the concrete scan/sort work boundaries
and enforcement mechanism under #4876. Bounded admission above is one concrete
candidate; no new interruption facility is mandated. The selected limits must
actually bound or interrupt the relevant work on the project's synchronous
SQLite setup; a timer that fires only after a blocking
query returns is not enforcement.

If exact aggregation cannot meet the agreed work/interactive budget, ask likun
to assess alternatives, such as an incrementally maintained aggregate projection
or an explicitly limited outcome, and confirm scope before implementing them.
Never present partial aggregate results as complete. No latency threshold is claimed as an existing project guarantee.

## Verification contract

Storage tests exercise the public screen/page interface selected in review with
real SQLite. Mechanism-specific cases are conditional on the confirmed scope:

- concurrent append, correction, delete, pricing update, and repair cannot mix
  revisions; rollback and no-op behavior match the selected revision contract;
- pending-source evidence and checkpoint changes report correct completeness;
- canonical, legacy, and tool fixtures retain the accounting semantics above;
- equal timestamps, duplicate display IDs, sparse filters, deleted rows, empty
  pages, and Unicode/oversized fields preserve ordering and cursor progress;
- if included, extra group/pricing pages remain bounded and revision-checked;
- if needed, migrations preserve history after Session deletion; any backfill
  resumes from a watermark.

Protocol/IPC tests cover correlation, malformed tokens, query/Host mismatch,
item/byte/envelope ceilings, typed failure paths, and old/new epoch rejection.
Renderer tests cover rapid range changes, A → B → A, delayed page replies,
filter changes, atomic refresh, and continuously changing revisions. The Runtime
Host compatibility epoch is raised above main when the wire implementation lands;
this design-only change does not reserve or bump an epoch.

Performance evidence uses deterministic 10k, 50k, and 250k mixed-source records,
high-cardinality breakdowns, preserved sparse filters, and a pending-repair
fixture. Record
cold/warm first-screen latency, aggregate versus activity SQL time, query plans,
decoded row counts, payload bytes, and Host/Desktop peak memory. Check first and
deep pages, local and delayed transport, and All under ongoing writes. Compare
with the same main baseline and fixture; do not substitute passing unit tests
for measured latency or claim a 50k-row test that was not run.

## Relevant implementation seams

- Storage ownership and transactions: `packages/storage/src/usage-stores.ts`.
- SQLite schema and legacy/tool queries: `sqlite-usage-schema.ts` and
  `sqlite-usage-store.ts` in that package.
- Canonical SQL rules: `model-call-ledger.ts` and `model-call-usage-sql.ts`.
- Accounting vocabulary: `packages/core/src/usage-ledger-merge.ts` and
  `packages/core/src/usage-stats/`.
- Host queries and codecs: `packages/runtime-host/src/server/usage-pricing-coordinator.ts`
  and `packages/runtime-host/src/protocol/usage-pricing.ts`.
- Desktop adaptation: `apps/desktop/src/main/runtime-host-usage-ipc-main.ts`,
  `runtime-host-client.ts`, preload contracts, and renderer Usage services/UI.
