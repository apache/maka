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

# Review round 5 (2026-09-26)

Opus 5.5: **READY, 9/10**. Fable 5.1: **NOT READY, 8.5/10**, with one blocker.

| Finding (who) | Resolution (e398fcd) |
|---|---|
| Dark settings: the section list uses the floor tone inside the overlay, so half the dialog dissolves into the scrim (Fable, blocker; DESIGN.md §2) | New `rail` role, one tier below the overlay: #F7F7F7 in light, #171719 in dark. |
| Dark inline code on #111113 is 1.05:1, round 1's invisible case again (Opus) | Inline code goes back to the 6% ink wash; Maka Desktop's own inline code is ink at 5%. Code blocks, tool output and the prompt's command keep #F1F1F1 / #111113, since Maka Desktop's dark code block is #111111. Moving them to the sunken #09090B would make the block the darkest surface on screen, the hole Fable warned about. |
| Spec says #EDEDED / #09090B, pixels show #F1F1F1 / #111113 (Fable) | The spec was ahead of the captures for an hour; it now says what the pixels show, as above. |
| Menu ring measures 10% in light and vanishes in dark, unlike the dialogs' 6% (Fable) | The ring was an outer shadow, darkened by the soft shadow in light and hidden under it in dark. Menus and the jump pill now draw a `border_soft` hairline inside the edge, as the dialogs do. |
| Dock shadow runs onto the canvas below the plate (Fable) | `0 6px 14px -6px`: it ends 14px below the dock, inside the 16px gap. |
| One permission request shows the waiting glyph on the row and the card (both) | While the card waits, the row leaves its status slot empty and its chevron follows the hover rule; the card carries the one glyph in the transcript. |
| "1 model" is 14px beside a 14px title (Opus) | 12 muted, tabular figures. |
| The flag floats 32pt left of the age (Opus) | It sits 6px before the age, inside the age lane. |
| No capture shows headings, quotes or links (Fable) | New capture 12: h2, h3, a bulleted list, a quote and a link. |
| "Working…" sits on the column edge, not in the activity-row lane (Fable) | **Kept.** It is the turn footer: when the turn ends, the same line reads "3 minutes ago · scripted-demo" on the prose edge. In the activity lane it would jump 12pt when the turn finishes. |
| Settings title measures ~18px (Fable) | **Not reproduced.** The title is 16px (`1rem`); the capital C measures 23 device pixels with its overshoot, which is 16px SF Pro Semibold. |
| The 28pt top fade greys one line while scrolled (Opus) | **Kept.** Any band greys what scrolls under it. The 10pt solid start hides the clip edge, which is what round 4 blocked on with a short band. |
| Sidebar top reads like AllSum: Maka Desktop puts search and the toggle in the traffic-light row and has no wordmark row (Opus, "confirm with the core team first") | **Open question for the core team.** The layout follows this client's spec, which keeps the wordmark and back and forward. It is one change if the team prefers Maka Desktop's. |
| Palette headers need 8pt more above; list markers need a 24pt lane (Opus) | **gpui-kit limits**, as in round 4. A spacer item would be a disabled, empty option to a screen reader. Both hooks are proposed upstream. |

Round-6 captures: `round-6/` (the 21 of round 5 plus `12-markdown-light.png` and `12-markdown-dark.png`).
