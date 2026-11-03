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

# Native history checkpoint baseline

Measured 2026-11-02 on Apple M5 / 16 GiB RAM / macOS 26.6.2 / Rust 1.99.1. Source base: `rust-preview@44c626fc5`, with this PR's Host adapter. These are unoptimized development-build measurements, not a production SLA or a before/after comparison against the base branch. No concurrent build was running; ordinary desktop applications remained active.

The [manual benchmark](src/owner/tests/checkpoints/benchmark.rs) creates a private real Root and Host, generates completed turns through the Agent service and a controlled local HTTP model, then publishes through Host mutation admission. The large case uses the same native Artifact storage path via attachment upload; it does not model a large external tool process. Each case ran in three fresh processes. Tables show medians, not percentiles.

| Source | Bundle MiB | Publish ms | First read frame ms | Complete read ms | Message admission before / during publish ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 completed turn | 0.012 | 390.7 | 92.9 | 93.2 | 79.9 / 178.5 |
| 1 turn + 32 MiB Artifact | 32.013 | 4585.4 | 248.3 | 630.1 | 71.2 / 148.1 |
| 64 completed turns | 0.718 | 1297.3 | 95.0 | 107.8 | 101.5 / 243.4 |

The message probe belongs to the source's same physical database partition. It runs concurrently with publication, and measures admission, not full inference completion. The measurements show contention; explicit publication is not free. Automatic triggering needs its own scheduling and workload evaluation.

| Source | Publish RSS baseline / sampled peak MiB | Read RSS baseline / sampled peak MiB | Root file growth MiB | Checkpoint objects MiB | Runtime WAL file growth MiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 completed turn | 165.09 / 172.47 | 172.52 / 172.84 | 0.877 | 0.013 | 0.817 |
| 1 turn + 32 MiB Artifact | 326.77 / 338.14 | 337.83 / 338.22 | 32.084 | 32.014 | 0.039 |
| 64 completed turns | 139.05 / 148.53 | 148.30 / 148.84 | 0.786 | 0.719 | 0.024 |

RSS is whole-process resident memory sampled with `ps` every 50 ms and at phase boundaries. It includes SQLite, V8, retained fixture allocations and allocator caches, and can miss short peaks. The receive loop hashes and discards each chunk rather than assembling the bundle. All samples used chunks no larger than 32 KiB; the Host also bounds its emitter queue. This does not imply constant total memory for arbitrary inventories or history validation.

Root/WAL figures are logical file lengths around publication, including the concurrent probe's writes. WAL reuse and automatic checkpointing affect the deltas; these are not write-amplification measurements. The 32 MiB payload adds approximately another 32 MiB of persistent checkpoint material. Immutable objects currently have no automatic retention/GC.

`EventLog::export_bundle` holds its SQLite read transaction through inventory/closure capture and bundle writing, then rolls it back before semantic validation and Head publication. Publish duration is an upper bound on that read-transaction lifetime, not a separately instrumented transaction duration. The same-partition probe and WAL observations expose some of its costs. Exact checkout verifies the object before its first frame; subsequent network backpressure holds a file reader, not the live SQLite snapshot. A larger sustained-write workload remains necessary to characterize worst-case WAL retention.

Reproduce each of `small`, `artifact`, and `long` three times after building, without other builds running:

```sh
MAKA_CHECKPOINT_BENCH_CASE=small cargo test -p maka-agent-native --locked \
  owner::tests::checkpoints::benchmark::history_checkpoint_baseline \
  -- --exact --ignored --nocapture
```

Each run prints one `CHECKPOINT_BASELINE` JSON record containing raw timing, memory and before/after file sizes. The benchmark is ignored in normal CI and has no timing assertions. Functional cancellation, corruption, original-receipt recovery and exact-byte decoding are covered separately by the normal Host tests.
