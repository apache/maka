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

# Review round 16 (2026-10-07): F8's changes

Round 16 reviewed the 49 captures that F8 changed (`5ece084`, `docs/design/review/round-16/`).
The other 47 are pixel-identical to round 15 and keep its READY. Desktop at the pin decided
every detail.

## Verdicts

| Surface | Fable | Opus |
| --- | --- | --- |
| Settings (31 captures) | READY, 8.5/10 | READY, 8.5/10 |
| Pages and Hosts (18 captures) | NOT READY, 8/10 | NOT READY, 8/10 |

Pages and Hosts share one blocker: disabled composer controls drew like live ones.

## F9: round 16's findings

Commits: `4647610`, `512cce2`, `dda22ef`, `6e324ec`, `51ac0e4`.

1. Disabled composer controls (FP1, OP1; `4647610`), the blocker. `chip()` set its
   label's ink itself, so the kit's disabled colour never reached it. Offline, the model
   and permission chips, the attach "+" and, during a running turn, the model chip
   (MODEL_BUSY) all drew in full ink. A disabled chip now takes Astryx's disabled recipe,
   the whole control at half strength (`theme::DISABLED_OPACITY`, which the faded switch
   uses too): label, chevron and the "+" glyph. The tooltips stay. `chip()` takes the
   disabled state itself, so its look cannot drift from it. A test holds that a
   disabled chip's label is not full ink.
2. Banners (OP2, OP3; `512cce2`): the notice is Astryx's Banner header.
   - No ring and the container radius, 12. Round 11's B1 gave the ring and radius 10
     as DESIGN.md's tinted surface, with no Desktop source; Desktop's Banner header has
     neither, so B1's reason does not hold.
   - The description is the supporting size, 12/20, directly under the title. Astryx
     colours it `text-secondary`; it stays ink, as the Tinted Surface Rule sets text on
     a tint (Desktop's `maka-tokens.css` does the same for the info banner).
   - The waiting notice: title 需要 Maka Desktop, description 连上这个 Runtime Host
     后才会触发。 (en "It fires once connected to this Runtime Host.", zh-Hant 連上這個
     Runtime Host 後才會觸發。). The subtitle keeps 等待 Maka Desktop 投递, so the detail
     names Maka Desktop twice, not three times. Desktop has no copy for this state.
3. Daily review (OP4; `512cce2`): the date is Desktop's `Text type="label"
   weight="semibold"`, 14/600 again, centred on the toolbar's 28. F8 made it 500 on
   round 15's FC2, which was wrong.
4. 重试 in the disconnected banner (OP5; `512cce2`): Desktop's `size="sm"`, 28, centred
   on the title's line. A test holds both.
5. Scheduled detail facts (OP6; `512cce2`): Desktop's `MetadataList`: label column 88,
   value 16 after it, rows 20 tall and 8 apart. They were 12 after and 32 apart.
6. Connection code (FP2, OP7; `dda22ef`): 使用连接码 is disabled, so only the
   `projects:code` capture flag opened the dialog. The dialog, the flag, its copy, its
   test and the code-only refusal sentences are gone. The menu entry stays disabled with
   its tooltip. `h-projects_code` is out of the capture script; its round-16 captures
   stay as the record.
7. App icon lines (FS1, OS1; `6e324ec`): zh-Hans 午夜蓝 is 深蓝底配亮蓝标, its siblings'
   pattern. Measured at 12px against the card's ~156 column, three zh-Hant lines also
   wrapped, and now follow their zh-Hans ones: 深藍底搭配亮藍標誌, 純黑底，OLED 上只剩標誌,
   黑底黃標，本組對比最高. Measured the same way, every zh-Hans and zh-Hant card line now
   fits one line at 1512.
8. Full access (FS2, OS2; `6e324ec`): zh-Hans and zh-Hant drop 将 and 你的 (本地工具直接
   读写文件并访问网络…). At the dialog's 368 the text breaks after 保护层。 into two
   lines. Dropping 你的 alone would have started the second line with 。.
   English already wraps to four lines, the shortest "their environment.".
9. `appearance:app-icon-end` (FS3; `51ac0e4`): the page's end stops the scroll short of
   the last group, so scrolling to that group cut through the one above it (莫兰迪 in
   en). The page now scrolls to the deepest group whose header can sit first under the
   top edge. A test holds it, and fails on the old scroll.
10. About (OS5; `51ac0e4`): the license line's separators are Desktop's `' · '` text
    with no flex gap, so every gap matches the one inside the license.

### Rejected

- OS3, OS4 (size sm 28 and ghost variants for section and row actions such as 导入图标…,
  刷新, 复制路径): round 9 matched these to Desktop's rendered Data page (32, ink 6%
  fill), and both reviewers have accepted that recipe for six rounds. A reading of
  source props alone does not overturn the rendered evidence. Left for the core team to
  check against a running Desktop.
- OS6 (card titles 12/500): the reviewer asked to check against a Desktop capture first;
  none is available.
- OS7, FS5 (Health's non-zero neutral counts in ink, 正常 in success ink): the two
  reviewers disagree and Desktop's rendering is unverified. F8's recipe stays.
- FS4 (top-aligned card text): Desktop centres; parity.

FP3 (the scheduled detail's 删除 as a red tint, where Desktop passes
`variant="destructive"`) was not part of F9 and stays open.

No captures were taken: the package allowed no app windows. Tests cover each item; the
visual checks are open for h-disconnected, p-scheduled-waiting, p-daily-review,
s-appearance_app-icon (and -en), s-appearance_app-icon-end (and -en),
s-general_full-access and s-about, plus a composer during a running turn (the
MODEL_BUSY chip) and the zh-Hant app icon lines, which no capture shows. Tests:
`cargo test --workspace` passes all 979 tests.
