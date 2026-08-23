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

# Computer Use cursor provenance and compatibility evidence

This document records the exact source boundary for Maka's agent-cursor overlay
and corrects the first revision of pull request #2676, which incorrectly
reclassified the listed binary-recovered facts as compatibility observations or
local implementation choices. It does not classify the Computer Use
implementation as a whole as derived from the inspected binary.

## Inspected artifact

- Application: `~/.codex/computer-use/Codex Computer Use.app`
- Executable: `Contents/MacOS/SkyComputerUseService`
- Bundle identifier: `com.openai.sky.CUAService`
- Signed build date: 2026-07-16
- SHA-256: `44320516c4c400fb5459b203498c78e4af318b0096464f16c4445a47f2b8b8f4`

Every address and exact value below is scoped to that artifact. A later signed
build may move functions or change defaults.

### Reproducibility limit

The historical artifact is no longer present at the recorded local path. On
2026-08-11, that path contained a newer binary signed on 2026-08-05 with
SHA-256 `d51dc8dd4c5a1ff19c13e206a8e5022db8bf5cb1c7aff0d67d6c7f4bb55dc031`.

The July 16 SHA-256 and addresses are contemporaneous contributor evidence. No
copy of that proprietary artifact is stored in this repository, so the original
inspection cannot be independently reproduced from the repository alone.
Sanitized analysis records and the derived source boundary can remain without
redistributing the executable.

## Canonical description

Maka used this specific signed Codex Desktop binary both as a compatibility
reference and as a static-analysis input. The inspection read Mach-O data
constants, Swift type and field metadata, and disassembled control flow. Maka
then wrote TypeScript using the binary-recovered facts listed in this document
and added the separately listed Maka behavior.

This is more specific than saying only that Maka "referenced Codex Desktop":
some inputs were external behavior observations, while other inputs were exact
geometry, numeric values, or control-flow facts transcribed from the binary. No
OpenAI source code or executable bytes were added to this repository or
distribution. The binary is proprietary, and inspecting it does not provide a
license for the retained facts or implementation.

## 1. Were the binary-recovery descriptions in #1255 and #1883 accurate?

Mostly yes.

Pull request #1255 accurately stated that the normalized glyph path,
center-hotspot convention, and the 30 `MotionConfiguration.live` values came
from static inspection of the artifact above. Its planner was not an exact
translation: it used a Maka-authored single-segment cubic candidate family and a
placeholder scorer built around recovered handle and arc constants.

Pull request #1883 accurately stated that the scorer was present inline in the
inspected build and that its core measurement and cost composition were
recovered. The phrase "term-for-term reproduction" was too broad for the whole
Maka function: the current score retains the recovered core coefficients but
also includes Maka-specific terms, and the current candidate generator is not
the binary's generator.

## 2. Why were a binary address and "term-for-term" recorded?

The address `0x1000972ec` identified the scorer in the inspected artifact.
Static analysis recovered a 24-step path measurement and the following core
costs:

```text
320 * excessLengthRatio
+ 140 * angleChangeEnergy
+ 180 * maxAngleChange
+ 18 * totalTurn
+ (staysInBounds ? 0 : 45)
```

The implementation added those coefficients and replaced the earlier
arc-preference placeholder. The PR description used "term-for-term" for that
recovered core. It did not distinguish the additional raw-length cost,
backwards-arrival penalty, or the locally generated candidate family, so the
phrase overstated the scope of equivalence.

The `0.995` progress and `3.157` distance thresholds were likewise read from
the inspected artifact at `0x100d68cd0` and `0x100d68cd8`. They are retained as
build-specific input facts, not values independently tuned by Maka.

## 3. Current source classification

### Binary-recovered facts still retained

| Component | Evidence from the inspected artifact | Current location |
|---|---|---|
| Glyph geometry | Normalized `AgentCursor.path(in:)` coordinates | `CODEX_CURSOR_GLYPH` |
| Hotspot convention | Hosting-view center returned as the action hotspot | Cursor destination and completion semantics |
| Motion configuration | The 30 `MotionConfiguration.live` values | `CODEX_CURSOR_MOTION` |
| Close-enough gate | Progress `0.995`, distance `3.157` | `CURSOR_CLOSE_ENOUGH` |
| Path measurement | Fixed 24-step sampling, length, angle energy, max angle, total turn, and in-bounds state | `measureCursorPath` |
| Core score | Weights `320`, `140`, `180`, `18`, and out-of-bounds penalty `45` | `scoreCursorPath` |
| Terminal heading blend | Build-specific click angle and terminal blend behavior | `cursorHeadingAt` |

### MIT-licensed source lineage

The first Maka cursor renderer was a TypeScript adaptation of
`trycua/cua`'s MIT-licensed `cursor-overlay`, introduced in Maka commit
`025d0c628a2162d0a7daf49e97d104c36a4431c6`. The fixed upstream commit recorded
by Maka was `8c921b2b3bf13494724ead4f0a814d80c56a7e8b`.

Pull request #1255 replaced most of that motion and glyph implementation. The
MIT lineage remains relevant to the renderer's introduction and surrounding
overlay design, but it is not the source of the exact values listed above.

### Maka-authored or Maka-adjusted behavior

- the single-segment cubic candidate family in `planCursorPath`;
- `MAX_DESIRED_ARC`, `DEPARTURE_FAN`, and the odd candidate grid;
- the raw path-length cost and backwards-arrival score term;
- viewport widening and edge behavior;
- the spring deadline derivation, frame-clock ownership, and low-frame-rate
  sub-stepping;
- target-window ordering, semantic element-center presentation, cancellation,
  completion, and presentation fences;
- Maka brand palette, click pulse, shadow, and host integration.

These changes mean the current renderer is neither a straight port of
`trycua/cua` nor an instruction-for-instruction translation of
`SkyComputerUseService`. It is a mixed implementation with the exact retained
binary-recovered facts identified above.

## Distribution and review boundary

No OpenAI source code or executable is stored or redistributed in Maka. Static
inspection and transcription of facts from a proprietary executable do not
provide a license grant. This record identifies what happened; it does not make
the licensing conclusion. An independent human reviewer must decide whether
retaining the listed facts is acceptable for an ASF release or whether they must
be replaced.

### Applicable-terms gate before code transfer

The project has not established which agreement governed the inspection or
whether an applicable-law exception applied. The potentially relevant published
agreements include OpenAI's individual Terms of Use and Services Agreement:

- `https://openai.com/policies/row-terms-of-use/`
- `https://openai.com/policies/services-agreement/`

This provenance record must not be treated as an approval of retaining the
listed binary-recovered facts. Before code transfer, the project must either:

1. independently replace those retained facts and the code that depends on them; or
2. obtain an appropriate human legal or ASF determination based on the actual
   governing terms and applicable jurisdiction.
