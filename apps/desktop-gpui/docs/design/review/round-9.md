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

# Review round 9 (2026-10-02)

Opus: **NOT READY, 7/10**. Fable: **NOT READY, 7.5/10**. The round covered the Phase 3
surfaces (settings pages, Extensions, Scheduled tasks, the remote Host form) for the first time;
the captures are in `round-9/`. Six blockers and ten should-fix items were accepted; two items
were rejected, with the reasons below.

## Accepted: blockers

| # | Item | Commit |
|---|---|---|
| 1 | Account sign-ins (OpenAI Codex, GitHub Copilot, xAI Grok) looked like live rows in 推荐. They now come after the providers that work, in the disabled ink with a dimmed mark and a 20px "需 Maka Desktop" badge, no hover, no Tab stop. They are the only account-only providers at protocol 197. | af333af |
| 2 | The add-Host form had no container and its footer read as a section header. It is one plate (radius 12, 1px `border` ring, 16px padding): title 14/600 at the top, Cancel and 保存并启用 at the bottom right. The pending-pairing notice sits below it, above the Host list. | 7beb875 |
| 3 | `--open-settings general:full-access` showed the plain page. The target now waits for the policy, then asks the Full access question. | 572f10d |
| 4 | Extensions and Scheduled tasks put their title and controls in the plate's chrome row. Both pages now open with one header recipe in the content column (title at the settings page-title rung, count 12/400 muted, actions at the column's right edge, 24px above the tabs); the chrome row holds only window controls. Extensions has no count, as Desktop's Skills tab has none. | e197125 |
| 5 | The scheduled-task form's fields were about 24px. Every field in the dialogs (that form and the model parameters dialog) is 32px, radius 10, 12px horizontal padding; preset chips stay 28px. The date picker keeps gpui-kit's 10px padding: its field is drawn inside the picker. | 88b1e49 |
| 6 | Row actions drawn as bare ink text. `shared::theme::quiet_button` is Desktop's row action (ink 6% fill, radius 10, 32px, 14/500, 8px apart) and `destructive_button` its destructive twin; every labeled settings, Extensions and Scheduled action takes them. gpui-kit painted a custom variant's resting fill at a fifth of its colour, so the old destructive button showed about 2% red at rest; the fill is now set on the button. | 9a77af5 |

## Accepted: should fix

| # | Item | Commit |
|---|---|---|
| 7 | Health: 验证 and 运行态探测 are standard groups (16/600, 12 muted description); the intro stays the intro; the five counts are 8px status dots with 12px words. | 167091e |
| 8 | Import/export's mode and source controls are as wide as their segments, left-aligned, 28px. | fd1d115 |
| 9 | One inline empty state (`EmptyRow`: 12 muted text in a 32px row) for Workspace's Hosts and projects, Pets and Remote access; one centred one (`empty_state`) for a page with nothing at all, as Subagents. | d47d81a |
| 10 | The shell's Save shows only while the shell as chosen differs from the Host's: an edited Git Bash path, or the shell choice itself, which also waits for Save. `general:end` waits for the policy, so it reaches the Network group. | bdd31a8 |
| 11 | Every app icon thumbnail has a 1px `border_soft` ring on the icon body (inset 12/128, corners about 23%); an imported icon is drawn in the same place and rounding. | 9b9d54c |
| 12 | The "方形 PNG 最好…" caption sits under the App icon heading. | 9b9d54c |
| 13 | Scheduled tasks' dots: scheduled accent, paused neutral (ink muted), waiting for Desktop warning, failed destructive. Desktop gives paused the attention tone; here the warning is kept for a fire that waits on Desktop. The end lane is a fixed 128px and always shows the countdown or the state. | 2df83be |
| 14 | The custom provider's form is titled 添加自定义连接 / Add custom connection / 新增自訂連線. | b61993c |
| 15 | Extensions' tab strip is gone while Skills is its only tab. | e197125 |
| 16 | Mono values in rows are compact code, 12/20. | 9a77af5 |

## Rejected

- **Default the scheduled task delivery to one the Host can run.** Both deliveries, the local
  reminder and the bot chat, need a client service; the Host has no delivery of its own, and the
  form already says that Maka Desktop delivers them.
- **Letter avatars look like placeholders.** Provider and brand logos are under mixed licenses
  and trademarks (S3), so the letter marks stay.
