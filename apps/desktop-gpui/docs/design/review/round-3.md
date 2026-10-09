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

# Review round 3 (2026-09-26)

Opus 5.5: **NOT READY, 8/10**. Fable 5.1: **NOT READY, 8.5/10**. Both confirmed every round-2
fix in the pixels and raised the same single blocker.

| Finding (who) | Resolution (b62a10d and the follow-up commit) |
|---|---|
| A turn waiting for permission is drawn three ways: running spinner in the sidebar, failed call, waiting card (both, blocker; DESIGN.md §9 keeps active, attention and error apart) | Sidebar shows `StatusWaiting` in the warning ink for a task whose status is `waiting_for_user`. A call the sandbox refused (`sandboxDenial`) while its turn waits reads as waiting, not failed. The waiting words sit inside the card beside Allow/Deny; the turn footer and the row no longer repeat them. |
| Menu and palette active row #F6F6F6 on white is invisible (Opus) | New palette role `active_row`, ink 8% in light; kit list hover/active and `shared::menu` use it. |
| A lone tool call is ringed while the reasoning row is bare (Opus) | A lone, closed call is a bare row with a radius-10 hover wash; groups and open calls keep the ring. |
| Queue plate radius 12 sits 8pt above a radius-28 dock; dark canvas fill reads as a hole (Opus) | Queued messages are the dock's top section in the bubble tone with a `border_soft` divider; the section rounds its own top to 28 because GPUI clips to rectangles. |
| Dark settings segmented pill is darker than the overlay it sits on (Opus) | Selected pill uses `chip` in dark mode. |
| Dark Deny button has a fill step and a ring (Fable) | Plate fill with the `border` ring. |
| Done is a bare check while failed and waiting are circled (Fable) | `status-done` is circled; all five status glyphs share one construction. |
| List markers without a hanging indent (both) | Still blocked on gpui-kit TextView; disclosed. |

Round-4 captures: `round-4/`.
