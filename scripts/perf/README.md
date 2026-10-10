<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
-->

# Runtime SQLite VACUUM benchmark

Run `node scripts/perf/runtime-vacuum-benchmark.mjs 100 1024 3072`. It uses Node's built-in SQLite with WAL, creates incompressible 32 KiB rows, deletes one third to leave free pages, converts with `PRAGMA auto_vacuum=INCREMENTAL; VACUUM`, and includes connection close/checkpoint time. It then verifies `auto_vacuum = 2`, an empty freelist, and `integrity_check = 'ok'`.

This is a synthetic conversion-cost fixture, not a production database workload. It does not yet measure peak WAL size or platform-specific free-space requirements. Preserve the emitted JSON, including OS, Node and SQLite versions, with results.

## Current Windows run

Windows x64, Node v24.15.0, SQLite 3.51.3; rerun 2026-10-10:

| Fixture size | Source bytes before deletion | Conversion and close |
| ---: | ---: | ---: |
| 100 MiB | 106,504,192 | 1.384 s |
| 1,024 MiB | 1,090,572,288 | 16.397 s |
| 3,072 MiB | 3,271,692,288 | 64.150 s |

All three post-close checks passed (`auto_vacuum=2`, `freelist_count=0`, `integrity_check=ok`). Earlier pre-close WAL timings were 0.58 s, 10.73 s and 140.36 s; those are superseded. The 36.18 s 3 GiB figure was from the excluded DELETE-mode run and is not a WAL result.

Only Windows has been measured so far. The requested second-platform run is outstanding; a prior one-off benchmark workflow was removed from this repository. The corrected 1-to-3 GiB increase is still super-linear (16.397 s to 64.150 s); WAL/journal I/O, SQLite page-cache behavior, storage and antivirus scanning are plausible contributors, but this fixture does not isolate their individual contributions.

## Placement notes for issue #6000

- `runtime.sqlite` has one process-local owner connection; repositories borrow leases. A worker's second connection departs from that ownership model, and a Host-only gate cannot fence secondary processes using `require_current`.
- A worker thread keeps the event loop responsive and reads available where SQLite permits. It does not remove `VACUUM`'s write lock: concurrent writers still wait or hit the configured 5 s `SQLITE_BUSY` timeout.
- In WAL mode, reserve close to 3x the database size plus operational headroom until measured peak usage supports a tighter bound. The prior 2x estimate omitted WAL growth.
- Under WAL with `synchronous=FULL`, a crash before the VACUUM transaction commits discards the uncommitted conversion; the original database remains. Reopen and verify integrity.
- `VACUUM INTO` can build a staging copy while the live database stays available. Swap it on the next startup before listen; do not plan a live swap on Windows while handles are open. Maka already uses a private copy for context offload (`context-offload-snapshot.ts`).
- The smallest first implementation is to create new `runtime.sqlite` databases with `auto_vacuum=INCREMENTAL` before schema creation and WAL activation. No full VACUUM is required for new databases. Converting existing databases is a later, separate decision.

No placement recommendation is made until the required second-platform measurement and owner-process fencing design are settled. The full analysis and option-by-option effects belong in the #6000 issue discussion; this README only preserves the fixture and its caveats.
