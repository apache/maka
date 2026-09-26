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

# Local Host checkpoint performance baseline

## Reproduce

```sh
npm run build:test
npm --workspace @maka/runtime-host run benchmark:checkpoint
# Harness validation only, not a baseline:
npm --workspace @maka/runtime-host run benchmark:checkpoint -- --smoke
```

The opt-in script exercises the real Host composition, selected Local provider,
SQLite exporter, Bundle codec and file Repository. It seeds settled turns through
Host admission with a zero-delay synthetic backend, plus deterministic SHA-256
block payloads (not highly compressible zero-filled files). No user Sessions,
credentials, model calls or externally writable workspaces are used. The fixture
Host disables outbound access using its own privacy policy. Windows fixture ACL
confirmation is not a deployable ACL authority or native Windows qualification.

| Profile | Settled turns (1 KiB prompt + reply) | Workspace | Artifact |
| --- | --- | --- | --- |
| small | 8 | 16 × 4 KiB | 64 KiB |
| many-files | 64 | 1,000 × 4 KiB | 2 MiB |
| large-payload | 128 | 8 × 8 MiB | 16 MiB |

Each profile has one discarded warmup fixture, five serial fresh-process timing
fixtures, and one separate resource fixture. Each fixture publishes `r1`, changes
a workspace file and publishes `r2`, then retries the same request and asserts
that it returns `r2` without capture/packing. All assert released cleanup and empty
staging/archive directories. OS caches are not flushed; this is a warm-cache local
baseline, not cold-disk, loaded-host, network or multi-Session performance.

## Measurement boundaries

- `providerFenceMs`: execution-store barrier registration through settlement,
  including draining earlier operations. This blocks writes across the selected
  root, not just the target Session. `admissionHeldMs` separately measures the
  target Session admission callback. Neither includes packing/publication.
- `workspaceFenceMs`: complete state/workspace private copy under the trusted
  sole-writer fixture boundary. `stateCopyMs` is the nested provider state export.
  These nested timings must not be added together.
- `packMs`: real codec packing; `objectPublishMs`: immutable Bundle/Manifest
  writes plus their internal digest verification; `createSessionMs`/`commitMs`:
  head publication including dependency verification and durable update.
  `checkoutCurrentMs` includes existing-head readability verification. Total
  latency additionally includes staging, receipt/journal I/O, cleanup and other
  verification. The recorded stages are not an exhaustive disjoint breakdown.
- RSS samples every 5 ms around publication are a lower bound. OS process RSS
  high-water is also reported before/after each operation; it includes startup
  and fixture generation (and prior operations in the same fixture), so it is not
  mislabeled checkpoint-only memory. Fresh
  processes prevent other profiles contaminating it; explicit GC before each
  attempt normalizes the heap, not the OS file cache.
- Resource-only runs scan the checkpoint directory every 20 ms after the previous
  scan, and at pack completion (private copy + archive coexist) and object
  publication. Logical bytes and `stat.blocks × 512` exclude duplicate hard links.
  These are observed high-water marks, not exact instantaneous volume allocation:
  scans are non-atomic and APFS clones/compression/metadata are not attributed.
  No disk scans run inside timing samples. Live input bytes and retained output
  bytes are separate. Existing checkpoints remain in the commit/replay baseline.

The fixtures include real Runtime ledger history and one Session Artifact. They
do not stress managed context-offload blobs, a large multi-Session catalog,
background contention, deep directory trees, crash cleanup backlog or remote
storage. This is a new opt-in capability with no prior Host publication path;
these are absolute costs, not a before/after regression comparison with PR1.

## Predeclared local investigation envelope

Before the full run (2026-09-23), use these coarse investigation thresholds for
these bounded fixtures, not product SLOs or a hardware-independent CI gate:

- Each publication finishes below the existing 60-second cooperative deadline.
- Every observed provider/admission fence stays below 5 seconds. A seconds-long
  root-wide pause still requires UX consideration; passing is not permission for
  automatic background publication.
- Fresh-process high-water RSS stays below 1 GiB and sampled publication RSS growth
  below 256 MiB for the at-most-80-MiB payload fixture.
- Additional observed checkpoint logical occupancy stays below three times live
  source bytes plus 16 MiB of metadata allowance. This is a conservative local
  capacity check, not a quota substitute or physical disk-space guarantee.

A threshold breach must be recorded and investigated, not hidden by changing the
fixture or silently raising the threshold. Small sample median/range/max are
reported; five samples do not establish p95/p99.

## Results

Measured on **2026-09-23**, Apple M5 / 16 GiB RAM / APFS SSD, macOS 26.6.2,
Node 24.18.0. Production revision: `6f9c9b60b62f2ee67ba4c8c9fca79a5c06981c28`. This follow-up
adds only measurement/docs and the Windows recovery path-filter correction;
it changes no production publication code. Final measurements follow a clean
`npm run rebuild` and completed static/release checks, with no other test/build
process intentionally run alongside the benchmark. Ambient desktop load was not
isolated. [Raw samples](session-checkpoint-baseline-2026-09-23.json) include the
harness SHA-256, environment and every timing/resource run.

Times below are milliseconds; each row uses five measured fixtures. The total
column is **median (min–max)**; fence columns are **median / max**.

| Profile / operation | End-to-end | Provider fence | Session admission held |
| --- | ---: | ---: | ---: |
| small / create | 161.3 (156.3–189.8) | 39.2 / 47.7 | 39.8 / 48.5 |
| small / commit | 130.7 (122.6–142.5) | 36.2 / 37.9 | 36.6 / 38.3 |
| many-files / create | 718.7 (684.9–1164.6) | 217.7 / 233.5 | 218.4 / 234.1 |
| many-files / commit | 629.7 (619.8–807.9) | 202.5 / 323.9 | 203.2 / 326.2 |
| large-payload / create | 897.2 (879.1–958.7) | 86.6 / 89.2 | 87.3 / 89.9 |
| large-payload / commit | 888.5 (860.2–1020.6) | 84.3 / 90.8 | 85.5 / 91.6 |

Nested/stage medians (do not sum the state and workspace columns):

| Profile / operation | State copy | Whole workspace fence | Pack | Object publish/verify | Head create/CAS | Read existing head |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| small / create | 22.5 | 38.0 | 19.7 | 17.4 | 9.2 | 0.1 |
| small / commit | 21.2 | 35.4 | 16.4 | 17.4 | 8.5 | 0.8 |
| many-files / create | 24.5 | 216.6 | 330.5 | 28.8 | 16.4 | 0.1 |
| many-files / commit | 23.4 | 201.4 | 302.3 | 26.1 | 17.2 | 3.3 |
| large-payload / create | 44.4 | 85.4 | 412.9 | 159.8 | 104.6 | 0.1 |
| large-payload / commit | 41.4 | 82.1 | 412.3 | 147.5 | 99.2 | 48.1 |

Same-request replay median / max: **small 1.2 / 1.2 ms**; **many-files 3.9 / 4.4 ms**; **large-payload 44.4 / 55.1 ms**.
Every replay returns the original r2 receipt with no snapshot fence or pack. It
still verifies retained object readability, so large-bundle retries are not O(1).

All sizes below are MiB (1,048,576 bytes). RSS columns are maxima across all timing
samples/operations; the disk columns come from the separate resource fixture.

| Profile | Process high-water RSS | Sampled publication RSS growth | Checkpoint disk peak create / commit | Retained after create / commit |
| --- | ---: | ---: | ---: | ---: |
| small | 349.73 | 8.97 | 2.40 / 2.56 | 1.15 / 1.31 |
| many-files | 472.66 | 49.61 | 14.58 / 20.56 | 6.98 / 12.96 |
| large-payload | 798.59 | 126.72 | 163.46 / 243.56 | 81.10 / 161.20 |

The high-water RSS is **the entire process**, not memory allocated by checkpointing.
For example, the large fixture already contains the imported Host and seeded
history/payloads before publication. The second disk peak includes the first
retained checkpoint; input data is additional (small approximately 4.16 MiB; many-files approximately 11.71 MiB; large-payload approximately 86.55 MiB
including SQLite/WAL). The raw resource samples also include allocated-block
estimates; neither number is an exact APFS physical-space guarantee. Peak fields
in `resourceMode: false` are not disk measurements; use only the resource fixture.

## Assessment

All measured attempts, including resource runs, stayed within the predeclared
investigation envelope. **This is not a zero-impact claim**: the largest observed
root-wide fence in the timing samples was 323.9 ms. A file-heavy workspace can block
writes longer than a much larger few-file workspace. Keep publication explicit
and off by default; do not convert it into a per-message background hook on this
evidence. The file-heavy first-publication total also ranged to 1.16 seconds;
retain this outlier rather than present only the fastest run.

Packing and repeated integrity I/O dominate outside the live fence for the large
payload. A second ~80-MiB checkpoint retains another full archive and peaks around
244 MiB under the checkpoint directory. Quota/capacity planning must include both
live input and retained archives; cleanup of temporary files does not reclaim
immutable historical objects. Retention/GC policy and incremental snapshots are
not implemented by this performance follow-up.

Before widening rollout, repeat on target Windows/Linux hardware and representative
real workloads (without publishing private payloads), then define deployment-specific
latency/capacity budgets. PR3 materialize/hydrate performance is a separate future
measurement; this PR does not implement writable restoration.
