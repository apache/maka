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

# #5184 geometry ablation — 2026-09-11

## Implementation after the experiment

The measurements below describe the pre-change source, not current product
behavior. The implementation now uses real layout for resident Turns, timeline
blocks and code chunks. The existing scroll authority defers range publication
during input, coalesces pending publication, and restores the reading Turn once
at commit. Messages and gap metadata form one published view; otherwise gap
changes alone moved held height by 68px in the native probe. The old 1px input
nudge and the render-skipping assertion were removed.

Ordinary CI runs the fixed-range driver with `GEOMETRY_MODE=baseline` and
`--assert-stable`. The former native diagnostic is now
`apps/desktop/e2e/scroll-geometry.spec.ts`: held height/range, monotonic upward
movement, release-frame anchor position, and subsequent navigation are strict
assertions. This implementation targets main, not the unmerged #5170 branch.
The post-change performance run must be compared using the report commit and
environment; a successful job is not a statistical non-inferiority result.

## Pre-change experiment

This is a diagnostic result, not a production fix or a claim of a universal
performance bound. Production CSS and window policy were not modified.

## Conditions

- Fixed-range source: `a49ba7544c3bdd1ef648ec90c69b8f39f3e881c0`, with two new
  deterministic ComposedShell stories and the diagnostic driver.
- Window comparison: the same main source and #5170 at
  `770b2713d7110b145ccc367f1c24c2f0fc30ca04` (not an assertion about future heads).
- Apple M5 Pro, 64 GiB RAM, macOS arm64; Electron 43.4.1,
  Chromium 150.0.7871.224.
- Fixed-range trial viewport 1200×900. Three scenarios × three modes × three
  alternating repetitions in one Electron process, fresh DOM each time. Fonts
  and Markdown ready before traversal; this is not disk-cold application startup.
- Real CDP wheel, 600px per tick; cold upward traversal, downward return and
  second upward traversal. Root metrics sampled every rendering frame. No
  offscreen descendant bounding-box reads to prepare the fixture.
- Ablations preserve `contain: layout style paint`; they remove skipping, not
  all containment. No product toggle was added.

## Fixed-range results

Values below repeat identically across all three geometry trials. Height drift
is max minus min during the cold climb, not just final minus initial. Positive
upward reversal is the largest frame-to-frame increase in scrollTop.

| Scenario | Mode | Height drift px | Upward reversal px | Ready median ms | Largest task, range ms |
| --- | --- | ---: | ---: | ---: | ---: |
| Mixed 24 Turns | Current | 20862 | 169.5 | 568 | 89–122 |
| Mixed 24 Turns | No Turn skipping | 21762 | 289.5 | 544 | 106–107 |
| Mixed 24 Turns | No skipping | 0 | 0 | 539 | 98–100 |
| 45-tool Turn | Current | 8002 | 25.5 | 520 | 71–75 |
| 45-tool Turn | No Turn skipping | 8002 | 25.5 | 515 | 74–80 |
| 45-tool Turn | No skipping | 0 | 0 | 499 | 76–80 |
| 1200-line code | Current | 2638 | 0 | 512 | 66–70 |
| 1200-line code | No Turn skipping | 2638 | 0 | 500 | 63–67 |
| 1200-line code | No skipping | 0 | 0 | 505 | 61–66 |

All modes converge to identical final document heights: 28060, 9690 and 24413px
respectively, and identical DOM element counts (2878, 2313, 1576). Removing
skipping did not make the result stable by cutting out content. The no-skipping
probe also verifies zero remaining `content-visibility:auto` descendants.

No >50ms task was observed during the measured scroll phases in any mode.
All modes had >50ms mount tasks. Ready timings include driver readiness polling
and loading, so small differences are not claimed as product speedups. Raw heap
samples contain uncollected objects and do not establish leak or memory bounds.
The separate strict green run observed a 144ms mount task; the table's maximum
is a sample result, not a performance upper bound.
Paint cost on weaker devices, very large highlighted code, asynchronous media,
font/width changes and ongoing streaming are not settled by these samples.

## Real Host/native thumb drag

120-Turn existing `chat-prompt-rail` fixture, 1000×700; baseline / no-skipping /
no-skipping / baseline in one app. A styled 14px **native** scrollbar is used to
avoid platform overlay ambiguity, with a gutter assertion and real CDP pointer
press/move/release. Every run must actually scroll >100px. Membership and H are
sampled while the pointer remains held, including 400ms without movement.

| Source | Mode | Held height drift px, two trials | Distinct held ranges |
| --- | --- | --- | --- |
| main | Current | 134 / 118 | 4 / 5 |
| main | No skipping | 180 / 180 | 4 / 4 |
| #5170 | Current | 25268 / 25330 | 3 / 3 |
| #5170 | No skipping | 19363 / 16500 | 9 / 23 |

This establishes that removing lazy estimates cannot make native thumb geometry
constant while the window changes membership. It does **not** quantify perceived
content jumps or prove an anchor-restoration implementation correct. A passing
window diagnostic means the measurement and input worked, not that the product
satisfies the strict geometry contract.

## Architecture decision

1. Do not build a Size Index, staging renderer, fixed shell or geometry snapshot
   system on the strength of the original proposal. First implementation candidate
   is ordinary layout inside the existing resident range, retaining only proven
   containment needs. There is no measured requirement for a size manager yet.
2. Resolve all three skip sites: Turn, timeline block and Astryx CodeChunk.
   Prefer the existing dependency/component seam over generated StyleX class
   names. The experiment's broad override is not production code.
3. Keep window membership and scroll authority separate. #5170 still needs a
   submission rule during held native scrollbar dragging. Strict H/monotonicity
   for all incremental gestures also means deferring fill/trim, with edge waiting;
   the experiment does not authorize relaxing that requirement.
4. Preserve a fixed-range constant-height/monotonicity regression and a distinct
   window-drag contract. Do not classify a new window revision as an exemption
   from a held-gesture guarantee.

The diagnostic has an executable strict gate (`--assert-stable`): current mixed
content fails with 20862px drift; the no-skipping intervention passes all three
scenarios. This is not yet wired into ordinary product CI, because this stage
changes no production behavior. Integration of the actual fix must install the
default production-mode gate and replace overlapping weaker assertions.

## Reproduce

From repository root, after installing dependencies:

```sh
npm --workspace @maka/core run build
npm --workspace @maka/desktop run build-storybook
node scripts/perf/geometry-ablation.mjs
```

Explicit negative control (expected to fail on the measured source):

```sh
GEOMETRY_REPETITIONS=1 GEOMETRY_MODE=baseline GEOMETRY_SCENE=geometry-mixed-24-turns node scripts/perf/geometry-ablation.mjs --assert-stable
```

Intervention with the same strict assertions:

```sh
GEOMETRY_REPETITIONS=1 GEOMETRY_MODE=no-skip node scripts/perf/geometry-ablation.mjs --assert-stable
```

For the Host/window diagnostic, build Desktop first, then run from
`apps/desktop` (the existing fixture resolves its app root from the working
directory):

```sh
npm run build:with-deps
npx playwright test --config e2e/playwright.config.ts e2e/scroll-geometry.spec.ts
```

The original diagnostic and its JSON output belong to measurement commit
`817a5737d`; it has now been replaced by the ordinary E2E regression above.
The regression asserts held range/height, upward monotonicity, every sampled
release-frame anchor position and progress after release. Fixed
range reports default to repository `perf-results/geometry-ablation.json` and
can be directed with `GEOMETRY_OUTPUT`. Preserve reports before a subsequent run.
