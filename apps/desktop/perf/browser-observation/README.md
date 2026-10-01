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

# Browser observation regression and measurement

## What changed

- `browser_snapshot` defaults to a bounded list of rendered controls and headings. `selector` scopes a unique form/dialog, and `maxElements` limits candidates. Closed menus, CSS-hidden controls and hidden input identifiers are excluded. `display:contents` descendants and children overriding inherited visibility remain observable.
- `browser_inspect` reports exact CSS match counts, rendered-match counts, candidate names, attributes, enabled state and actionable CSS references. References persist across observations of the same node, but not navigation/reload or replacement nodes.
- Ambiguous CSS click/type requests return candidates without clicking, filling or pressing Enter. Markdown extraction refuses ambiguous regions rather than silently reading the first match, and includes recovery candidates.
- Observation uses the existing BrowserSession visibility and Origin-lease admission. No input values are returned. Element scans and output are bounded; incomplete counts are explicitly marked.
- `source: "opencli"` preserves a capped legacy snapshot for OpenCLI's supported shadow/iframe observations. It cannot be combined with scoped visible-snapshot arguments. OpenCLI itself is unchanged.

Rendered visibility is distinct from viewport visibility: offscreen rendered controls may be returned and OpenCLI can scroll to them. The structured observer covers the current document; it does not pierce shadow roots or iframe documents. Use the explicit legacy mode when those observations are required.

## Reproduce

From the repository root, with workspace dependencies prepared:

```sh
npm --workspace @maka/desktop run build:test
npm --workspace @maka/desktop run typecheck
npm --workspace @maka/desktop run test:dist
BROWSER_MEASURE_TRIALS=30 npm --workspace @maka/desktop run measure:browser-observation
```

The measurement defaults to system Chrome. Use `BROWSER_CHANNEL=chromium` with an installed Playwright Chromium. `BROWSER_MEASURE_OUTPUT=/path/to/result.json` optionally saves machine-readable results. `BROWSER_BASELINE_REF` overrides the baseline Git revision; the default is `4c79e3910e106c3af589ffb429143dd4de47d7d3`.

## Method

The browser only accesses a locally fulfilled `https://fixture.test` page. There are no GitHub requests, cookies, credentials, real submissions or LLM calls.

Both versions run their production tool implementations, the shared BrowserSession wrapper, and the **same unchanged OpenCLI BasePage** over a real Chromium/Playwright evaluation transport. The baseline tool source is read from the pinned Git revision and transpiled into a temporary, ignored build file. The view Host/bridge are fixture adapters, so approval UI and cross-process Client Capability transport are not timed.

The fixture contains 2,000 links in CSS-hidden/closed repository menus, a PR form, five matching submit buttons (one rendered), title/body fields, a preview, and a draft/ready selection menu. The baseline workflow deterministically replays classes of failed selectors observed in the earlier PR session. It is **not the optimal possible old-tool workflow**. The new workflow chooses fields/menu options by observed accessible names and returned refs, not guessed field IDs. Both workflows must fill the same values, choose ready-for-review and submit exactly once.

One warm-up per version precedes 30 measured runs per version. Order alternates to reduce scheduling/cache bias. Reported values are medians. Snapshot/output sizes are raw tool-response bytes, **not model token counts**; Runtime Host tool-result archiving is not part of this benchmark.

## Recorded result

Environment: macOS, Node `v24.18.1`, Chrome `154.0.8037.58`, OpenCLI `1.8.8`, viewport `960×720`. Baseline: `4c79e3910e106c3af589ffb429143dd4de47d7d3`.

Both initial snapshots observe the whole document: old default DOM tree versus new default rendered-control snapshot. The improvement does not rely on giving only the new version a manually selected form scope.

| Metric | Before | After | Change |
| --- | ---: | ---: | ---: |
| Tool calls to complete the fixture workflow | 17 | 11 | −35.3% |
| Failed locator calls | 6 | 0 | Eliminated |
| First snapshot response bytes | 105,035 | 2,271 | −97.8% |
| Total tool-response bytes | 106,060 | 3,792 | −96.4% |
| Cumulative tool execution time, median | 45.55 ms | 31.49 ms | −30.9% |

The real-browser regression driver also passed **24 checks** for hidden menus, hidden/password values, visibility overrides, `display:contents`, exact match counts, no-action ambiguity handling, stale/replacement refs, disabled targets, invalid-selector injection, scan/output limits and ambiguous scope rejection.

Verification: **3,078 Desktop tests passed**, plus Desktop preload/main/renderer/Storybook typechecking and the affected Biome checks.

## Interpretation and limits

The main expected benefit is fewer observation/locator-recovery cycles and more actionable information per response, not the small millisecond savings in tool execution itself. The earlier PR trace spent almost all time on sequential model requests, not browser execution.

This controlled replay demonstrates reduced failure/call counts for the historical failure pattern, but does **not** prove that an autonomous agent will always choose the correct new tool or that real GitHub/LLM end-to-end latency improves by the same percentages. No claim is made that the previous 8m48s task now takes 31ms. A live before/after agent experiment is still needed to measure that separately.

These are Desktop main-process changes. Rebuild/restart a version from this branch to use the new tools; an already running Desktop does not hot-replace its browser implementation.
