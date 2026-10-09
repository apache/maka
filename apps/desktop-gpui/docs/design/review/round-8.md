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

# Review round 8 (2026-09-28)

Opus 5.5: **READY, 8.5/10**. Fable 5.1: **READY, 8.5/10**. Neither raised a blocker. Every
round-7 fix was confirmed in the pixels by both.

This is the state to submit: `main` at the commit that records this round. Two small changes an
Opus should-fix suggested after the verdict sit unreviewed on the local branch
`polish-after-round-8`: a gear for Settings entry points, and the Thought preview ending on the
tool rows' summary edge.

## Questions for the core team

These are layout calls where this client follows its own spec rather than Maka Desktop. Both
reviewers asked for them to be raised, not decided silently.

1. **Sidebar top.** This client has the traffic lights with the sidebar toggle and back/forward,
   then a wordmark row with search. Maka Desktop puts search and the toggle in the traffic-light
   row, with no wordmark row and no history arrows.
2. **Plate inset.** The reading plate is inset 8px from the window's top, right and bottom edges.
   Maka Desktop's content runs flush to those edges.
3. **The data folder badge in the footer** ("demo-root"). It tells two State Roots apart. Maka
   Desktop has no such badge.

## Known gpui-kit limits, proposed upstream

- List markers are a text prefix on the column edge; there is no marker lane or hanging indent.
  Wrapped lines do hang at the text column.
- Command palette section headings get no extra space above them.

## Remaining should-fix items, not yet done

| Item (who) | Note |
|---|---|
| Settings entry points use the sliders glyph also used for General (Opus) | Done on `polish-after-round-8`, unreviewed. |
| The Thought preview ends past the tool rows' summary edge (Opus) | Done on `polish-after-round-8`, unreviewed. |
| Composer chips are 14/400; the label role is 14/500 (Fable) | Open. |
| The "Archived 16" count is the label's size; a count is 12 muted (Fable) | Open. |
| Headings map to 18 / 16 / 14; Maka's heading roles are 20 / 18 / 16 (Fable; Opus in round 7) | Open. |
| Chinese relative time says 前天; Maka Desktop says 2天前 (Fable) | Open. |
| Scrim is about 20% in light and 52% in dark; write the pair down (Fable) | Open. |
| 16-zh-CN-command-palette-light was captured focused, with the pointer on the last row (Opus) | The person at the machine clicked it; recapture with the next round. |
| The relay name has half-width parentheses (Fable) | **Not reproduced.** The string uses U+FF08 and U+FF09, as Maka Desktop's does. |
