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

# Review round 11 (2026-10-05)

Opus and Fable 5.1 each saw all 84 captures (`round-11/`), in three batches: settings
part 1 Opus **NOT READY, 8/10**, Fable **NOT READY, 8/10**; settings part 2 Opus
**NOT READY, 8.5/10**, Fable **READY, 8.5/10**; pages and Hosts Opus **NOT READY, 8/10**,
Fable **NOT READY, 8/10**. Where the two disagreed, Maka Desktop's source decided. This
package (F4a) did the seven shared recipes both reviews blocked on and the settings items;
F4b does the main-window pages, the Host surfaces and the capture flags (below) and appends
its commits. All F4a fixes are covered by the test suite (970 tests). Captures were checked
for General, the Models catalog, setup and detail, Subagents, the full-access confirmation,
Health, Data, Appearance (light and dark), the app icon grid in zh-Hans, zh-Hant and en,
Telegram, Usage, Import and Memory; About, Archived, Web search and dark mode in general
still need the next capture round.

## Accepted: shared recipes

| # | Item | Commit |
|---|---|---|
| 1 | One inline edge. Rows no longer indent from their heading: settings rows, empty rows, field blocks, connection, catalog, project, bot, archived, memory, Health, subagent, usage, web search and Host rows sit on the column's edges, trailing controls on its right edge. A row with a fill (`settings::rows::list_row`) spans exactly the column, square but for the group's outer corners on its first and last row (rows.css); `row_rule` is the hairline between rows of a list built outside a group. Disclosures (`shared::theme::disclosure`) put their chevron on the edge. Desktop's Astryx `Item` in fact keeps 8px of inline padding (its `settings-section.tsx` comment says flush); the review asked for one edge, so the rows are flush. | 23e9061 |
| 2 | One form field. `FieldBlock`: label 14/500 ink, Desktop's "∙ 必填" / "∙ 可选" mark at 12 muted where Desktop marks (API key, account id, service URL, model id), 8 to the 32px field, help 12/20 muted 8 below, flush, 16 between consecutive blocks with no rule (`SettingsGroup::field`). Models add and edit, the model parameters dialog, Subagents, General's tone, display name and shell path, Memory's add and editor, the proxy and the bot forms use it; gpui-kit's form is gone. The Telegram proxy's `http://127.0.0.1:7890` is Desktop's default value (`createDefaultBotChannel`), not a placeholder, so it stays ink. | 23e9061 |
| 3 | One back link. `back_link` is ArrowLeft 16 muted and the label 14/500, its arrow on the edge (Remote access' bot pages, the daily report). The Models catalog, setup and detail and the Subagents editor follow `SettingsRouteHeader`: the page keeps its title and line, as Desktop's settings header does, and the back arrow is an icon button beside the sub-page's title (`shared::theme::route_header`), so the sub-page loses a row. Fable's suggestion to drop the page line was not taken: Desktop keeps it. | 23e9061 |
| 4 | One status helper, Desktop's `.settingsStatus`: 8px dot, 6px, 14/20 regular muted (`page_kit::status_dot`); every status has its dot. The bot header and rows, Web search's model source, Memory's file state, Health's rows, the connection list and the detail's 连接状态 (now "● 未测试 · …") use it. | cabb9c5 |
| 5 | The add-connection stepper is Desktop's compact Astryx `Stepper`: two equal steps under a 4px bar each (primary once reached, border ahead), a 16px numbered disc and the name at 14; the step ahead has a wash disc and muted figure and name. | fd5f159 |
| 6 | Control contrast. Desktop draws an unchecked checkbox, a field's ring and the off switch track all in `--border-strong` (ink 16%, about 1.5:1 on white, under 3:1). The checkbox and field ring took it (they were ink 10%); the switch already had it. Desktop's tokens are as light, so nothing goes darker than Desktop. | 2444b6b |
| 7 | The settings scroll ends 24px above the plate's edge. | 23e9061 |

## Accepted: settings, part 1

| # | Item | Commit |
|---|---|---|
| 8 | Confirmation answers at 14/500 and 32px (`shared::dialog::confirmation_answers`, every settings confirmation); gpui-kit's footer drew 16px. | 43dd68f |
| 9 | Appearance: previews round their panes inside the 6px frame; the swatch has Desktop's inner ring of white at 25%, so Minimal gray's disc shows on the dark plate; cards are `page_kit::selectable_card`, whose ring stays under the pointer with the hover wash inside it. | 9d35aad |
| 10 | App icon cards: the art's visible edge sits on Desktop's 8px padding and 8px from the text (the tile's transparent margin had added 4.5 to each). No zh-Hans or zh-Hant line now ends on one character; zh-Hant's mono black line takes zh-Hans's wording. English lines are Desktop's and wrap by words. | 9d35aad |
| 11 | Add actions are labels only, as Desktop's: 添加连接, 添加项目… and 添加子 Agent lose their Plus. | 43dd68f |
| 12 | An empty state's action is 16px under its words. | 43dd68f |
| 13 | The model row's wrench is a 28px ghost icon button. | 23e9061 |
| 14 | A group with nothing under its heading draws no rule (Memory's collapsed file group). Desktop draws the divider there; the review's second option was taken. | 23e9061 |
| 15 | One filter, Desktop's catalog search (`settings::rows::filter_field`): full width, search glyph, the field's own clear; the provider catalog, Memory's filter (its separate Clear goes) and a connection's model filter. | 43dd68f |

## Accepted: settings, part 2

| # | Item | Commit |
|---|---|---|
| 16 | Health's summary follows `summaryParts`: a count is toned only above zero and only for warnings and errors; 提示 has its dot. The intro is the section's description under no title, with its rule, as Desktop's Health section. | cabb9c5 |
| 17 | About: the version row is "Maka GPUI" (the Host reports no Maka version, so no second row); the line is 版本与支持。/ Version and support. / 版本與支援。 | 5cffff2 |
| 18 | Telegram: the switch alone at the end, centred on the title line; 查看配置文档 in the body column 8 below the help (body 14 muted), per bot.css. The runtime group keeps the readiness as its title: Desktop's `bot-chat-detail.tsx` titles it the same way. | 5cffff2 |
| 19 | Import with one source is Desktop's bare 来源 section: title, source name under it, rule, paragraph, 选择文件…. | 5cffff2 |
| 20 | Data: the category rows take the rule between rows, as every row of a group. | 23e9061 |
| 21 | Usage: the chosen tab's count is ink; 24 小时 · 7 天 · 30 天, one unit word and one spacing; the summary-only line is centred on 显示明细; the model calls tile has a line (the models the calls went to; Desktop's has none). | 5cffff2 |

## F4b: main-window pages, Host surfaces, capture flags

F4b takes the pages-and-Hosts batch: Extensions, Scheduled tasks, the daily review, the
remote Host surfaces (the projects page's Host block, the manual Host form, the footer
menu, the disconnected state) and the capture flags. Shared pieces F4a added for it to use:
`shared::dialog::confirmation_answers` (the main-window confirmations in Extensions,
Scheduled tasks and the sidebar row menu still use gpui-kit's 16px footer),
`shared::theme::{route_header, disclosure}` and the ArrowLeft `back_link` (already in the
daily report), `settings::rows::{list_row, row_rule, filter_field, FieldBlock, FieldMark}`
and `SettingsGroup::field`, and the field ring at `border_strong` app-wide.

F4b commits:

| # | Item | Commit |
|---|---|---|
| B1 | The disconnected banner is DESIGN.md's tinted surface: the warning's 0.24 tint (`theme::tinted`), a `border` ring, radius 10, padding 12/16, the column's width (the reading column; a page's content width on a page), the icon 16 alone in warning ink, title 14/600 and body in ink, the reason in compact mono 12/20, a 32px quiet Retry inside, right-aligned and centred on the title line; no rule under the strip. The local Host's start command sits inside it too. | a76a1f2 |
| B2 | Offline, the composer says "未连接到 Runtime Host，连上后即可发送。" (en, zh-Hant too) and the suggestions are disabled: disabled ink, no hover, no click. | a76a1f2 |
| B3 | The footer's Host name keeps 80px before it gives way, the root badge is at most 104 with its own ellipsis, and the endpoint (a local Host's data folder) is the row's tooltip. | a76a1f2 |
| B4 | One edge on the pages: Extensions, Scheduled tasks and the daily review put headings, notes, row marks and rules on the title's edges; rules span the column and come between rows only (an installed item that drew no row left a rule under the last). `settings::rows::{row_rule, list_row, EmptyRow}` moved to `shared::rows` so the pages use the same pieces. | 8af62bb, d8c6f54, 5144ec9 |
| B5 | The Extensions Add menu, Add computer, a Host row's "…" and the Scheduled tasks "…" are `shared::menu` (32px rows, radius 6, 4px padding, 16px icons) instead of gpui-kit's PopupMenu, which fixes 26px rows, 12px icons and radius 8 with no hook. Items take a second line and end words (a location's folder and count); `MenuSlot` keeps one trigger's menu; a right-aligned menu opens its submenus on its left. | f8cf1c8, de5be6e |
| B6 | Dialog lines are 12/20, 8 under the title (the Skill detail's description); the Skill detail's id and path are compact mono 12/20. | d8c6f54 |
| B7 | Widths: 400 confirmations, 480 forms (the connection code dialog moves from 520), 560 details. One dialog section heading, 14/600 ink, 16 above: the form's Frequency and Delivery and the detail's Runs. The main window's delete confirmations (Extensions, Scheduled tasks, the sidebar's task menu) answer at 32px with `confirmation_answers`. | d8c6f54, 5144ec9, 8af62bb |
| B8 | Scheduled tasks say their state once, as Desktop's row: the end lane is the countdown (12/20 muted, tabular) or, when the task will not run (paused, or a fire past its time waiting on Maka Desktop), its state; the line says the state only when the lane does not; the badge goes. The waiting run in the detail was made up by the client and goes (the notice says it); the detail's subtitle is the row's state, and with no runs it shows the empty line. | 5144ec9 |
| B9 | Run history lists the runs and the waiting fires together, newest first; the toolbar keeps 32px with or without the range select. | 5144ec9 |
| B10 | The sidebar's scheduled-task count sits in the 40px age lane, 12/20 muted, tabular (it was 12 already; the lane is what moved). | 8af62bb |
| B11 | Daily review: the next-day chevron at Today is in the disabled ink; Active tasks with none is the EmptyRow (12 muted, no icon; the help line Desktop does not have goes). | 8af62bb |
| B12 | Workspace: the default Host's select takes the header picker's recipe and 220 width; the header picker is labelled "此窗口" (12 muted; Desktop hides its label); endpoints are compact mono 12/20; Rename and Archive are 8 apart. F4a's flush rows had already put the project and Host rows, the row menu and both selects on one pair of edges; a test now holds them. | 73e9a35 |
| B13 | The manual Host form's fields already ended at its buttons' edge after F4a; a test holds it. | 73e9a35 |
| B14 | A `--passive` launch puts a clear occluding layer over the main view's content (`PassivePointer`), so the real pointer hovers nothing under it; menus and dialogs draw above it. | 64da641 |
| B15 | `--open-footer-menu host` opens the footer menu on the Runtime Host submenu (once more than one Host is listed); `--open-footer-menu` alone still opens Language. Both, and `--open-add-menu`, now open their menus directly instead of through keys, which hung on where focus was. The Host switcher capture: `--hosts-dir target/demo-hosts --open-footer-menu host`. | 64da641, f8cf1c8 |

Captures checked after the fixes (light): the disconnected banner (also dark), Extensions with the Add menu and its locations submenu, the Skill detail, Scheduled tasks, its waiting detail, the daily review, Workspace with the Host block, and the footer's Host switcher in light and dark. 974 tests pass. The pointer check of B14 was done by test (a click on a covered row does not reach it); a live capture with the pointer on a row was not possible: posting a pointer move needs an Accessibility grant this terminal does not have, and the pointer, wherever the person had it, sat between rows in the one capture taken.
