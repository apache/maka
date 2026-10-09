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

# Review round 7 (2026-09-28)

Opus 5.5: **NOT READY, 8.5/10**. Fable 5.1: **NOT READY, 8.5/10**. Both raised the same single
blocker, the New task state.

| Finding (who) | Resolution (dbb854a) |
|---|---|
| New task is titled "New Chat", in English in every locale, and each ⌘N leaves another empty task (both, blocker) | The Host's default name (`DEFAULT_SESSION_NAME` in Maka's core) reads as New task / 新任务 / 新任務 until the first message names the task. New task opens a task created in the same folder and never used, instead of creating another. |
| Hovering a waiting task swaps its glyph for "···" (both) | The waiting or running glyph stays; "···" takes only the age's place, beside it. |
| Quote rule 3pt at 6%, nearly invisible (both) | The kit's one rule colour (quote, horizontal rule, table rows) is `border`, 10%. Its width stays gpui-kit's 3px. |
| Permission scope is a localised sentence in mono; CJK falls back inside it (Opus) | The sentence is in the body face on the code tone; only the path is mono. |
| Dark segmented track uses the sunken #09090B, the darkest surface on screen (Opus) | Dark track is the 6% wash; the chosen segment is one step above the overlay, with no ring or shadow. |
| Dock shadow still reaches the canvas (Opus) | `0 4px 8px -4px` at 8%: it ends 8px below the dock, inside the 16px gap. |
| Queue section has a fill step and a divider on one edge (Opus) | The divider is gone. |
| Table rows are 39pt, off the 4px grid (Fable) | Cell padding 8.5 / 8.5: 40pt rows with the rule. |
| Footer row with its menu open: 2.4% fill in light, 10% in dark (Fable) | gpui-kit's held-selected ghost fill is the translucent `selected` step, the same on any surface. |
| Top fade greys a whole line (Fable; Opus in round 5) | 12pt, the first 6pt solid: the clip edge stays hidden and no line is ever fully inside the band. |
| The language submenu opens with English highlighted while 简体中文 is checked (Opus) | A submenu opened from the keyboard starts on its checked item. |
| "Custom relay (OpenAI Chat-compatible)" is not translated (Opus) | The three custom relays take Maka Desktop's own names in every locale (自定义中转站（OpenAI Chat）); other providers are brands. |
| Light and dark captures show different data (Opus) | Each screen is captured light then dark, back to back. |
| h3 at 14/600 skips 16 (Opus) | **Measured, not changed.** h2 is 16/600 (cap 23 device px) and h3 14/600; the ladder is 18 / 16 / 14 with no gap. |
| Scrollbar lane sits 9.5pt inside the plate (Fable) | **Kept.** The transcript keeps a 4pt margin so its keyboard focus ring is not clipped. |
| List markers; palette section headings (both) | **gpui-kit limits**, as in earlier rounds. |

Round-8 captures: `round-8/` (31, the same screens as round 7).
