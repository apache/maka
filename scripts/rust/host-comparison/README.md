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

# Offline production Host comparison

This Linux harness compares a built TypeScript production Host with a built Rust
production Host. It uses public clients, real provider adapters, durable mutations,
and canonical history reads. The only model is a loopback SSE fixture with dummy
credentials. It does not measure GUI rendering, battery life, model quality, model
tokens, API cost, or a general advantage of one implementation language.

The TS adapter currently targets main commit
`0d19f242336a31e8aeb300372d3d3c896b1e99ef`. The initial Rust measurements use
`97405171ea8f10cfc0ec8ae469cfca559402ed90`. Record different revisions explicitly;
the public protocols may change. The current harness uses public
`host init --settings-stdin` and requires the CLI's settings-input forwarding fix.
The initial frozen campaign used its recorded worker-entry workaround during
untimed setup; retain that harness with those receipts. Production paths remain
unchanged by the harness.

## Build and run

Use the same machine without concurrent builds or other benchmark runs. Build the
production Rust CLI and `host_benchmark_client` example in release mode with the
same features and toolchain. Use the normal V8/bundle build environment:

```sh
cargo build --release -p maka-cli --bin maka --example host_benchmark_client
```

The TS checkout needs its locked dependencies, dependency patches, and built
`@maka/core`, `@maka/storage`, `@maka/mcp`, `@maka/runtime`,
`@maka/acp-executor-plugin`, `@maka/antigravity-acp-plugin`, and
`@maka/runtime-host` workspaces, in that order. Use a production-supported Node
version. The initial lab used Node 24.22.0; the source release pin was 24.18.1.
Build artifacts and installation are outside the measured interval.

Each run requires a new output directory under the OS account's accessible home
workspace. Do not change `HOME` to simulate a different account. The harness
sanitizes inherited model keys and proxy variables, configures only a local dummy
provider, and enables incognito initialization on both implementations. This
suppresses optional helpers while retaining production execution and persistence.
Explicit session names also suppress model-generated titles.

```sh
python3 scripts/rust/host-comparison/compare.py \
  --kind rust --rust-checkout /path/to/rust-checkout \
  --mode baseline --history-turns 100 --idle 10 \
  --output /home/me/host-results/rust-baseline-formal-1

python3 scripts/rust/host-comparison/compare.py \
  --kind ts --ts-checkout /path/to/ts-checkout \
  --mode background --agents 1000 --scopes 1 --lines 42 \
  --idle 10 --ramp-seconds 600 \
  --output /home/me/host-results/ts-background1000-capacity-1
```

Run at least five alternating Rust/TS pairs for comparative timing claims. A
single large-capacity probe is exploratory. Increasing `--agents` to 10000 tests
that requested target; the receipt determines how many sessions were created,
how many original executions were confirmed, and how many were actually active.
A configured observation deadline or the 4 GiB available-memory reserve is a lab
boundary, not a product capacity limit. Both are recorded. Do not silently
increase client scopes to bypass a product's per-connection limits.

`--mode smoke` checks a single live response, canonical history and process
reopen. `baseline` measures post-setup idle, a 1,048,570-byte live Unicode response,
a 100-turn history read (16,450 assistant bytes per turn), and process reopen plus
history read. History is seeded through the real provider before read timing.
Reopen uses the warm OS page cache; it is not cold disk startup.

`background` pipelines 16 admission commands by default, retains no UI session
subscriptions during generation, and accumulates actual provider connections at
a barrier. Each waiting stream emits one character every five seconds to keep
production stream watchdogs alive; these characters form part of the same fixed
response. The release emits the remaining text in 20 paced chunks. Admission
ramp durations change the number of persisted chunks: inspect `rampPrefixChars`
and `outputChunks`. This is a capacity scenario, not pure Host throughput.

After the provider streams drain, both implementations attach fresh read-only
observer scopes to the same original Host epoch. Sender scopes remain alive until
cleanup, preserving uncertain mutation custody. Observers query the original
execution identities and read canonical history; they never retry mutations or
restart the Host. Sender and observer counts and attachment time are recorded
separately. Provider drain means bytes were written, not that Host persistence
finished: retain Host CPU/memory/I/O during observer attachment and terminal
queries. These observations must not be reported as live completion latency.
The default one-scope scenario allows 120 seconds for observer attachment on
both sides. TS applies that handshake deadline per scope; Rust's whole-command
budget is 120 seconds multiplied by the number of scopes. Multi-scope runs must
report that deadline distinction. No failed mutation is retried.

`scale` instead retains live session subscriptions. Its scope/subscription limits
are real product behavior and must be distinguished from background execution
capacity. Do not compare its live terminal observations directly with the
background mode's later completion-query observations.

## Receipts and metrics

Every completed run preserves:

- `manifest.json`: source commit/status, artifact and harness hashes, command,
  options, runtime versions and measurement definitions.
- `metrics.jsonl`: flushed time series with monotonic and wall clocks. CPU ticks,
  RSS, swap, threads and file descriptors are sampled approximately every 200 ms;
  PSS, process I/O, cgroup counters and system counters are sampled about once per
  second. Sampling duration is itself recorded.
- `result.json`: phases, actual created/admitted/active/completed/verified counts,
  individual admission timings and identities, provider requests and hashes,
  exact text verification, every observed error, and cleanup receipts.
- Host/adapter stderr and the isolated durable root for further investigation.

The Host process tree, client adapter, and provider/controller are accounted for
separately. CPU 100% means one logical core. `/proc/<pid>/io` distinguishes logical
bytes (`rchar`, `wchar`) from storage-I/O accounting (`read_bytes`, `write_bytes`);
these counters are not a physical-device bandwidth measurement. RSS is not PSS.
Context switches from `/proc/<pid>/status` cover the main thread only. Cgroup
counters may include several benchmark processes. Whole-machine CPU, PSI, swap,
disk and network counters include unrelated system activity.

Sampling starts after setup and ends before cleanup. Restarted Hosts get a new
PID identity and cleanup handle. Raw samples preserve those boundaries; CPU
deltas across different process identities must not be subtracted. The provider
also records event-loop wake lateness and drain lateness to expose load-generator
saturation. Provider completion means bytes were written, not that the Host
confirmed completion.

A timed-out admission can still execute. Such requests are not counted as
confirmed admissions or completions. The harness verifies canonical output for
actual provider requests with missing admission replies separately, and also
separates confirmed admissions whose terminal query failed. A run passes only
when the full requested active concurrency is reached, every original execution
has confirmed completion, every canonical response matches exactly, and there
are no workload, provider, telemetry or cleanup errors. Inspect `passed`; a
normal process exit alone does not imply success.

```sh
python3 scripts/rust/host-comparison/summarize.py /home/me/host-results \
  --output /home/me/host-results/summary.json
```

The reducer requires `campaign-manifest.json` in the result directory (or an
explicit `--campaign /path/to/manifest.json`). Before running a campaign, record
`plannedRunIds`, an array of the exact output directory names, and
`harnessSha256`, a mapping of `compare.py`, `telemetry.py`, `ts-adapter.mjs`, and
`diagnostics.mjs` to
their SHA-256 hashes. Keep those files frozen throughout the campaign.

The reducer reads directories named `*-formal-*`, `*background1000-*`, or
`*background10000-*`. Only planned IDs with matching harness hashes enter formal
aggregates. Different source/artifact hashes, workload options, or runtime
environments form separate groups. Excluded runs and missing planned IDs remain
visible. It preserves failed runs and reports median/min/max for successful
formal rounds. A group is incomplete unless all five runs pass.
Retain the raw files alongside the summary. Do not discard timeouts or compare
partial completion time with successful completion of the full target.

## Interpretation and limits

Both initial implementations configure SQLite WAL/FULL, but they persist stream
text differently. Rust appends immutable observations and indexes; TS batches
nearby deltas and appends mutable text segments. Equal final Unicode bytes do not
imply equal intermediate writes or identical crash semantics. The Rust admission
path also holds an owner-wide lock across preparation, while TS admission is
serialized by session and its synchronous SQLite work runs on the Node event
loop. Use runtime profiles and I/O counters to explain measured behavior;
source inspection alone does not prove a bottleneck or a complexity bound.

The initial Rust CLI's finite-command observer discards initialization stdin.
Untimed setup invokes the same CLI's `--operation-worker host init` directly as a
workaround. Actual execution uses the ordinary `maka host serve` production
binary. This workaround is recorded here and must not be interpreted as a fix
to the public initialization command.

TS error receipts preserve the error name, message, code, request dispatch/retry
metadata, and a bounded causal chain. Cycles, unreadable properties and truncated
causes are marked explicitly. These diagnostics do not retry or reclassify any
operation. Earlier receipts that omitted causes remain inconclusive about the
underlying connection failure; do not infer a cause from the revised formatter.

Check the diagnostic encoder with:

```sh
node --test scripts/rust/host-comparison/diagnostics.test.mjs
```


The loopback provider accepts both Content-Length and chunked request bodies,
including chunk extensions and trailers. `requestBytes` and `requestSha256` refer
to decoded body bytes; `requestTransferEncoding` records the incoming framing.
Framing does not change the prompts, response chunks, pacing or completion checks.
Check the request parser without building either Host:

```sh
python3 -m unittest discover -s scripts/rust/host-comparison -p 'test_*.py'
```

See [profiling-plan.md](profiling-plan.md) for diagnostic quality gates and disk
protection before a capacity or long-state profiling campaign.
