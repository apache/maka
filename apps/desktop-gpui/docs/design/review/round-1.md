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

# Review round 1 (2026-09-26)

Two independent reviewers (Opus 5.5 and Fable 5.1) judged the eight captures in this folder
against `$MAKA_REPO/DESIGN.md`, AllSum and Maka Desktop. Both: **NOT READY, 7/10**.

## Accepted, and how each is resolved

| # | Finding (who) | Decision |
|---|---|---|
| B1 | Sparkle glyph on suggestions and the thinking row; DESIGN.md §11 forbids sparkle and decorative "thinking" (both) | Done in 7369507: `MakaIcon::Reasoning` (quote bar) and `MakaIcon::Prompt` (corner arrow). |
| B2 | The captures miss the states that define Maka: running turn with Stop, queued message, running and flagged sidebar rows, multi-row tool group with an expanded failure, a permission request, dark empty/settings/palette (both) | The scripted demo model now plays multi-step, failing, slow and permission scenarios; round 2 captures all of them in both themes. |
| B3 | Primary and success sample as #285EA1 / #347826, not Maka's (Fable) | **False positive.** Those are exactly Maka's sRGB values seen through the Display P3 profile the capture carried (#0260A6→#285EA1, #007A11→#347826, #279936→#4C9744). `scripts/screenshot.sh` now converts captures to sRGB. |
| S1 | Footer and task menus: 26–28pt rows, 10–12pt glyphs, keycap vs plain shortcut styles differ from the palette's 32pt rows (both) | Menus get 32pt rows, 16px muted icons, 4px padding, 8px gap to the anchor, shortcuts as plain 12 muted text everywhere. |
| S2 | "Switch State Root…" is internal vocabulary (Opus) | "Switch data folder…" / 切换数据文件夹… / 切換資料夾…; dialog copy follows. |
| S3 | Ages "11min" are long and inconsistent with Maka Desktop's "4d"; truncate titles early (both) | Compact ages in every locale: `now`, `11m`, `3h`, `4d`, `2w`, then a short date. |
| S4 | Two wordmarks on one screen; DESIGN.md §10 keeps brand marks out of empty states (both) | The hero is type only. New task: "What should we work on?". An existing empty task shows its own title at 22/400. |
| S5 | Suggestions are a stack of ringed cards (both) | One container, radius 12, `border_soft` ring and dividers, 44pt rows, prompt glyph, hover wash. |
| S6 | Table: outer ring and vertical rules; header text muted (both) | Horizontal rules only: 1px `border` under the header, `border_soft` between rows; header 13/600 ink. |
| S7 | Inline code fill #F7F7F7 invisible on white (Opus) | New palette role `wash` (ink 6%), radius 6, padding 1/5. |
| S8 | "Default" badge nearly invisible (Fable) | One badge recipe: palette role `chip` (#EDEDED / #242427), 20pt pill, 12/500 ink muted. Footer root badge uses it too. |
| S9 | Bullets sit on the column edge (Opus) | **Not done: gpui-kit limit.** Its TextView renders the marker as a text prefix with no list hook, so a hanging indent needs an upstream change in gpui-kit (a Longbridge project); nested lists already step 16pt. Tracked for an upstream PR. |
| S10 | User bubble to assistant turn gap ≈14pt (Opus) | 24pt between a user message and the reply. |
| S11 | Empty send arrow is ink; dark sunken fill reads as a hole (Opus) | Empty send = `wash` fill with an ink-muted arrow in both themes. |
| S12 | Sidebar rhythm: 5pt above the segmented control, 26pt below, control 26pt tall, wordmark at 20pt vs icon column at 16pt (Opus) | 8pt above, 28pt tall, 16pt below; wordmark at 16pt. |
| S13 | zh: "本机 Host" half translated; 12px CJK group headers at the floor (both) | One agreed term from Maka Desktop's zh copy; CJK group headers 13px. |
| S14 | Plate left edge at 256 vs spec 264 (Fable) | Sidebar 256 + 8 gap: plate starts at 264. |

## Also fixed after the second reviewer pass on the permission capture

- Pending prompt card: ring is `border`, not warning; a new `StatusWaiting` glyph carries the
  warning tone; Allow is primary, Deny outline.
- Tool rows name the runtime tools in words ("Load tool", "Permission") and summarise a
  boundary request as "Write ~/maka-demo-export"; a call waiting on the user shows the waiting
  glyph instead of "stopped"; the name lane is 76pt so summaries share one edge.
- The folder picker still uses gpui-kit's menu (26pt rows); only the footer and task menus
  were in S1's scope.

Round-2 captures: `docs/design/review/round-2/` (sRGB, 1512x885, English unless named).
