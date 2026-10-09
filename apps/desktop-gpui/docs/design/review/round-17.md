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

# Review round 17 (2026-10-07)

Round 17 recaptured all 94 views at the F9 commit (9ba9365). The 73 that are pixel-identical
to their latest reviewed capture keep that verdict; the 21 that F9 changed (`round-17/`) were
reviewed: the disconnected window, the Scheduled task form and waiting detail, the Daily
review page, About, Appearance's App icon (top and end, zh and en) and font size, Data in
English (dark) and the Full access confirmation.

Opus 5.5 **READY, 8.5/10**; Fable 5.1 **READY, 8.5/10**. Both checked every F9 item in the
pixels and found that none made a surface worse.

## Where every surface stands

Every surface is READY for both reviewers: the 21 views above in round 17, the other settings
views F8 changed in round 16, everything else in round 15, and the chat surfaces in round 8
(pixel-identical since, apart from task ages and the sidebar's dark selected-segment ring).

## Not done: should-fix items from round 17

1. Offline, the window shows two disabled looks: the suggestion rows use the disabled ink,
   the composer chips half opacity, and the attach "+" and the send disc come out at other
   greys. One disabled recipe (half opacity) for all of them. Both reviewers.
2. The scheduled detail's 删除 is a red wash; Desktop's is the solid destructive button
   (`scheduled-task-detail.tsx`). Reuse the Full access confirmation's solid recipe. Both
   reviewers; open since round 16.
3. Daily review's date lane is a fixed ~250 wide around a two-character 今天; size it to the
   longest date string.
4. Six English App-icon descriptions wrap to two lines (Sunset, Desert, Gold, Chrome, Mono
   black, Hazard).
5. About's protocol value "197（Host 197）" uses full-width brackets, which end 2.5pt short of
   the column; use half-width brackets in zh.

Not captured, so not reviewed: the busy model chip during a running turn and the zh-Hant
App-icon lines.
