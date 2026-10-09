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

# Review round 13 (2026-10-05)

Round 13 re-reviewed only the pages-and-Hosts batch (`round-13/`, 34 captures taken at
104eb80); both settings batches were READY for both reviewers in round 12. Fable 5.1
**READY, 8.5/10**; Opus **NOT READY, 8.5/10**. Both confirmed every round-12 fix and found
no change to the chat surfaces. This package (F6) fixes the batch; where the reviewers and
Maka Desktop's source disagreed, the source decided. 975 tests pass.

Settings pages the fixes reach, for the next review: Workspace (Host rows: the bare Cpu,
the badges in the end slot, the faded disabled switch; the unfinished-pairing row now above
the manual form; the project rows' bare FolderOpen), and every page with a switch that can
be disabled, which now fades whole while disabled and is unchanged otherwise: General
(including Network), Appearance (app icon), Models (a connection's model list), Subagents,
Memory, Remote access (Telegram), Web search, Daily review. The shared menu's change (one
current row in a submenu) reaches no settings menu: none has a submenu.

Captures checked after the fixes (zh-Hans): Scheduled tasks, Daily review, Extensions and
its Add menu (light); Workspace with the Host block (light and dark), Workspace with the
manual form (light), and the disconnected window (light).

## Accepted: blockers

| # | Item | Commit |
|---|---|---|
| 1 | OC1. The Daily review metric strip is Desktop's (`daily-review.css`): four labelled numbers on a fixed 4-up row, 24 between the columns, 8 above and 20 below, no ring, radius or padding; labels 12/20 muted, values 16/24 600 tabular. | 813e399 |
| 2 | OC2 + FC5. One page bar under the header, Desktop's `.maka-module-page-bar`: the tabs at the start and the view's controls (我的定时任务 / 执行记录 with the range; 今日 / 最近 7 天 / 最近 30 天 with ‹ 今天 ›) at the row's end, gap 12, wrapping with 8 between rows, 16 + 12 under the header, no rule. The tabs are label only (`shared::theme::page_tabs`): 14/20 muted, the selected one ink 600 with a 2px accent indicator, no rail. The header's icon actions (the scheduled "…", the review's gear) are 32, the height of the button beside them. The day label keeps Desktop's 9rem so the stepper does not move. Extensions has no bar: it has one tab (MCP is Desktop's own), as before. | 813e399 |

## Accepted: should fix

| # | Item | Commit |
|---|---|---|
| 3 | OC3. A Skill row (installed and Discover) is Desktop's `ModuleRow`: description body 14/20 muted; the mark Desktop's `.maka-module-market-icon`, 28px at the plate radius (27%, `plate_radius`), the initial 12/600. Desktop's scheduled rows are not `ModuleRow`s, so they keep their own recipe. | e4915e8 |
| 4 | OC4. The detail's 执行记录 is Desktop's `Text type="label" color="secondary"` (14/500 muted); the fact labels are `MetadataList` labels, 14/500 muted. | 813e399 |
| 5 | OC5. A disabled switch is drawn whole at half strength, track and thumb, as Astryx's `trackDisabled` (`FadedSwitch`): gpui-kit fades the track only, and GPUI's opacity is per primitive, so a disc of the surface at half strength covers the thumb, the pixels a grouped fade gives. Dark now reads disabled; in light the white thumb on the white plate stays where a grouped fade puts it. Every switch that can be disabled takes it, Telegram's included. | 3f89135 |
| 6 | OC6 + OC7. Host rows start with the bare 16px Cpu and project rows with the bare 16px FolderOpen (Desktop's `startContent`); a Host row's badges, 配对未完成 among them, sit in the end slot before the switch (Desktop's `endContent`). 有未完成的配对 comes before the manual form's plate when the form is open, as Desktop renders it before `showAdd` (`SettingsGroup::above_lead`). | 3f89135 |
| 7 | OC8. 使用模板 is a ghost button at 32 (no fill at rest). | 813e399 |
| 8 | OC9 + OC10. Run rows are 56 like task rows (their message 12/20), so both lists pitch 57 with the rule. The page meta sits on the title's centre line (Desktop's `HStack vAlign="center"`). | 813e399 |
| 9 | FC1. Desktop disables none of 新任务, 扩展 and 定时任务 (`session-sidebar-nav.tsx`); 新任务 is now enabled offline too, and a press shows why no task starts (连接到 Runtime Host 后才能新建任务). The two pages keep their "未连接到 Runtime Host" lines. | fa28a48 |
| 10 | FC2. The disconnected banner's 重试, and the blocked window's, are label only, as Desktop's retry buttons. | fa28a48 |
| 11 | FC4. Desktop's run description is the Host's `run.message` and its task description a "·"-joined list of fragments; neither has a Maka Desktop line, since Desktop is Maka Desktop. A fire waiting for it now reads as its state, 等待 Maka Desktop 投递, with no full stop, like the fragments beside it. | 813e399 |
| 12 | FC6. While a row of an open submenu is highlighted, the item that opened it gives up its fill and stays expanded; opening a submenu for a capture rests as the pointer does, with no row of the submenu highlighted until the keyboard moves in. | e4915e8 |

## Rejected

| # | Item | Reason |
|---|---|---|
| 13 | FC3, a reachability dot per Host in the footer's Runtime Host submenu. | Desktop has no such switcher and no per-Host status in one; left as it is. |
| 14 | FC7, the cron expression's gaps. | The stored expression and the row's text have single spaces (`30 18 * * *`); the run is in the theme's mono family, which gpui-kit resolves to Menlo on macOS, and the gaps are its one-cell spaces. Desktop's code font is Geist Mono Variable, which Desktop bundles; this client bundles no fonts, so matching it means bundling Geist Mono, a change of its own. |

## Not done this round

The settings batches' should-fix items listed in round 12 (FA1–FA7, FB1–FB6, OA1–OA7,
OB1–OB9) still wait; OB5 (Telegram's disabled switch) is item 5 above. Desktop's Daily
review header has no settings gear; the gear stays (it opens the Daily review settings page),
now 32px.
