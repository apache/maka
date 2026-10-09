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

# Runtime database one-time VACUUM placement (#6000)

**Status:** investigation for maintainer decision; no runtime behavior change is proposed here.

## Decision requested

Choose when and where the planned explicit `Compact database` request runs the one-time full `VACUUM` needed to convert an existing `runtime.sqlite` from `auto_vacuum=NONE` to `INCREMENTAL`. The action and protocol operation do not yet exist. The Host currently serves requests against the runtime database, uses a 5 s SQLite busy timeout, has a 75 s startup deadline, and expects clients to observe Host liveness within 8 s.

## Measurements

### Prior production-derived measurement from #5855

The #5855 review history reports a roughly 1 GiB runtime database taking about **55 s before listen**, and about **13 s per GiB when run synchronously after Ready**. The latter blocked the serving event loop long enough to exceed the 8 s client liveness timeout. Those measurements are the closest available production-shaped evidence; #5855’s merged scope removed runtime database compaction.

### Reproducible local fixture

The added harness, [`scripts/perf/runtime-vacuum-benchmark.mjs`](../../scripts/perf/runtime-vacuum-benchmark.mjs), uses Node's built-in SQLite in WAL mode, creates a `runtime_events(event_id, event_json)` table with incompressible 32 KiB payloads, deletes one third of rows to leave free pages, then measures `PRAGMA auto_vacuum=INCREMENTAL; VACUUM`. The synchronous call blocks its calling thread for the measured duration. This isolates SQLite's conversion cost; it does not model Maka event/query mix or filesystem-specific durability, and does not measure peak WAL growth. Times are wall clock and are not directly comparable to the #5855 production-derived numbers.

Windows 10 x64, AMD Ryzen AI 7 350, Node v24.15.0, SQLite 3.51.3; run on 2026-10-09:

| Fixture size | DB bytes before deletion | VACUUM conversion |
| ---: | ---: | ---: |
| 100 MiB | 106,504,192 | 0.58 s |
| 1,024 MiB | 1,090,572,288 | 10.73 s |
| 3,072 MiB | 3,271,692,288 | 140.36 s |

The previous DELETE-mode run measured 0.93 s, 10.17 s and 36.18 s at these sizes; it did not match production WAL mode and is excluded from the table. The synchronous duration directly indicates how long an event loop would be blocked. The current manual workflow uses `ubuntu-24.04` and `windows-latest`. Windows WAL-mode timings are now recorded; Ubuntu remains pending because GitHub will only dispatch the workflow after it exists on the fork's default branch. No cross-platform comparison is claimed yet.

## Placement options

| Option | Host writer / client effects | 75 s startup / 8 s liveness | Crash, power loss, insufficient disk |
| --- | --- | --- | --- |
| Worker thread, separate SQLite connection, after Ready | It is still a SQLite writer. WAL permits readers in ordinary cases, but the conversion must obtain write locks and may block/fail concurrent writers. The Host must fence/gate its own runtime writes for the operation and report the maintenance state; relying only on SQLite's 5 s busy timeout can make normal writes fail. Do not open a second writer without this Host-level admission. | Does not consume startup deadline. A worker keeps the Host event loop responsive, but liveness alone is not enough: user writes must have an explicit bounded wait or be refused as maintenance-busy while the conversion owns the writer gate. | Regular `VACUUM` uses SQLite's journaling/transaction mechanisms; document recovery as SQLite-managed and verify integrity on reopen. SQLite documents up to 2x database-size temporary space; WAL-mode peak usage must also account for the WAL and existing sidecars, so preflight must measure the complete database file set and reserve additional headroom. `SQLITE_FULL` keeps the user's request retryable; hard errors clear it and are surfaced. |
| Run only while no client is attached | “No client” is not equivalent to “no Host writer”: maintenance, scheduled work, cleanup, and reconnect can still write. Must gate new clients and drain existing sessions before starting. | After Ready avoids startup deadline, but clients can repeatedly reconnect or wait through a long maintenance window; a 1 GiB run is already longer than liveness if performed on the event loop. | Same SQLite recovery and free-space behavior as worker option. Restart must retain the explicit request; a crash may leave it pending for the next no-client window. |
| Before listen, with startup progress state | No attached clients, but migration/startup ownership still matters; the operation must run after any schema migrations and before serving writers. | At the reported 1 GiB / 55 s, it consumes most of the 75 s deadline. The 3 GiB fixture is 36 s on this Windows host, while the production-derived 1 GiB time is already high; large/slower disks can exceed startup deadline. Progress UI does not change the deadline. | Same SQLite recovery and disk requirements. A restart repeats or resumes only by rerunning VACUUM; persist the request across failure and show startup recovery state. |
| Report-only | No writer contention or data-change risk. Exposes freelist/reclaimable bytes and says compaction is unavailable/pending. | No effect on startup or liveness. | No VACUUM crash/disk risk, but reclaimable space is never returned and incremental vacuum cannot take effect on existing `NONE` databases. |

SQLite references: [`VACUUM`](https://www.sqlite.org/lang_vacuum.html) (temporary space can reach twice the database size; VACUUM can fail on locking and uses transaction machinery), [`auto_vacuum`](https://sqlite.org/pragma.html#pragma_auto_vacuum) (existing databases need VACUUM after changing from NONE), and [WAL concurrency](https://www.sqlite.org/wal.html) (one writer at a time and possible `SQLITE_BUSY`).

## Recommendation

Use an **after-Ready worker thread on a separate connection**, but treat it as a Host-wide writer maintenance transaction: durably record the explicit request first, close the Host's runtime-write admission gate, wait for current Host writes to drain, run conversion in the worker, reopen the gate in `finally`, and expose progress/status to clients. Bound the busy response and tell clients to retry rather than allowing the 5 s SQLite busy timeout to turn ordinary writes into surprising storage failures. Keep reads available where SQLite permits. Require a conservative free-space preflight for the complete database file set, including WAL, with reserved operational headroom; preserve a request on insufficient space and clear/report hard failures. Do not run automatically at startup or merely because no client is attached.

This recommendation keeps work outside the 75 s startup path and the event loop. The writer gate is essential: a worker thread by itself does not make SQLite's single-writer model disappear. If the Host cannot provide a correct writer gate with bounded client behavior, use report-only as the safe first release and defer conversion.

## Smallest first PR after placement is accepted

Add the planned explicit `Compact database` action and protocol request/status, persist the request, and implement database-file-set free-space preflight plus a Host-owned writer gate and worker-thread conversion. Keep it opt-in, make insufficient space retryable across restart, test cancellation/crash/reopen and concurrent write admission, and report progress/results. Claim the required compatibility epoch at merge time. Do not combine it with automatic compaction policy or background thresholds.

## Reproduce

```sh
node scripts/perf/runtime-vacuum-benchmark.mjs 100 1024 3072
```

The manual GitHub Actions workflow runs the same fixture on Ubuntu and Windows. Preserve the emitted JSON with each review so runtime/platform/SQLite versions remain attached to the timings.
