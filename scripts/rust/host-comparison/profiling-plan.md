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

# Capacity and long-state profiling plan

This is a proposed diagnostic campaign, not an executable campaign or a timing
result. Do not run it alongside builds, formal measurements, or another campaign.
The retained R12 profile has mostly empty callchains; its SQLite leaf samples do
not identify which Rust operation caused the SQL work. A new profile must pass
unwinding checks before attributing a bottleneck to callers.

## Freeze inputs and preserve disk

The initial lab is `m4n5ter@192.168.124.16`. Preserve
`/home/m4n5ter/Work/capacity-r13-source` and
`/home/m4n5ter/Work/capacity-r13-20261025`, including unsuccessful runs. Never
modify frozen source, harnesses, binaries or old evidence in place. Use a separate
candidate checkout, explicit target directory and new output directory. Record
source status/diff, toolchain, dependency lockfile, harness and executable hashes,
CPU topology, kernel/perf versions, mount free bytes and measurement commands.
Preserve a production executable separately from any instrumented executable.

Before each build or run, inspect each filesystem containing source, target,
fixtures, temporary files and output. Use `statvfs.f_bavail * f_frsize` for space
available to the running account and `f_blocks * f_frsize` for total size. Require
strictly more than 10% available throughout. A preflight must additionally reserve
the projected build, fixture and recording growth above that floor; estimate from
existing target/fixture sizes and a short recorder pilot, not just current free
space. If growth cannot be bounded with existing evidence, start with a small
pilot. Do not launch a large build because the initial ratio barely passes.

A controller outside the owned workload process group should sample space every
second, append free bytes and active phase to a small flushed log, and stop its
owned build/recorder/workload group before the reserve is consumed. Set its stop
threshold above 10% by the maximum expected growth between checks plus shutdown
writes, as established by the pilot. Enforce a recorder byte budget as well as a
time budget. A stop is a failed diagnostic, retained with its reason. Preserve raw
profiles and fixtures; only explicitly identified generated caches/obsolete build
outputs may be cleaned after confirming no active process uses them. Never apply
recursive cleanup to source or result roots. Recheck space after cleanup and at
every phase boundary. Disk monitoring cannot guarantee the floor against unrelated
writers; identify other disk writers before launching and suspend work if their
growth makes the reserve unreliable.

## Unwinding pilot and acceptance

1. With the production executable, record one bounded representative CPU-active
   interval (initially 10 seconds at 49 Hz) using `cycles:u` and DWARF callchains.
   If hardware counters are unavailable, explicitly record `cpu-clock:u` as the
   substitute. Start with `--call-graph dwarf,32768`; preserve the exact perf
   command, stderr, data, build IDs, matching binaries/debug files and maps. Attach
   after Host readiness and cover its worker threads. Record actual PID/TID sample
   coverage; never combine controller/provider samples with Host samples.
2. Decode `perf script` and measure empty chains, unresolved frames, chains with
   fewer than two frames, lost samples and stack truncation. Inspect representative
   SQLite-heavy and Rust-heavy stacks against matching source and executable build
   IDs. Proposed diagnostic acceptance gates are at least 95% nonempty chains,
   at least 90% resolved user frames, no lost events and no material truncation;
   additionally require caller-bearing stacks in the hot SQL paths. These are lab
   evidence gates, not product limits. Report every fraction and sample count;
   insufficient samples require another bounded pilot before attribution.
3. If production DWARF fails, check unwind sections, debug-file/build-ID matching,
   sample stack truncation and mixed Rust/C frames. A larger DWARF stack is useful
   only when truncation explains the missing chains. Avoid blindly extending the
   duration of a broken recorder.
4. If needed, build a separate release diagnostic executable with debug information
   and `-C force-frame-pointers=yes`, retaining normal optimization. Force frame
   pointers for relevant native SQLite/C dependencies too, using their build
   system's supported flags. Use FP sampling only after checking cross-language
   unwinding; a Rust-only flag does not fix native dependency frames. This build
   has its own hash and is excluded from formal performance timing. If supported
   by the CPU/kernel/perf combination, test LBR as a separate pilot; document its
   shallow branch-history limit and do not assume it supplies full async ancestry.
5. Stop at a failed quality gate and use bounded operation instrumentation below
   if neither production DWARF nor the diagnostic build yields reliable callers.
   Even complete native stacks identify the currently executing task; they do not
   automatically reconstruct asynchronous request causality.

## Workloads and phase attribution

Capacity diagnostics keep the frozen `background` workload: one sender scope,
16 pipelined admissions, original response bytes/pacing, 600-second admission
budget and original completion/canonical verification. First use the smallest
previously successful target to validate recording overhead. Then observe the
1,000 and 10,000 requested targets separately, recording actual admitted/active
counts and failures. Sample bounded CPU-active windows in admission, release/drain
and observer attachment/query. Preserve phase clocks and original identities so
work after provider drain remains attributed to Host persistence/verification.
Also inspect provider event-loop lateness and controller CPU: driver saturation
invalidates an inference about Host capacity.

For long state, use `session_longevity::fixed_window_history` with one surviving
Root/Engine and cumulative `MAKA_LONGEVITY_H=1000,5000,10000`, fixed W/P and recorded
repetitions; compare P=0 with explicitly retained leases when testing retention.
Use `session_longevity::same_run_steps` separately for one long tool Run per
Session and actual automatic compaction. Fix W and steps across revisions.
Retain fixtures with `MAKA_LONGEVITY_RETAIN_FIXTURE=1`, then run
`session_longevity::retained_fixture_reopens` using the emitted retained record.
Check canonical tool dispatch/resolution counts, compaction/checkpoints and zero
errors. Do not substitute raw SQLite copies or a replacement writer for live
state. The existing sampling gate pauses tool progress while collection finishes,
including cancellation; its sampling pauses and SQL table scans are diagnostic
work. Exclude them from operation timing and from CPU-hotspot attribution using
phase boundaries, while retaining their cost separately. `sql_queue_backlog` is
currently null and must not be interpreted as a measured zero.

## Bounded fallback instrumentation

If stacks remain poor, add temporary instrumentation only in a separate diagnostic
checkout/build. Aggregate by a fixed operation name and phase; never retain a
per-request SQL trace or log bindings/text. Collect count, rows/bytes, wall time
and thread CPU time for connection acquisition/queue wait, SQL execute/step,
transaction commit, canonical history, prepared-build read/write/retire and
checkpoint/compaction. Distinguish wall waiting from on-CPU SQL execution.
Expose counts of in-flight/queued work with start/end balance and cancellation
accounting rather than guessing backlog from total duration. Use fixed-size
histogram buckets; flush aggregates outside the measured operation.

Use a separate short off-CPU diagnostic (scheduler switch/wakeup tracing, if
permitted) filtered to Host threads and a byte/time budget. Classify runnable
queue delay, futex/channel wait, filesystem/fsync wait and deliberate provider
barrier idle. Preserve permission/tool failures. For memory, compare RSS/PSS and
canonical/prepared/WAL file/table counts at the existing safe checkpoints; if
needed, use a separate sampled allocation profile with a fixed sampling rate and
stack-quality check. Report live bytes separately from cumulative allocations.
Do not combine on-CPU, off-CPU and allocation tracing into the initial pilot.

## Formal timing and interpretation

After diagnosis, rebuild normal production binaries and run at least five
alternating baseline/candidate pairs with frozen workload and no profiler or
temporary instrumentation. Keep every failure, actual completed work, hashes and
resource samples. Summarize medians and ranges only for complete comparable
campaigns. `benchmark-long-task.py` covers other retained operation-specific
release probes; it does not parse `MAKA_SESSION_LONGEVITY` receipts and must not
be silently reused as a longevity reducer. A longevity reducer must preserve
configuration fingerprints, H/W/P, errors, fixture verification and distinct raw,
sampling-pause and corrected operation intervals before making timing claims.

Accept a change only when matching workload receipts prove the work happened and
separate reliable diagnostics explain the limiting resource. An empty callgraph
or a SQLite leaf percentage alone does not justify a source-level optimization.
