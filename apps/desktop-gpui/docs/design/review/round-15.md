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

# Review round 15 (2026-10-07): the should-fix backlog

Round 14 left every surface READY with both reviewers. Round 15 works through the
should-fix items that `round-12.md` and `round-14.md` left open, so the client is one to
use every day. F7a takes the settings items; F7b, after it, takes the main-window pages.
Desktop at the pin decided every detail. Where Desktop already did what this client did,
nothing changed, and the entry says so.

## F7a: settings

Commits: `11be939` rows and groups, `2f404c1` Models, `d470528` App icon,
`c47af97` links, Usage, Import, About and Daily review.

### Rows and groups (`11be939`)

1. Rules: a group draws its hairline above rows 2 to n only. This was already true for
   every settings page. `SettingsGroup`, the `row_rule` lists (Data, Models, Workspace's
   projects) and the manual Host form all draw rules between rows only, never after the
   last one. A row followed by a field block already got a rule. The round-12 captures
   agree:
   - No rule under Slack (FB1).
   - The rule FB2 saw under the 11th archived row sits above a 12th row cut off by the
     plate.
   - The rule FB4 saw under Maka 源码目录 is the 支持 heading's own rule.
   - The rule FA1 asked for, between 界面语言 and 助手语气偏好, was already there.

   Memory (OA5) did change. Its first sub-header (生效记忆) now follows the filter with
   no rule above it, 16 below the filter, because the filter's rule doubled the
   sub-header's. To do this, `SettingsGroup::follow` adds a child with no rule before
   it.
2. Every select in a settings row is Desktop's `--settings-control-width`, 260 wide. That
   includes the default-Host picker. The page header's Host picker keeps Desktop's 220.
3. Memory's 草稿已保存 now centres on its row (`SettingsRow::centred`). A group with no
   title centres its line on its action, as Health's intro does against 刷新.
4. OC5: the page now scrolls to the plate's edge. The 24 that sat under the scroll area
   moved into the content's bottom padding, which is now 48. Every page ends where it
   did, and the SSH form is cut at the plate's edge instead of 24 above it.
5. The nav group titles (偏好, 能力, 活动, 系统) are 12/600 muted in every locale.

### Models (`2f404c1`)

6. Custom and unknown providers get Desktop's `GenericProviderMark`, the Cpu glyph in
   the disc. Copilot gets it too, as on Desktop. The providers Desktop draws a brand
   mark for keep their initial.
7. Every catalog row is 56 tall, and an account row's badge adds no height.
   - The group labels 推荐 and 订阅计划 were already Desktop's recipe and are unchanged.
     That recipe is Astryx `List header={<Heading level={3}>}`: 16/600, 8 above the
     rows, no rule.
8. 连接状态 now reads as Desktop's: the row's 12/20 muted supporting line, with no dot
   and a red token for a problem.
   - The model row title (FA3) was already 14/500. It is the same `SettingsRow` title as
     every other row; Latin text in SF Medium just reads lighter than PingFang Medium.

### Appearance (`d470528`)

9. The app-icon cards now use Desktop's layout: the thumbnail and the two lines centred
   on the card.
   - At 1512 wide every zh-Hans line already fits on two lines.
   - Deviation from Desktop's copy: zh-Hant 午夜藍 wrapped to three lines, so it is now
     "深藍底搭配亮藍標誌，深色 Dock 上仍有輪廓".
   - Not done: in English, Midnight, Carbon and Hazard still wrap to three lines. That is
     Desktop's copy, and the decision covered only the Chinese strings.
10. The dark 深色 preview already had Desktop's hairline ring (`border`), so nothing
    changed.
11. Pets (FA7) matches Desktop and was left as it is.

### Remote access, Health, Usage, Import, About, Daily review

12. Remote access:
    - The 正在使用 empty line already used `EmptyRow`: 12 muted, the same ink and size as
      the group's line (FB3).
    - Desktop does not mark the Telegram token as required, so it has no mark (FB5).
    - 查看配置文档 is now Desktop's doc link: 14/500 in the link colour, underlined only
      under the pointer (`theme::text_link`, `c47af97`).
13. Health (`11be939`): the layers are Desktop's `settingsRowsSubheading` inside one
    section: the name 12/500 in ink over a 12/20 muted line, padding 12 above and 4
    below. A signal's message is muted and its body weight is 400.
14. Usage (`c47af97`):
    - The period control is the medium segmented control: 32 tall, labels 14/500, the
      selected one 600.
    - The tiles are `.settingsMetricCard`: 6 apart, padding 6/10, 2 between lines.
15. Import (`c47af97`):
    - 导入任务 / 导出任务 is now `layout="fill" size="sm"`: the column's width, with
      equal segments. The source control, which uses the same Desktop recipe, matches it.
    - In dark, the selected segment gets the 1px ring from Desktop's `--shadow-low`. This
      is in `theme::segment`, so it reaches every segmented control.
16. About (`c47af97`):
    - 源码 and 发布说明 now use the line's own ink and size (`Link type="inherit"`).
    - The Runtime Host row shows the Host's name followed by a status dot and words.
17. Daily review (`c47af97`): the 执行时间 field is 110 wide. It had been 126, because
    the comment said 110 but the rem value was wrong.

Main-window surfaces these changes reach: the dark selected-segment ring appears on the
Scheduled tasks view switch (我的定时任务 / 执行记录), on the Daily review page's range
control and on the sidebar's 按时间 / 按项目 grouping switch. All three match Desktop's
dark `--shadow-low`. The first two were checked in dark captures; the sidebar's was seen
in round 15's captures and is recorded here (Opus B2). Nothing else outside settings
changed.

Tests: `cargo test --workspace` passes all 975 tests.

## F7b: the main window

Commits: `6767411` new task from a page, `897470f` sidebar, `b6f8ca0` banner,
`6ec505a` disabled switch, `ca7c48d` Extensions, `7aae8cb` offline composer,
`f05e913` Scheduled tasks page, `b53dd25` English App-icon lines.

### Bugs from daily use

1. New task from a page (`6767411`). The sidebar's 新任务 button called the sidebar
   directly, so the task was created and selected while the page stayed on the plate.
   The window now leaves the page when the catalog reports `Created`. That covers the
   button, ⌘N, the menu, the palette's New task and a folder chosen first. ⌘N no longer
   leaves the page before the task exists, so all of these paths behave the same, and
   Back returns to the page. The palette's tasks, Daily review's task link and Usage's
   task link already left the page. The task row menu (rename, flag, copy ID, archive,
   delete) does not choose a task.
2. The task that jumped to 今天. The client did not move it, and nothing changed. The
   client sends no write when a task is opened or selected, only `subscription.open`,
   `subscription.ready`, `session.transcript.page` and `session.catalog.query`.
   `session.configuration.update` and `turn.stop` go out only on a user action. On the
   pin's schema, `activity_at` moves only when `last_message_at` does.
   - That task's run had been parked on an AskUserQuestion since 2026-09-26 09:46. At
     2026-10-06 23:45:01 a Host stopped it, closing the question as `turn_stopped` and
     writing an `aborted` event with `abortSource: "user_stop"`. That event became the
     task's last message, so the task moved to now.
   - In the pin, a client's `turn.stop` writes `renderer.stop_button`, and a 197 Host
     shutting down writes `runtime_host.shutdown`. `user_stop` is what Hosts built
     before 2026-09-28 (`c64680be5`) write when they stop their active turns on close.
     The 197 Host now serving `.dev-root` started at 23:48:11, after the stop.
   - So the old Host stopped the turn while it was closing for the move. This was found
     from a read-only copy of `runtime.sqlite` in the scratchpad.

### Decisions

3. FC1 (`897470f`): while a page shows, only its entry draws the selected fill. The task
   row rests and gets its fill back when the task shows again.
4. FC2 (`b6f8ca0`): Desktop draws every notice with Astryx `Banner`: the status glyph,
   8 before a 14/20 semibold title, with any further lines under it. `theme::banner` and
   `banner_title` build it once.
   - The disconnected banner uses it. The gap after the glyph is now 8; it was 12.
   - The scheduled task's waiting notice uses it too, as a banner with a title only.
5. FC3 (`6ec505a`): Astryx fades the whole disabled switch to half. In light the thumb
   is the plate's white, so on its faded track it disappeared. In light, the disabled
   thumb now has a hairline in `border_strong`, the off track's colour. Dark is
   unchanged.
6. FC4: no change. Desktop's 添加电脑 is `variant: 'primary'` even while the manual form
   is open, beside the form's primary 保存并启用. Only its last menu item changes, to
   取消, and this client already does that.
7. FC5 and OC6 (`ca7c48d`):
   - The Skill locations submenu is Desktop's `menuWidth={420}`.
   - A menu item's detail is one line ending in an ellipsis, as Astryx's string
     description is. Desktop shows no tooltip for it, so this client shows none.
   - Desktop gives 创建并打开 and the counts the same `endContent` recipe, drawn in the
     row's own type (14, ink). Both now use that recipe; they were 12 muted.
8. FC6 (`ca7c48d`): Desktop's detail is a `MetadataList` with a 120 label column (this
   client already had it), 16 before the value (this client had 12, now 16), and a
   `break-word` value. A long 路径 wraps to two lines on Desktop too, so it still wraps.
9. FC7 (`7aae8cb`): offline, Desktop's composer keeps its controls row and adds no
   sentence.
   - The draft's placeholder now carries the reason (未连接到 Runtime Host，连上后即可发送。).
   - The note no longer repeats it.
   - Attach and the model and permission pickers stay in the row, disabled.
10. OC1 (`f05e913`): the controls in the page toolbar are Desktop's `Toolbar size="sm"`.
    The view switch, search, sort, filter and range are all 28 tall, centred and 12 apart.
    The range select stays 148 wide.
11. OC2 (`897470f`): Desktop's list has no empty line. To use one recipe for both lines,
    还没有任务 now uses the inline `EmptyRow`, as 未连接到 Runtime Host does: 12/20 muted,
    8 under the list's top.
12. OC3 and OC4 (`f05e913`):
    - 生成分析 is Desktop's `primaryAction`: primary, and faded while disabled.
    - The page meta is `archive.sessionCount` (`{n} 任务` / `{n} 任務` / `{n} task(s)`).
      `reviewSummary` remains only as the export toast's body.
13. F7a's open item (`b53dd25`): the English Midnight, Carbon and Hazard lines are
    shorter than Desktop's so that they fit two lines at 1512 wide. This is a deviation
    from Desktop's copy.

No captures were taken. The one attempt found the screen asleep, and after that the user
asked that no app windows be launched. Tests cover each item; the visual checks are still
open. Tests: `cargo test --workspace` passes all 977 tests.

## Round 15 review

All six reviews (Fable A, B, C and Opus A, B, C) are READY at 8.5/10, over the 92
captures of `66d74f1`. Two items were regressions from this round:

- About (Opus B1): 源码 and 发布说明 had lost the link colour. Desktop's
  `Link type="inherit"` inherits only the size and line height.
- The offline composer with no task (Fable C1, Opus C1): its controls row held only
  Send, because attach needed a task and the pickers needed its settings.

The rest were should-fix items. F8 takes them all.

## F8: round 15's findings

Commits: `f7271ab`, `6e1f3bc`, `fb7840e`, `174d627`, `d0d88cc`, `79562f3`, `867592d`,
`18a592b`, `fe7ac05`, `143fabc`, `8e9d86a`.

1. About (`f7271ab`): the links are `theme::text_link` in the link colour at 12/20,
   underlined under the pointer. A text link's line is now 20 tall.
2. Offline composer (`6e1f3bc`): the row always draws attach, which is disabled without
   a task. Offline or with no task, it also draws the model chip (the model last
   shown, else 模型) and the permission chip (自动, the mode a new task starts in).
   Both are disabled.
3. Health (`fb7840e`): the summary is Desktop's `SettingsStatusSummaryFilter`.
   - Each count is a ghost sm button with no dot, 14/20 muted in equal-width figures.
   - A zero count is disabled and in the disabled ink.
   - Only a warning or an error above zero takes its colour.
   - The footnote was already Desktop's supporting sm line, 12/20 muted (Fable B5).
4. Selected cards (`174d627`): the chosen card adds Desktop's 2px inset accent ring
   inside its 1px accent border. The ring is an inset shadow, so nothing moves.
5. App icon (`d0d88cc`):
   - The import help closes the section, 12 under the last group, 12/20 muted.
   - The zh-Hans 午夜蓝 and OLED 纯黑 lines are shorter: 深蓝底亮蓝标，Dock 上有轮廓 and
     纯黑底，OLED 上只剩标.
   - `--open-settings appearance:app-icon-end` scrolls to the last group (高对比),
     where the Hazard card is.
6. Models catalog (`79562f3`): the 需 Maka Desktop badge fades with its row, as the
   mark does.
7. Confirmations (`79562f3`): Desktop's `toast.confirm` is Astryx `AlertDialog`. Its
   `Layout` takes the dialog's default padding, `--spacing-4` (16), on every side and
   between the text and the buttons. Maka's theme sets no `--astryx-dialog-padding`.
   Every confirmation, Full access's among them, is now 16 all round. It was 20; the
   review asked for 24, but the source says 16.
8. Memory (`867592d`):
   - 归档 and 复制引用 are ghost sm buttons, 28 tall and 8 apart.
   - The MEMORY.md editor already wrapped long lines, because soft wrap is the kit's
     default. A test now holds it.
9. Empty lines (`867592d`):
   - Pets' empty state is Desktop's compact `EmptyState`: the title centred at
     14/600 over its line (12/20 muted), 8 apart, with 16 around.
   - 还没有远程 Host is Desktop's `SettingsRow` with only its label, 14/500.
10. Usage (`18a592b`): the tiles were already 6 apart. A test now holds it.
11. Telegram (`18a592b`): the detail header's disc is Desktop's 36 (`.settingsBotLogo`
    `data-large`); it was 40. The list keeps 32.
12. Daily review (`fe7ac05`): 今天 is 14/500, centred on the toolbar's 28.
13. Small buttons (`fe7ac05`): Discover's 安装 and the scheduled detail's 延后 10 分钟 and
    立即触发 are Desktop's size sm, 28 tall.
14. 配对未完成 (`143fabc`): Desktop's `<Badge variant="warning">`, the solid #FFCE2F
    fill with #111 ink in both modes. These are two new palette roles.
15. Connection code (`143fabc`): 添加电脑 › 使用连接码 is disabled. Its tooltip says why:
    此客户端暂不支持 Direct peer，请使用手动配置. The dialog is unchanged. A menu item can
    now carry a tooltip.
16. Banners (`8e9d86a`): the waiting notice's title is the phrase 需要 Maka Desktop. The
    sentence follows on its own line at the regular weight, as in the disconnected
    banner, which already had that shape.

No captures were taken: the user did not allow app windows for this package. Tests cover
each item. The visual checks are still open. Tests: `cargo test --workspace` passes all
979 tests.
