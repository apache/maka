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

# Desktop onboarding Session changes

Issue: [#5619](https://github.com/apache/maka/issues/5619)

Source baseline: `bc0786ee61219025ce89d9d7d4271bf7ce81edaa`. The PR is
rebased on `c7d205a42`. Measurements below used Node 22.22.2 and Electron
43.4.1 on macOS. The synthetic run preceded the final rebase; the Electron
run was repeated after it.

## Contract

An initial or global onboarding read remains a complete, authenticated Owner
snapshot. A subsequent identified Session event updates only that Session's
send projection. First and last history transitions use the same Core onboarding
rule as full reads. A failed targeted read leaves the last accepted projection
in place until a complete recovery read succeeds. Unknown authority, a changed
Host epoch, missing initial coverage, or a failed targeted read requests a
complete resync.

| Rule or state | Authority module | Interface / seam | Callers | Evidence |
| --- | --- | --- | --- | --- |
| Session existence and fields | Owning Runtime Host catalog | `session.catalog.query(get)` | Main onboarding service | Main targeted-read test; Electron bridge measurement |
| Readiness and history result | `@maka/core` onboarding and send projection | `deriveOnboardingState(hasHistory)` and `projectSessionSendOutcome` | Main onboarding service | Core and Main owner tests |
| Per-Host readiness inputs and milestone backfill | Desktop Main onboarding service | `getSnapshot`, `getSessionUpdate`, `setMilestone` | Preload | Main first/last, credential, and late-result tests |
| Owner/Guest scope, epoch, and multi-Host outcome merge | Desktop preload | `window.maka.onboarding` bridge | Renderer adapter | Preload multi-Owner, Guest, failure, and epoch seam tests |
| Sidebar rows and catalog coverage | Existing Desktop Session catalog refresher | `beginSeed`, `refresh`, `admit`, `evict` | Preload and Renderer catalog | Existing catalog seed and coverage tests |
| Invalidation order and 64-ID bound | Renderer onboarding poller | `pull`, `pullSession`, `dispose` | Onboarding React hook | Poller coalescing, overflow, and disposal tests |
| Desktop event subscriptions | Renderer Desktop platform adapter | `desktopOnboardingSnapshotDeps` | Onboarding React hook | Renderer-to-preload event seam test |

## Reads and updates

The initial preload read asks each ready Owner Host for its full onboarding
snapshot. It retains the existing authenticated catalog seed and independent
catalog refresh. Main records the observed Session IDs and connection readiness
inputs for each Host. A named change asks only the owning Host for that Session.
Main changes membership of one ID, calls the existing Core projection, and
returns one outcome plus the Host's onboarding state and milestones. Preload
accepts the answer only while that Owner profile and epoch remain current,
then marks whether the Host is the current default. It keeps the last accepted
outcome map for a temporarily failing Owner and fences a late full read against
a newer targeted update. Renderer applies the one
outcome and, for the default Host, its state and milestones. Guest changes do
not change Owner onboarding.

Connection, profile, unknown-Session, and manual invalidations request a full
snapshot. Main serializes complete reads, targeted reads, and milestone writes
per Host so each targeted projection uses the latest accepted full-read inputs.
Renderer serializes reads, coalesces repeated invalidations,
and bounds the pending set at 64 distinct Session IDs before falling back to
one complete resync. It never publishes a response after disposal. A failed
targeted read preserves the previous snapshot, exposes the existing generalized
error, and schedules a complete resync. A failed complete read still preserves
the previous snapshot and exposes the error.

## Performance and limits

The steady named onboarding path performs one Host catalog `get` and transfers
one send outcome. The ordinary Session catalog has its own subscriber and may
also read that row for the same event; the one-`get` figures below measure the
onboarding path, not total Desktop requests. The onboarding path performs no
Host catalog list-page request and never serializes the all-Session outcome map
across IPC. Bootstrap and genuinely global changes may still read all pages.
The Renderer currently stores outcomes in a plain record;
replacing a changed property copies that record. Unchanged high-frequency
outcomes return the same record. The sidebar's existing stale-badge selector
still scales with visible Session count when the record changes. Making that
local render work constant would require a separate state ownership change.
`node apps/desktop/scripts/measure-onboarding-session-update.mjs --renderer-copy`
measured 200 changed-outcome copies after warm-up. With 5,000 outcomes, the
record copy took 0.50 ms median and 0.62 ms p95 on this machine. The 100 and
1,000 row medians were below the clock's useful resolution. This excludes
React rendering and the existing stale-badge selector.

## Verification

Owner-service tests cover first/last history, milestone backfill, targeted
projection parity, failed reads, and ordering of full reads, targeted reads,
and milestone writes. Preload seam tests
cover Owner/Guest routing and epoch replacement. The Renderer poller tests
cover coalescing, late responses, and targeted versus global invalidation.
The performance fixture records Host list/get counts, IPC bytes, and latency
for 100, 1,000, and 5,000 Sessions under identical before/after inputs.

### Synthetic single-change baseline

Run `npm run build && node apps/desktop/scripts/measure-onboarding-session-update.mjs`
from the repository root. The "before" path invokes the retained complete
snapshot operation used by the previous Renderer invalidation. The "after"
path invokes the new targeted operation after the same bootstrap. On Node
22.22.2 with a fake 32-row Host catalog, seven samples per case at artificial
30 ms transport RTT produced:

| Sessions | Full snapshot median / p95 | Targeted median / p95 | Full list pages | Targeted gets | Full / targeted IPC bytes |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 100 | 127.72 / 129.35 ms | 32.21 / 32.25 ms | 4 | 1 | 13,871 / 138 |
| 1,000 | 1,019.58 / 1,031.75 ms | 32.12 / 32.56 ms | 32 | 1 | 138,971 / 138 |
| 5,000 | 4,997.34 / 5,011.30 ms | 32.11 / 32.30 ms | 157 | 1 | 702,971 / 138 |

The fake Host bytes were 10,926 / 135, 109,806 / 136, and 553,431 / 137
for full / targeted responses at those sizes. `IPC bytes` are JSON-encoded
payload estimates; Electron structured-clone bytes were not measured.
Zero-RTT local medians in the same run were 0.03 / 0,
0.60 / 0, and 1.43 / 0 ms. These sub-millisecond targeted values are
below useful stopwatch resolution and are reported as request/byte evidence,
not a precise CPU speedup.

### Electron bridge measurements

`apps/desktop/perf/onboarding-session-update.spec.ts` seeds a throwaway real
workspace, launches Electron, and measures five complete and five targeted
bridge reads in the same window. Run it from `apps/desktop` with
`npx playwright test perf/onboarding-session-update.spec.ts --config perf/playwright.config.ts --trace on`.
On the same machine, the traced run produced:

| Sessions | Complete median / p95 | Targeted median / p95 | Complete / targeted JSON bytes |
| ---: | ---: | ---: | ---: |
| 100 | 7.6 / 9.2 ms | 0.5 / 1.0 ms | 97,992 / 419 |
| 1,000 | 46.5 / 51.2 ms | 0.5 / 2.3 ms | 968,292 / 419 |
| 5,000 | 197.1 / 214.2 ms | 0.5 / 1.2 ms | 4,840,292 / 419 |

These are bridge read timings, not user-interaction or end-to-end paint
timings. The large-session first paint remains outside this change. They have
no injected network latency; the synthetic run above measures that case.

With `--burst`, the synthetic script gives the existing poller eleven rapid
notifications for the same Session. The poller coalesces them into two reads.
At 30 ms RTT, five samples per size yielded:

| Sessions | Complete burst median / p95 | Targeted burst median / p95 | List pages / targeted gets | Complete / targeted JSON bytes |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 255.19 / 256.41 ms | 63.94 / 64.33 ms | 8 / 2 | 27,742 / 276 |
| 1,000 | 2,043.08 / 2,055.72 ms | 63.62 / 64.30 ms | 64 / 2 | 277,942 / 276 |
| 5,000 | 10,003.45 / 10,009.98 ms | 64.27 / 64.34 ms | 314 / 2 | 1,405,942 / 276 |
