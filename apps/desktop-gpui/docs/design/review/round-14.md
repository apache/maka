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

# Review round 14 (2026-10-06)

Round 14 re-reviewed the pages-and-Hosts batch and the two settings pages the round-13
fixes changed (`round-14/`, 32 captures taken at 81b1c1c). Every other settings capture,
the font-size capture and the chat transcript were taken again at the same commit and are
pixel-identical to their round-12 or round-13 captures, so their earlier verdicts stand and
they are not repeated here.

Fable 5.1 **READY, 8.5/10**; Opus 5.5 **READY, 8.5/10**. Both confirmed every round-13 fix
and found no change to the chat surfaces.

## Where every surface stands

| Surfaces | Last reviewed | Opus 5.5 | Fable 5.1 |
|---|---|---|---|
| Chat: sidebar, transcript, tools, composer, menus | round 8; unchanged in rounds 12–14 | READY 8.5 | READY 8.5 |
| Settings part 1: frame and nav, General, Appearance, Workspace, Models, Subagents, Memory | round 12; Workspace again in round 14 | READY 8.5 | READY 8.5 |
| Settings part 2: Remote access, Web search, Usage, Archived tasks, Import/export, Daily review, Data, Health, About | round 12; Telegram again in round 14 | READY 8.5 | READY 8.5 |
| Pages and Hosts: Extensions, Scheduled tasks, Daily review, remote Hosts, disconnected state | round 14 | READY 8.5 | READY 8.5 |

## Not done: should-fix items from round 14

Neither reviewer raised a blocker. Their remaining items, with the settings items that
`round-12.md` lists, are the polish backlog.

Fable

1. While a page is shown, the sidebar draws two selected rows: the page entry and the last
   task. Keep one.
2. The scheduled detail's waiting notice and the disconnected banner differ in icon, title
   and padding; make them one banner.
3. In light mode the faded disabled switch shows no thumb, so it reads as missing rather
   than disabled.
4. While the add-Host form is open, 添加电脑 and the form's 保存并启用 are both primary.
5. The skill-location submenu draws the action 创建并打开 and the skill counts in the same
   style.
6. The skill dialog's 路径 wraps to two lines; widen the value column or truncate the path
   in the middle.
7. Offline, the composer drops its controls row for a second sentence; keep the row with
   its controls disabled.

Opus

1. In the runs view, the segmented control is 28 tall and the 近 7 天 select 32. Desktop's
   small toolbar makes both 28.
2. The sidebar's empty task list (还没有任务) and its offline line use different recipes;
   use `EmptyRow` for both.
3. Daily review's disabled 生成分析 is a quiet button. Desktop makes it the primary.
4. Daily review's meta "0 个任务 · 0 个请求" is Desktop's toast text. Its page meta is the
   task count alone.
5. The SSH form's scroll area stops 24 above the plate edge and cuts a label in half.
6. The skill-location submenu widens with the longest path. Desktop fixes it at 420 and
   truncates the path.

Rejected in round 13 and still open by choice: the cron expression in Geist Mono (it
needs that font bundled).
