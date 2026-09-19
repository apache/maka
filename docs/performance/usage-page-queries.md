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

# Usage activity query measurements

The activity query used to apply the cursor and `LIMIT 51` outside the complete
three-source projection. SQLite visited and projected the remaining time range
before selecting the page. Counts also reused that wide projection, and an empty
search ran the same predicates again for a page already known to be empty.

The optimized query seeks and limits each source before merging, counts only
filter fields, reuses complete statistics for unfiltered totals, and skips pages
with a zero count. It uses the existing indexes and screen protocol. Statistics
caching, search debounce and random-page navigation are separate work.

## Reproduce

Build Core and Storage at both revisions. From the optimized checkout, run:

```sh
MAKA_PERF_OUTPUT=/tmp/usage-pages-node node scripts/perf/usage-pages.mjs /path/to/built-baseline-checkout
```

On macOS, also exercise the shipped SQLite runtime:

```sh
ELECTRON_RUN_AS_NODE=1 MAKA_PERF_OUTPUT=/tmp/usage-pages-electron node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/perf/usage-pages.mjs /path/to/built-baseline-checkout
```

The harness calls the actual `readUsageScreen` facade at both revisions against
the same temporary database. It alternates before/after calls in one process,
performs three warm-ups and 15 measurements, and saves raw samples, median/p95,
environment, Git revisions, SQL and query plans. Instrumented search callback
counts run outside the timing loop. First-screen timings use reopened reader
connections, **not** a cold OS page cache. Fixtures are persisted directly into
the production schema; fixture insertion is not timed.

Deep-page requests use known fixture positions as valid cursors. This measures
the query after a cursor is available, not the UI's sequential deep-page walk.
Host projection repair, wire serialization, IPC/network and React are excluded.

## Results

Measured on 2026-09-20 against baseline
`0117d76c5688475e7467ee6db83057bf65edbabd` and optimized commit
`e39d80b11a636e57d5fc7eabffc53bcdcf8d4ec2`, with a clean tracked working tree.
Timings are milliseconds; each cell is
**median / p95**. These are synthetic local measurements, not production latency
guarantees.

| Runtime and fixture | Operation | Before | After |
| --- | --- | ---: | ---: |
| Node 24.14.0 / SQLite 3.51.2, 1,000 tools | Second page | 1.541 / 2.050 | 0.755 / 0.920 |
| Node, 10,000 tools | Second page | 10.871 / 12.588 | 0.693 / 0.900 |
| Node, 50,000 tools | Second page | 53.530 / 60.211 | 0.803 / 0.958 |
| Node, 50,000 mixed sources, equal timestamps | Second page | 65.755 / 68.261 | 1.066 / 1.198 |
| Node, 50,000 tools | Complete screen | 180.570 / 197.739 | 79.035 / 86.963 |
| Node, 50,000 mixed sources, equal timestamps | Complete screen | 308.340 / 363.471 | 180.352 / 194.375 |
| Electron 43.4.1 / SQLite 3.53.1, 50,000 tools | Second page | 59.392 / 76.300 | 0.853 / 1.128 |
| Electron, 50,000 mixed sources, equal timestamps | Second page | 70.243 / 73.507 | 1.153 / 1.284 |
| Electron, 50,000 tools | Complete screen | 195.282 / 203.461 | 88.037 / 100.974 |
| Electron, 50,000 mixed sources, equal timestamps | Complete screen | 314.361 / 345.219 | 187.128 / 207.477 |

On Node, matching second-page searches over 50,000 tools go from **99,900 to 51**
JavaScript lowercase calls; the mixed-source fixture goes from **99,900 to 153**.
No-match tool searches go from **300,000 to 150,000** calls because count zero
avoids the second scan. These count function evaluations, not physical row
visits. Exact counts and sparse substring searches still depend on history size.

The continuation plan now uses the source's composite index as a seek:

```text
SEARCH usage_tool_invocations USING INDEX usage_tool_invocations_screen
  (ts>? AND (ts,storage_key)<(?,?))
```

The outer sort may still use a temporary B-tree; its input is at most 153
matching candidates. Per-source filtering can inspect more than 51 index
entries. Full aggregates remain range scans, explaining why a complete screen
still costs substantially more than a continuation.

## Regression coverage

The Storage facade tests verify exact totals and all pages against an independent
fixture oracle across canonical, legacy and tool sources, equal timestamps,
Unicode identities, duplicate display IDs, inclusive range boundaries,
success/error/aborted status, Unicode lowercase expansion, literal `%`/`_`, and
unreadable/free/unpriced canonical rows. Existing WAL, rollback, revision and
restore tests still exercise the production reader.

Two deterministic work regressions fail on the baseline: a matching continuation
over 512 tied records performs 924 search folds, and a no-match screen over 120
tools performs 720. Their bounded-work assertions avoid hardware-sensitive
millisecond thresholds. Node and Electron both pass the optimized Usage suite.
