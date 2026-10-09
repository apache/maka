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

# Review round 4 (2026-09-26)

Opus 5.5: **NOT READY, 8.5/10**. Fable 5.1: **NOT READY, 8.5/10**. Both raised the same single
blocker, the command palette's highlighted row.

| Finding (who) | Resolution (24d3775) |
|---|---|
| Palette highlight is the 4% hover wash, invisible in light; menus use `active_row` (both, blocker) | gpui-kit paints a Command row with the theme's `accent`, which stays the hover wash because ghost buttons hover with it. While a Command list is open, `accent` takes `active_row` (#ECECEC / #2E2E31); it returns when the palette closes. A test checks both. |
| Task titles on the group header's edge; nav labels at 40pt (Opus) | Titles and "Show more" start at 40pt; group headers stay at 16pt, as in Maka Desktop's sidebar. |
| Footer row has no menu affordance (Fable) | A 14px `ChevronUpDown` after the badge, as a popup button shows. |
| Back/Forward look enabled with no history (Fable) | Disabled controls take Maka's `--color-text-disabled` (#A3A3A3 / #525252), not a new 30% value. |
| Opaque badge fill reads as a hole on a selected row (Opus) | New `badge` role, ink 8% / 9%, translucent. |
| "···" hover disappears over a hovered row (Opus) | The row's icon button hovers with its own 6% wash and shows the selected fill while its menu is open. |
| Three code tones: inline wash, block and output canvas (Opus) | One `code` tone for all machine text: #F1F1F1 / #111113. |
| Suggestions container ring is `border_soft` (Opus) | `border` ring, `border_soft` dividers, as a tool group. |
| The 16pt top fade leaves a 15% cut line (both) | 28pt: solid for the first 10pt, then clear. It stays above the first message at rest. |
| Permission scope shows `/Users/…/maka-demo-export`; slash rules differ (Opus) | Paths under the home folder start with `~`, and a scope never ends with `/`. |
| Settings: four right edges (Fable) | Connection rows reach 12px past the content edges with their hover wash, so monograms and chevrons sit on the title's edges. The filter and the close glyph end on the same edge. |
| Two search fields in one dialog (Fable) | The connection list's search and filter show once there are two connections. The section search stays: it finds a section by its settings ("API key"). |
| Expanded output 4.5pt under its row, 12.5pt above the next divider (Fable) | **Measured on the text instead.** The row's label line ends 8pt above the row edge, so the block now sits 2pt below the row: about 12pt under the label's descenders and 12pt above the next divider. Equal box gaps would put 16pt above. |
| Queue caption measures 14px (Fable) | **Not reproduced.** It is 12/500 muted in code and in the pixels; its width per glyph is 0.89 of the 14px entry. |
| Palette section headers need 8pt more above (Opus) | **gpui-kit limit.** Command headings are kit rows with no style hook. Its separator row would add a 10% inset line, unlike the menus' 6% full-bleed one, so it is not used. |
| List markers without a hanging indent (both, earlier rounds) | **gpui-kit limit.** Wrapped lines already hang at the text column, since each item is a flex row. The marker is a text prefix flush with the column, and TextView has no list style hook. Both limits are proposed upstream: a list indent and marker lane on `TextViewStyle`, and a heading style on `Command`. |

Round-5 captures: `round-5/`.
