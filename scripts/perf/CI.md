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

# Manual performance measurements

Refs #4677 and #5038. These two independent workflows collect baselines; they have no schedule or timing merge gate. Run **Performance frontend** or **Performance protocol** from Actions after the workflow exists on the default branch, selecting the desired ref. Download the `performance-*-<sha>` artifact and read the JSON alongside the job summary. Compare explicit commits with identical fixtures and environment; a shared-runner result alone is not a regression verdict.

Both lanes use the existing free `ubuntu-24.04` GitHub-hosted x64 runner, one measurement process at a time, Node 24.18.1 and `npm ci`. Electron is pinned by the repository (43.4.1 at introduction); Playwright/Chromium comes from the lockfile and browser install. JSON records actual OS, CPU, memory, Node and image version; browser results record the browser version. Runner hardware is not dedicated and its image can change. Reject comparisons across different environments and repeat suspicious results.

## Reproduce

From a clean checkout, run `npm ci`. For protocol, build core, storage, mcp, runtime and runtime-host in that order, then `node scripts/perf/protocol.mjs`. For frontend, run `npm --workspace @maka/desktop run build:workspace-deps`, `npm --workspace @maka/desktop run build`, `npm --workspace @maka/desktop run build-storybook` and `npx playwright install --with-deps chromium`. From `apps/desktop`, run `MAKA_PERF_OUTPUT="$PWD/../../perf-results" xvfb-run -a npx playwright test --config ../../scripts/perf/playwright.config.ts`. From the repository root run `xvfb-run -a node scripts/perf/storybook.mjs`. Use CI for standard measurements; local runs are for harness debugging.

Reports retain every raw sample. Median averages the two middle observations for even counts; p95 is nearest rank `ceil(0.95*n)`, so ten samples yield the maximum. Counts and one-off diagnostics have n=1 and are not latency distributions. Protocol timings use one discarded warmup and ten measured repetitions; encoding instrumentation is a separate pass and restores JSON.stringify in finally. It counts actual UTF-8 JSON output, including normalization/revision/decoder work, rather than estimated object size. The negative control calls the same production page builder an extra time and must increase measured encoding work. UTF-8 byte caps, decoded values and concatenated page completeness are asserted. This first lane covers Runtime Resource projection through final wire encoding; it does not measure SQLite, transport send, Memory/Plan/Artifact/catalog coordinators, Shell persistence, or Usage. Their implementations are unchanged.

Protocol `warm-projection-codec-ms` retains production wire decoding but excludes the byte-cap, equality and ordering assertions already run in the untimed baseline and negative-control passes. The cursor progress guard stays in the loop to fail on non-progress instead of hanging. This metric replaces `warm-ms (includes validation)`; do not compare their timings as a product speedup. Existing published reports retain their original metric and values.

## Frontend coverage and limits

- Electron with the real Host: existing 120-Turn fixture switching and older/latest navigation; normal fake backend output (9-character deltas every 45ms) while editing, two background Tasks emitting the same fixed response, then mid-stream Stop; DOM/heap samples after repeated navigation and an idle CPU profile. Each input sample asserts both background streams are still active; concatenated deltas and final output must be complete. Background-read drafts contain 680 characters; submitting the retained final draft proves the input reached application state. Stop must leave a proper output prefix and no subsequent delta.
- Storybook in Chromium: existing oversized-Turn generator extended to 45 tools, verified expansion and collapse, relative upward scrolling with explicit reading-anchor displacement. This is a simulated shell, not Electron/Host coverage.
- Every operation checks its consumer state: selected session, target Turn, draft focus/text, output markers or disclosed tool result. Failures fail the job; an empty run is not accepted. DOM click/input events and the existing preload admission seam drive actions. Native mouse/keyboard replay is not used. Programmatic scrolling does not establish native wheel or accessibility acceptance.
- DOM-ready latency includes Playwright polling/IPC. Stream lag starts at renderer subscription delivery and ends at DOM mutation; neither is proof of pixels presented. These are laboratory measurements, not whole-page INP. Long tasks and CPU TaskDuration do not substitute for anchor geometry, energy watts or OS wakeups.
- Repeated actions use a warm process. First-action samples are labelled separately, not called cold application startup. Storybook reloads for cold-scroll trials, then repeats expansion and closure in the same mounted story. Heap readings include garbage awaiting collection and do not establish a leak by themselves. Idle retains ten approximately one-second CPU/heap samples and the CPU profile; task duration is normalized by the actual CDP timestamp interval. Browser-context traces retain DOM snapshots, and their overhead is included in the laboratory timings. Long-task/LoAF rows labelled case-total include every operation after observer installation in that case. Actual disk-cold startup, RTT injection, physical presentation, wakeups and long-duration leak acceptance remain outside this first harness.

## Validating a new workflow before merge

GitHub cannot dispatch a new workflow absent from the default branch. For this PR only, temporarily add `push: { branches: [<this PR branch>] }` to these workflows, push and inspect both jobs/artifacts. Remove that trigger after verification. Do not merge to obtain a run, add `pull_request_target`, or leave a permanent automatic trigger. Record both the measured SHA and final SHA in the PR when the sole subsequent change removes the validation trigger.
