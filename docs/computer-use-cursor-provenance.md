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

# Computer Use cursor provenance and independent replacement

This document records the exact source boundary for Maka's agent-cursor overlay
and the independent replacement completed for Apache Maka issue #3293. The
historical record corrects the first revision of pull request #2676 without
classifying the Computer Use implementation as a whole as derived from the
inspected binary.

## Current status

The current cursor no longer retains the glyph geometry, hotspot placement,
motion values, close-enough thresholds, path-measurement constants, core score,
or terminal-heading behavior transcribed from the proprietary binary described
later in this document. Those inputs are historical only.

The replacement was derived before the contributor inspected the values it
replaced. The complete public derivation is recorded at:

https://github.com/apache/maka/issues/3293#issuecomment-5371901326

The derivation used four Maka product requirements:

1. keep the agent cursor legible at 1x over arbitrary application content;
2. land the action hotspot before native click dispatch is released;
3. prefer the straightest valid route on long moves; and
4. settle position and heading without visible overshoot.

## Independent replacement values

### Glyph and action hotspot

The replacement is a rounded dart drawn inside a normalized unit square. Its
tip is both the path start and the action hotspot. `CursorEngine.pos` remains
the sole action coordinate, and rendering translates that coordinate directly
to local canvas `(0, 0)` before drawing the tip.

- `size = 20` CSS px;
- `shadowBlur = 3` CSS px;
- maximum tip-to-painted-edge allowance and `boundsMargin = 20 + 3 = 23` CSS px;
- start `(0.00, 0.00)`;
- cubic controls `(0.03, 0.23)`, `(0.11, 0.51)`, end `(0.20, 0.83)`;
- line `(0.43, 0.63)`;
- cubic controls `(0.49, 0.57)`, `(0.57, 0.60)`, end `(0.63, 0.69)`;
- line `(0.80, 1.00)`;
- line `(1.00, 0.89)`;
- cubic controls `(0.86, 0.63)`, `(0.69, 0.40)`, end `(0.00, 0.00)`.

`CODEX_CURSOR_GLYPH` retains its public tuple shape: each curve stores its
endpoint first, followed by its two controls. The PiP SVG is the same path with
the same local-origin hotspot. The status-item PNGs are deterministically
rasterized from this geometry with Maka's existing blue gradient on a
transparent background. Regenerate them from the repository root with
`node scripts/generate-cu-status-icons.mjs`.

### Motion configuration

`CODEX_CURSOR_MOTION` retains its existing exported name and 30-field shape.
Its current values and independent rationale are:

| Field | Replacement | Derivation |
| --- | ---: | --- |
| `clickAngle` | `-π/4` | Canonical diagonal resting direction |
| `candidateCount` | `9` | Odd symmetric grid with a guaranteed zero-arc candidate |
| `boundsMargin` | `23` | Glyph size plus shadow allowance |
| `startHandle` | `1/3` | Canonical straight cubic handle |
| `endpointHandle` | `1/3` | Same construction at arrival |
| `arcSize` | `0.30` | Avoidance candidates without encouraging desktop sweeps |
| `arcFlow` | `0.50` | Symmetric perpendicular displacement |
| `straightPathDistanceThreshold` | `60` | Three glyph widths |
| `springResponseScaler` | `1/2400 s/px` | Distance-scaled response in seconds per pixel |
| `springResponseMin` | `0.18 s` | Lower response bound |
| `springResponseMax` | `0.72 s` | Upper response bound |
| `springDampingFraction` | `1.0` | Critical damping; no position overshoot |
| `scootDistanceThreshold` | `60 px` | Three glyph widths |
| `scootPositionResponse` | `0.16 s` | Deformation follows main motion |
| `scootPositionDampingFraction` | `1.0` | No position bounce |
| `scootPositionSettleVelocity` | `2 px/s` | One tenth of the glyph size per second |
| `scootAxisResponse` | `0.12 s` | Axis responds faster than position |
| `scootAxisDampingFraction` | `1.0` | No axis overshoot |
| `scootBaseRotationResponse` | `0.18 s` | Matches the shortest main response |
| `scootBaseRotationDampingFraction` | `1.0` | No base-rotation bounce |
| `scootStretchResponse` | `0.14 s` | Subtle shape response |
| `scootStretchDampingFraction` | `1.0` | No stretch bounce |
| `scootStretchMin` | `0.92` | `1 - 0.08`, matching maximum Y squash |
| `scootStretchPivotX` | `0.25` | Keeps the leading quarter near the hotspot |
| `scootStretchXAmount` | `0.16` | Maximum 16% longitudinal stretch |
| `scootSquashYAmount` | `0.08` | Half the X deformation |
| `scootRotationResponse` | `0.16 s` | Tracks the deformation response |
| `scootRotationDampingFraction` | `1.0` | No rotational overshoot |
| `scootRotationMax` | `π/8` | 22.5 degrees, half the resting diagonal |
| `terminalTangentBlendStart` | `0.80` | Final fifth blends into click heading |

The position response is calculated as:

```text
response = clamp(distanceInPixels * (1 / 2400 secondsPerPixel), 0.18, 0.72)
```

### Path measurement and scoring

`SCORE_SAMPLES = 33` means 33 points, including both endpoints, and 32
equal-length parameter intervals. The independent core measures are:

```text
detour      = max(0, measuredLength / directDistance - 1)
angleEnergy = mean(deltaHeading²)
maxAngle    = max(abs(deltaHeading)) / π
totalTurn   = sum(abs(deltaHeading)) / π
outOfBounds = 0 or 1
```

For the degenerate chord, zero measured length has zero detour; positive
measured length over a zero direct distance is rejected with infinite score.

The independent core score is:

```text
8 * detour
+ 1.5 * angleEnergy
+ 2 * maxAngle
+ 0.5 * totalTurn
+ 1,000,000 * outOfBounds
```

These terms are dimensionless and positive. A valid straight path therefore
wins when available, while leaving the viewport is a lexicographic rejection
rather than a cosmetic preference. Maka's earlier raw path-length addition and
backwards-arrival penalty remain around this core, as issue #3293 requires.

The independently derived scorer continues to evaluate Maka's existing
single-segment cubic candidate family. It does not import any candidate
generator from the historical artifact.

As a new Maka integration choice for this replacement, the nine-candidate
budget is allocated by selection rather than a Cartesian product. This
reconciles the independent count of nine with Maka's retained five-way
departure fan. Fresh motion uses nine symmetric arc values at direct departure.
Interrupted motion keeps all five
`DEPARTURE_FAN` weights: five symmetric arcs (including zero) at direct
departure, plus one zero-arc candidate at each of the other four departure
weights. This allocation is an implementation choice around the independently
derived odd symmetric budget, not part of that derivation.

### Terminal heading

Fresh motion begins facing the path target. Over progress `[0.80, 1.00]`, the
engine computes the shortest signed angular difference from the path tangent to
`clickAngle` and interpolates it with:

```text
phase = clamp((progress - 0.80) / 0.20, 0, 1)
weight = phase² * (3 - 2 * phase)
heading = tangentAngle + shortestSignedDifference * weight
```

Wrapping the difference before interpolation prevents a long-way rotation
across the `-π`/`π` boundary.

### Close-enough gate and presentation deadline

The independent gate is:

```text
progress = 0.99999
distance = 2 CSS px
```

Five-nines progress leaves at most one CSS pixel on a 100,000 CSS-pixel route,
which is within the independent 2px distance gate. The deadline is not chosen
separately from these values.

For the slowest critical spring, the engine replays its semi-implicit
integration with:

```text
response = 0.72 s
damping fraction = 1.0
step = 1 / 240 s
progress threshold = 0.99999
```

The threshold is reached at 1725ms. At the slowest supported presentation
cadence of one frame per second, release is observable on the 2000ms frame.
Adding 100ms of renderer/IPC scheduling margin gives:

```text
cursorPresentationReadyDeadlineMs() = 2100 ms
```

The overlay seeds the engine clock at motion submission, so the first one-fps
frame advances the first second. When a move interrupts another, the old path
is first aligned to the same submission timestamp and the replacement is then
seeded at that timestamp, preventing pre-replacement time from replaying into
the new path.

The persistent transparent `BrowserWindow` disables Electron background
throttling so its real `requestAnimationFrame` path does not enter a
background-only one-fps phase drift while unfocused. Readiness is evaluated and
reported only from that frame path after painting. Idle CPU behavior is
unchanged because the renderer stops requesting frames once the engine settles.

The controller continues to source its ready fence from this function, so its
fence cannot silently fall below the derived deadline. The result remains below
the separate 5000ms dead-renderer backstop.

## Historical binary-inspection record

Before issue #3293, Maka retained exact inputs recovered from this artifact:

- application: `~/.codex/computer-use/Codex Computer Use.app`;
- executable: `Contents/MacOS/SkyComputerUseService`;
- bundle identifier: `com.openai.sky.CUAService`;
- signed build date: 2026-07-16;
- SHA-256: `44320516c4c400fb5459b203498c78e4af318b0096464f16c4445a47f2b8b8f4`.

Pull request #1255 introduced binary-derived glyph, hotspot, and motion values.
Pull request #1883 introduced binary-derived path-measurement and scorer values.
Pull request #2676 documented that boundary. The proprietary artifact is not
stored in this repository, and the recorded local path later contained a
different signed build.

Those former inputs remain visible in published Git history and are described
here only as historical provenance. They are not retained by current cursor
behavior. Issue #3293 resolves the current-source gate by replacement, not by a
legal determination about the former facts.

No OpenAI source code or executable bytes were added to this repository or its
distribution.

## MIT-licensed source lineage

The first Maka cursor renderer was a TypeScript adaptation of `trycua/cua`'s
MIT-licensed `cursor-overlay`, introduced in Maka commit
`025d0c628a2162d0a7daf49e97d104c36a4431c6`. The fixed upstream commit recorded
by Maka was `8c921b2b3bf13494724ead4f0a814d80c56a7e8b`.

Later work replaced most of that motion and glyph implementation. The MIT
lineage remains relevant to the renderer's introduction and surrounding
overlay design, but it is not the source of the independent values above.

## Retained Maka-authored or Maka-adjusted behavior

Issue #3293 deliberately preserves the surrounding Maka work:

- the single-segment cubic candidate family in `planCursorPath`;
- `MAX_DESIRED_ARC` and `DEPARTURE_FAN`;
- the raw path-length cost and backwards-arrival score term;
- viewport widening and edge behavior;
- frame-clock ownership and low-frame-rate sub-stepping;
- target-window ordering, semantic element-center presentation, cancellation,
  completion, and presentation fences;
- Maka's brand palette, click pulse, shadow treatment, and host integration.

The result remains a mixed-lineage Maka implementation: an MIT-derived
renderer foundation, Maka-authored product behavior, and a current cursor value
set with a public independent derivation.
