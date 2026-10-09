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

# Review round 2 (2026-09-26)

Opus 5.5 and Fable 5.1 judged `round-2/`: both **NOT READY, 8/10** (up from 7/10).
Round-1 fixes were confirmed in the pixels by both.

| Finding (who) | Resolution (commit 73074a2 unless noted) |
|---|---|
| Dark popovers cast a light shadow that reads as a glow (Opus, blocker) | Shadow colour is black in dark mode. |
| Dark plate has a fill step and a ring on the same edge (Opus, blocker) | Dark ring removed; the base/raised step is the one separator. |
| Queue plate radius 16 is a fifth rung (both) | Radius 12. |
| zh footer "本机 Runtime Host" squeezes the data-folder badge to "demo-r…" (both) | Badge never shrinks; the footer shows 本机/本機, the accessible name keeps the full term. |
| Allow/Deny 24pt pills (both) | Maka's control recipe: 32pt, radius 10, 14/500; Allow primary, Deny outline. |
| Tool-name lane grows with content; summaries shift 12pt between groups (both) | Fixed 84pt lane with truncation. |
| Collapsed failed row hides its chevron (Fable) | A failed row always shows the chevron. |
| Waiting row is carried by hue only (Fable) | "Waiting for your answer" in words beside the glyph. |
| Permission row repeats the card below it; Load tool is noise (Opus) | tool_search rows and a still-waiting boundary request are not drawn. |
| Finished reasoning row still says "Thinking" (Opus) | "Thought" / 已深度思考 once done. |
| Empty-task hero repeats the header title (Opus) | Every empty task asks "What should we work on?". |
| Dark provider disc on sunken reads as a hole (Opus) | Chip fill. |
| Text is cut mid-glyph under the header when scrolled (Fable) | A 16pt plate-to-transparent fade under the header (the scroller exposes no offset-from-top, so a scroll-only hairline is not possible). |
| List markers without a hanging indent (both, S9) | Still blocked on gpui-kit's TextView; disclosed. |

Round-3 captures: `round-3/`.
