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

# Review round 6 (2026-09-26 to 2026-09-28)

Opus 5.5: **READY, 8.5/10**, no blockers. Fable 5.1's review stopped on a rate limit (HTTP 429)
before a verdict, so round 7 asks both again.

| Finding (Opus) | Resolution (c2f48c7, c1b879d) |
|---|---|
| Sizes that are not rungs of Maka's type scale: tool names, table headers and segmented labels at 13, CJK group headers at 13, mono at 12.5 | Maka's roles, measured against Maka Desktop where the CSS is not explicit: labels, tool names and table headers 14 (label, heading-4); code blocks and a prompt's command 14/20 (code); tool rows and output 12/20 mono; segmented labels 12/500; group headers 12, and 14 in Chinese as Maka Desktop sets "最近". |
| Settings is reachable only through a row labelled "Local Host" (also Fable, round 4) | A 28px settings button at the right of the footer opens Settings directly; the row keeps its menu. The row's chevron is gone, so the Host name fits. |
| Inactive dark windows draw black traffic lights | The app's native appearance follows the chosen theme, so AppKit draws the window's own chrome for dark mode. |
| A circled "!" reads as an error beside the circled × | The waiting glyph is a circled "?": what waits is a question to the user. |
| The hero under an existing task's title reads as a task that lost its history | Capture 05 is now the New task state. |
| Chinese is shown in one capture only | Captures 13 to 16 show the permission card, settings, the footer menu and the palette in Chinese, in both themes. |
| Sidebar top follows this client's spec rather than Maka Desktop's | **Open question for the core team**, as in round 5. |
| List markers and palette headings | **gpui-kit limits**, as in rounds 4 and 5. |

Capture note: in round 7, English permission cards in the capture windows were answered with
Allow two to three seconds after they appeared, five times: the person at the machine took the
capture windows for real requests and clicked. The app answers only on a click of the button. Captures now open with `--passive` (no focus, app not activated), and every permission
capture below was checked to still be waiting.

Round-7 captures: `round-7/` (31: the 23 of round 6 with 05 as New task, plus 13 to 16 in Chinese).
