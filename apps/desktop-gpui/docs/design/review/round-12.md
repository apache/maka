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

# Review round 12 (2026-10-05)

Opus and Fable 5.1 each saw all 88 captures (`round-12/`, taken at e3b6fc9), in three
batches: settings part 1 Opus **READY, 8.5/10**, Fable **READY, 8.5/10**; settings part 2
Opus **READY, 8.5/10**, Fable **READY, 8.5/10**; pages and Hosts Opus **NOT READY, 8.5/10**,
Fable **NOT READY, 8/10**. Both found the chat surfaces unchanged against round 8. This
package (F5) fixes the pages-and-Hosts batch only; where the reviewers and Maka Desktop's
source disagreed, the source decided. 975 tests pass.

Settings pages the fixes reach, for the next review: Workspace (the unfinished-pairing row,
every Host row's "…", the connection code dialog) and Appearance (an anchor around Font
size; nothing drawn differently). `FieldBlock` and `StatusLine` moved to `shared::rows`
unchanged; settings renders them as before.

Captures checked after the fixes (light, zh-Hans): the scheduled task form, the waiting
detail, the task list, the Skill detail, the Add menu's locations, Workspace with the Host
block, the connection code dialog, the disconnected window, and Appearance at Font size.

## Accepted: blockers

| # | Item | Commit |
|---|---|---|
| 1 | One form field in dialogs. The scheduled task form and the connection code dialog are built from `FieldBlock` (label 14/500 ink, 8 to the 32px field, help 12/20 muted 8 below, 16 between blocks), which moved to `shared::rows` with `FieldMark` and `StatusLine`. "∙ 必填" on Title, Task time, Cron and Chat ID, where Desktop sets `isRequired`; the connection code is not marked (Desktop's is not required). Frequency and Delivery are Desktop's group label, `Text type="supporting" weight="medium"`: 12/20 at 500, muted. A field's message is the inline status line. The inline add-Host form already had Desktop's row layout with 14/500 ink titles (`SettingsRow`); unchanged. | b48af57 |
| 2 | The disconnected footer row measures what it holds: the state's words never shrink; the root badge gives way first, with its own ellipsis, down to two glyphs, and is not drawn when that leaves the words no room; then the name gives way, down to two glyphs. The tooltip keeps the endpoint, the spoken label the state and endpoint. | 92bf315 |
| 3 | 有未完成的配对 is Desktop's section row with a trailing 重试配对 (it retries the pending Host's pairing), the section's first row as in `runtime-host-profiles-section.tsx`; with the manual form open it sits under the form's plate. | 19c6d02 |

## Accepted: should fix

| # | Item | Commit |
|---|---|---|
| 4 | One notice, `shared::theme::notice_surface`: warning tint 0.24, `border` ring, radius 10, padding 12/16, ink 14/20; the disconnected banner and the waiting notice take it. The waiting dialog keeps its subtitle; the notice holds only why ("Maka Desktop 连接到这个 Runtime Host 后才会触发。"). 立即触发 is the quiet button, so the detail has no solid button, as Desktop's. | c0622c6 |
| 5 | The form's presets are the quiet button at 28 (Desktop's secondary sm). The footer keeps its one primary: Desktop's form footer has no Cancel by design (`scheduled-task-form-dialog.tsx`: the header's close and Escape are the ways out), so the reviewers' 取消 was not added. | b48af57 |
| 6 | A task row's cron rule is "Cron" then the expression in compact mono 12/20, with no full-width colon before it. The detail's Repeat fact keeps Desktop's "Cron：…". | c0622c6 |
| 7 | The Skill detail's facts with text values (id, path, scope, tools) put the label on the value's first line. The description was not changed: Desktop's is ModulePage's `DialogHeader` subtitle, `Text body sm secondary`, 12px under Maka's tokens, unclamped. | 9d10dba |
| 8 | The Add menu's locations each carry FolderOpen 16, as Desktop's `skills-panel.tsx`. | 9d10dba |
| 9 | Every remote Host row shows its 28px "…" (Desktop always shows `RuntimeHostProfileMoreMenu`), so the switches end on one line. | 19c6d02 |
| 10 | The connection code dialog's description puts each sentence on its own line (en, zh-Hans, zh-Hant). | b48af57 |
| 11 | Offline, the sidebar's placeholders show only while the first attempt (or one the person asked for) runs, or while the list loads once connected; after a failed attempt the list is the EmptyRow "未连接到 Runtime Host" (en, zh-Hant too); a list loaded before keeps showing. The composer's offline note starts on the input's text edge. | 30ed0ec |
| 12 | Widths are Desktop's two: settings 920 less 24 each side (872 of content, unchanged); a module page `contentWidth={900}` with `padding={5}`, which Astryx aligns to 900 less 20 each side, so the pages have 860 of content (was 892). | f14a7d8 |
| 13 | The footer menu's open state is unchanged since round 8 (`round-8/07-footer-menu-light.png` draws the fill the same, short of the settings button); kept. | none |
| 14 | 添加连接… and 管理项目… were not dropped: both are still in the Settings group (`commands.rs`). The two View commands added with the sidebar pages (d7e0eb0) pushed them below the list's 384px fold; they show on scrolling or typing. | none |

## Captures

| # | Item | Commit |
|---|---|---|
| 15 | `--open-settings appearance:font-size` scrolls Appearance's Font size into view. | c6c2bec |

## Not done this round: the settings batches

Both reviewers judged settings parts 1 and 2 READY, so their should-fix items wait for a
later round:

- Fable A: FA1 General's 身份 group has no rule between the 界面语言 row and the tone field
  block; FA2 Memory details' 草稿已保存 is top-aligned; FA3 the connection's model row title
  is 14/400; FA4 the 深色 app icon descriptions wrap to two lines; FA5 the catalog's group
  labels sit on the first row with no rule; FA6 the dark preview pane's edge is faint; FA7
  Pets' 已关闭 row has no control above its EmptyRow.
- Fable B: FB1 a rule under the last row of 接入更多渠道; FB2 a rule under the archived
  list's last row; FB3 正在使用's empty line is 14 ink, not the EmptyRow; FB4 About's rule
  under Maka 源码目录 doubles the 支持 heading's; FB5 the Telegram token has no "∙ 必填";
  FB6 Health's 验证 / 运行态探测 first body line is 14/600.
- Opus A: OA1 custom providers draw a letter disc, not Desktop's Cpu mark; OA2 settings-row
  selects are 160 wide, Desktop's `--settings-control-width` is 260; OA3 account-only catalog
  rows are 60 tall against 55.5; OA4 连接状态 is 14/20 among 12/20 values; OA5 Memory's
  draft label alignment and the double rule under the filter; OA6 the nav group titles are
  14/500 in zh, 12 in en (Desktop 12/600); OA7 the 深色 app icon descriptions wrap to three
  lines; OA8 (Font size never captured) is item 15 above.
- Opus B: OB1 the usage tiles are 101 tall (Desktop ~84); OB2 the usage range control is
  28px with 12 labels beside a 32px 刷新; OB3 Health's layers are full groups, not Desktop's
  sub-headings; OB4 Health's intro is top-aligned against its centred action; OB5
  Telegram's disabled switch reads as enabled-off; OB6 Import's segmented control is 149
  wide, not full; OB7 links underline at rest; OB8 About's Runtime Host row has no dot; OB9
  the daily review's 执行时间 field is ~125 wide (Desktop 110).
