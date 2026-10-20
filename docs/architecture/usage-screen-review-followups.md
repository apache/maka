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

# Settings Usage review follow-ups

This draft tracks the quality findings from the review of [#5387](https://github.com/apache/maka/pull/5387).
That PR establishes the central correctness contract: a Settings Usage screen
installs a complete revision-consistent result, or installs nothing. The
implementation reviewed at `e4c4abe48` was approved with two normal-path P2
findings explicitly allowed as follow-ups and several smaller P3 findings.
The later P2 fix commits were removed from #5387 so the approved implementation
could merge with current `main` as a focused consistency change. The
[review](https://github.com/apache/maka/pull/5387#pullrequestreview-5223387629)
and [follow-up framing](https://github.com/apache/maka/pull/5387#issuecomment-5698633094)
are the source of this list.

This document began as the scope for a draft follow-up PR. The implementation
now closes the code findings below while preserving the complete-or-no-install
contract. Measurement-only findings record their evidence and decision here.

## Normal-path P2 findings

1. **A text edit starts a complete screen read.** The filter formerly applied
   locally; #5387 makes each change request Host projection catch-up, range-wide
   aggregates, grouped breakdowns, filtered count, and the first activity page.
   Renderer tickets prevent stale installation but do not cancel the Host work.
   Choose an input trigger that matches this cost, such as a short debounce or
   commit-on-enter. Cover rapid edits, explicit Refresh, range and Host changes,
   and unmount without losing the final query or changing its fixed time bounds.

2. **A stale result blocks cached navigation.** If a retained result has an
   unseen continuation cursor, the current stale/error guard disables the whole
   Pagination control, including pages already held locally. The guard should
   refuse only destinations beyond the loaded page count. Verify numbered and
   Previous/Next navigation after revision change, capacity failure, and a
   failed filter change, with no new Host request for cached pages. If this
   requires a dependency patch, test the package's source-condition build as
   well as its distributed JavaScript and declarations. The later
   [source-condition review](https://github.com/apache/maka/pull/5387#discussion_r4026932460)
   applies to the removed patch, not to #5387's retained implementation.

## Boundary-contract P3 findings

- **Search limit:** Protocol decoding accepts at most 1,024 UTF-8 bytes while
  Storage validates at most 1,024 JavaScript characters. A multibyte search
  can pass one boundary and fail at the other. Give this field one owned limit
  and validator, then test multibyte values on either side of the boundary.
- **Timestamp and cursor:** Writers accept finite non-negative timestamps while
  continuation decoding requires a safe integer. A fractional stored timestamp
  can produce a first-page cursor that the next request rejects. Align the
  writer and cursor domains, including treatment of existing stored values,
  and exercise an actual two-page read at the boundary.

These are examples of the same problem: separate layers currently declare
different rules for one field. A UI-only clamp or cursor-only exception would
leave the other entry points inconsistent.

## Lifecycle, scale, and API P3 findings

| Finding | Follow-up evidence or decision |
| --- | --- |
| `session_metadata` INSERT/DELETE always bumps the Usage revision, even for a Session without Usage rows | Measure reload churn first. If material, narrow invalidation while retaining rename, deletion, cascade, and rollback coverage. |
| `readUsageScreen` does not join the store drain barrier | A read admitted before close must settle before resources close, or return a typed draining outcome; test the race. |
| A deep numbered-page jump walks every intervening page through sequential Host reads | Measure large-history latency and give the user progress feedback; decide separately whether a different paging contract is warranted. |
| Capacity feedback checks whether an error string contains `screen_response_too_large` | Carry and render the typed failure kind. |
| `useUsageStats` returns an unused `displayedRange` | Remove the dead field if no consumer appears. |
| The `usage:activity` IPC handler does not validate the request kind before dispatch | Reject a `screen` request at the activity boundary. |
| The retained-capacity Story checks its notice and disabled continuation but not retained totals or rows | Assert visible retained data in the Story. |
| The Desktop bridge overloads `usageStats(range | ActivityRequest, host?, query?)` | Give activity continuation a distinct bridge method if it simplifies the public contract without changing behavior. |

## Implementation outcome

- Free-text edits now wait 250 ms at the renderer query seam. Mount, Host,
  range, status, and Refresh semantics remain immediate, and Refresh consumes a
  pending edit. Equivalent whitespace/case-only edits retain the loaded screen
  and any in-progress page walk.
- Continuation fences apply only to unloaded pages. A feature-local paginator
  keeps cached pages available without changing or patching the upstream Astryx
  component.
- Protocol and Storage share the 1,024 UTF-8-byte search domain. Persisted
  timestamps, query bounds, decoded activity rows, and continuation cursors
  share a finite, nonnegative, JSON-round-trippable number domain, including
  fractional timestamps. The widened wire domain advances the Runtime Host
  compatibility epoch to 172.
- Accepted screen reads participate in reader and writer close barriers without
  turning a read failure into a close failure.
- Capacity remains a typed domain failure through the renderer. The activity
  IPC boundary decodes and rejects the wrong request kind before Host dispatch.
  The existing bridge overload remains because splitting it would add bridge
  debt to the legacy Settings surface rather than simplify that seam.
- `displayedRange` and its now-unused snapshot field were removed. The retained
  capacity Story asserts the original total and activity row as well as the
  notice and continuation fence.

### Measurement decisions

The metadata trigger test exercises 100 Sessions with no Usage activity. The
old unconditional INSERT/DELETE triggers advanced the Usage revision 200 times;
the narrowed indexed predicates advance it zero times. Legacy model rows, tool
rows, canonical model-call rows, title deletion, and rollback remain covered,
so the churn reduction is material and was implemented.
The existing `(session_id, ts DESC, id)` index also serves the metadata
predicate; the redundant Session-only index is removed on migration.

A numbered jump remains linear in the target page because each keyset token is
issued by the preceding page. With the 50-row page size, a 10,000-row history
jump from page 1 to page 200 requires 199 serialized Host reads. Network latency
alone therefore has lower bounds of 1.99 seconds at 10 ms RTT and 9.95 seconds
at 50 ms RTT, before query work. The renderer now exposes page-by-page progress
and keeps already cached pages usable during that walk.

This PR deliberately does not add an offset request. A direct random-page
contract would also require a sparse page cache instead of the current
contiguous `UsageStats.logs` seam; adding only offset would either download the
same intermediate rows or install holes into a contract that currently promises
complete local pages. Preserve keyset correctness here and treat sparse random
access as a separate contract change if product evidence shows that deep jumps
are common enough to justify that larger model.

## Verification before marking the draft ready

- Preserve #5387's complete-or-no-install invariant, revision-bound
  continuations, and same-Host retained-result behavior.
- Cover the two P2 interactions in Desktop tests and in the production Settings
  Story where applicable.
- Test shared validation across protocol and Storage with Unicode search and
  fractional timestamp cases.
- Record large-history measurements before making a performance claim.
- Run the affected build, typecheck, lint, format, ASF header, architecture,
  and test gates on the implementation commits.
