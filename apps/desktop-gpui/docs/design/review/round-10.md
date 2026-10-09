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

# Review round 10 (2026-10-05)

Fable 5.1, in three batches: settings part 1 **NOT READY, 8/10**; settings part 2 **NOT READY,
8/10**; pages and Hosts **NOT READY, 7.5/10**. Opus did not review this round: its review was
stopped before it read the captures, so there is no Opus verdict. The captures (84) are in
`round-10/`. Six blockers and fourteen should-fix items were accepted; four of them needed no
change, with the reasons below. Nothing was rejected. All fixes are covered by the test
suite (970 tests); captures checked 2, 4, 5 and 7 only, because the screen was locked from then
on, so the rest still need a capture round.

## Accepted: blockers

| # | Item | Commit |
|---|---|---|
| 1 | A hovered settings nav row read as the selected one (A3, B1). As Desktop's `SideNavItem`: the selected row keeps the `selected` fill and its label takes weight 500; another row under the pointer takes half that fill and keeps its text (`shared::theme::selectable_row`). The main sidebar keeps its round-8 look. Extensions' and Scheduled tasks' rows, whose detail is a modal, are never drawn chosen (see 17). | 58e6e89, f05bfb1 |
| 2 | The Subagents back link was centred across the column (A1). Every sub-page (Subagents add and edit, the Models catalog, setup and detail, Remote access' bot pages, the daily report) uses `shared::theme::back_link`: a 32px ghost button, ChevronLeft 14 muted and the label 14/500, its chevron on the column's edge, 24px above the sub-page's title. | 58e6e89 |
| 3 | A memory entry had no row (A2). Title 14/500, source and age 12 muted, text 14 muted in at most two lines, Archive and Copy reference as quiet buttons in the trailing lane, centred on the row. | 9d37675 |
| 4 | Scheduled detail's Delete was the kit's solid danger fill (C1). It is `destructive_button`; it was the only non-confirming kit danger button. Confirmations keep their solid final button. | 38c0078 |
| 5 | Two secondary recipes (C2). Every labelled non-primary row, page and dialog action on the Phase 3 surfaces (and the data folder dialog, the Host blocked screen, the disconnected banner, the open-failure Retry) is a 32px `quiet_button`; a confirmation's Cancel, which gpui-kit builds, takes `quiet_variant`. The permission prompt's Deny keeps its round-8 recipe: it answers a prompt in the transcript. | 38c0078 |
| 6 | Control heights (C3, C4, C13). Labelled actions and text fields are 32px, radius 10: Extensions' and Scheduled tasks' search and header actions, Scheduled tasks' selects, the settings Host pickers, the connection code (one line now). Use template was clipped to 28px by the dialog header's 24px row; with a labelled action the row is 32px. | 38c0078 |

## Accepted: should fix

| # | Item | Commit |
|---|---|---|
| 7 | Dialogs sat a tenth of the window down (A4). They are centred from the frame before: the header records its top, the footer (`with_footer`), a confirmation's text (`confirmation_text`) or `dialog_end` where the dialog ends. Confirmations are 400px wide with 20px padding. | 235d7b9 |
| 8 | The palette swatch read as a glitch (A5). It is Desktop's mark: one 32px disc in the palette's light accent in a 2px border ring. | a315fc5 |
| 9 | Mono values (A6, A10): Models' service URL, Workspace's project paths and the memory file's path are compact mono 12/20. App icon cards top-align their content. | a315fc5 |
| 10 | Memory's count showed twice; it stays in the sub-headers, and the filter shows only its matches. The proxy description ends with a full stop in all three locales (A7, A8). | 9d37675 |
| 11 | Dark text fields drew a fill and a ring (A9). Every Input, Textarea and NumberInput takes `FieldFill`, the plate under the ring; light already did. | a315fc5 |
| 12 | Two caption recipes under form fields (B2). `FieldBlock`'s help is the one: 12/20 muted, 8px below the field; Telegram's token help is its caption, and the proxy captions lose their parentheses. | a315fc5 |
| 13 | Usage's bare refresh icon, the shared grey dot, mixed range units (B3, B7, B9). Usage has Health's "最近一次读取" line and labelled quiet Refresh; Health's Info is text only; the range reads 24 小时 · 7天 · 30天 · 全部. | 9179da3 |
| 14 | Import with one source shows it as a value row; archived rows lose the leading icon (B5, B6). | a315fc5 |
| 16 | The waiting notice wrapped with "，" at a line start (C5): its two sentences are two lines, neither of which wraps at the dialog's width. | 9179da3 |
| 17 | The source row's wash under a modal scrim (C6): it was the selected fill of the row whose detail was open; those rows are never drawn chosen. The kit's dialog root already occludes the window, so no hover reaches a row under a dialog or a menu, and the settings surface replaces the sidebar and plate. | f05bfb1 |
| 18 | Daily review (C7, C8): the tab's headings sit on the column's edge with the tiles; the empty state has a line under it; the meta is Desktop's "0 个任务 · 0 个请求"; Generate analysis is quiet and disabled until there is activity. | 78d4078 |
| 19 | The pairing notice points at a Host menu that did not show (C9): its "…" was laid out but drew no glyph. It is a 28px ghost icon button, shown on row hover, focus or while its menu is open, and always on a row whose pairing is unfinished. | 03402fc |
| 20 | One badge for "needs Desktop" (C12): Scheduled tasks' end lane uses the shared 20px badge, as Models' account rows do. | 7175acf |

## Accepted, no change needed

- **B4, list-row titles 16/400.** The bot and Health row titles are already the settings-row
  title, 14/500; the captures measure 14px.
- **B8, light off switch on ink 8%.** The off track is `border_strong`, ink 16%; the capture
  measures 216/255 on white. gpui-kit's switch thumb takes no ring.
- **C10, "导入本地 Skill…".** Desktop's zh string in the same place is "导入本地 Skill"
  (`skills.page.importLocal`), so Skill stays.
- **C11, no Delete in the skill dialog.** Delete is there (`destructive_button`, footer left)
  for a skill the Host manages; the reviewed skill is a project skill the Host does not manage.
