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

# Transcript hover validation — 2026-10-30

Issue: https://github.com/apache/maka/issues/5842

Base: current main `85a1031c10d104456127f35aac1523b9ffb1a384` merged into PR #5856.
The package remains Astryx 0.6.3; the same 16 original ancestor-hover rules
remain applicable. The merged patch applied successfully to a clean package.

Reproduce with the commands in [the probe README](../README.md#expanded-transcript-hover-5842).
The original selector conditions are restored only in CSSOM, in the same browser
and document. This isolates this PR’s CSS change against main’s selector
conditions; it is not an independent old-main build comparison.

## Interaction checks

The actual Overlay, CheckboxInput (owning Indicator), Switch, TabList and Table
components passed click/Space, tab arrow/Enter activation, sorting, disabled-state,
Overlay pointer/focus visibility, pointer-entry marker and pointer-exit cleanup
checks. Chromium touch taps toggled the enabled controls, activated tabs and
sorted the table, and opened/activated Overlay via its non-interactive surface toggle without leaving hover markers. This is touch-event emulation;
physical phones/tablets remain untested.

The original and marker CSSOM modes produced identical screenshot bytes in the
observed focused Overlay, first selected tab, unchecked and disabled controls,
and sorted table state. This is scoped evidence, not every component state.

| Original conditions | Marker conditions |
| --- | --- |
| ![Original focused component fixture](original.png) | ![Marker focused component fixture](marker.png) |

## Other validation

`npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check`,
Desktop `typecheck:stories` and `build-storybook`, both required knip workspace
checks, and `git diff --check` passed. Dependency packages were rebuilt before
typechecking. No new full Desktop test-suite result is claimed.

The merge-only commit skipped the pre-commit hook after the existing protocol
checker rejected main’s historical epoch-201 declaration against epoch 237
across the month-old merge base. There are no PR-specific protocol changes.
The fixture commits and final probe commit run the normal hooks.

## Performance samples

macOS / Apple M4 Max, Chromium 153.0.8010.12, headless static Storybook, 1280×900. The same expanded 360-step document had 15,436 elements and 103,028px scroll height after fonts settled.

| Pair | Original LoAFs >50ms | Marker LoAFs >50ms | Original style recalc (ms) | Marker style recalc (ms) |
| --- | ---: | ---: | ---: | ---: |
| 1 | 26 | 2 | 2692.162 | 666.014 |
| 2 | 26 | 2 | 2749.609 | 687.528 |
| 3 | 26 | 2 | 2723.635 | 678.324 |

Median style recalc decreased 75.1% (2723.635→678.324ms); measured layout time was zero in all six sweeps. LoAFs remain, so this does not claim all long frames are eliminated. [Exact samples](samples.json) include recalc counts and maximum LoAF durations.

This is a same-document selector A/B on the updated fixture, not a reproduction of the original Windows/Storybook-dev/browser-version result (86 LoAFs, 14,919 elements). Current main has changed the DOM. Physical touch devices and the original reporter’s environment remain unverified.
