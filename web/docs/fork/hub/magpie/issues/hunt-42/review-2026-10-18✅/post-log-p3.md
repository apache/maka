# 发帖日志 P3（2026-10-18，路二：4 单英文评论 = #2198 ping / #2725 rebase 说明 / #2167 patch 重发 / #2454 收窄重发）

执行者：ZCode 子代理。事实基线：upstream/main @ `d783df46`（push-log.md 为分支 head 唯一事实源，发帖前另经 ls-remote 复核一致）。稿件全部来自 `review-2026-10-18/` 各报告文末英文稿，改动仅限事实校正与任务指定删除，未改语义。全程未编辑/删除既有评论、未关单、未开新 issue、未动任何分支。

## 发布前检查

### 分支核对（`git ls-remote origin`，2026-10-18 实测）

| 分支 | ls-remote head | push-log 对照 |
| --- | --- | --- |
| hunt19-c-wsl-codex-standin | `519cc6c465537a01be0d7401551d07c9f10909b6` | 一致（rebase 后新 head） |
| hunt39-b2-gw-trigger-gate | `31bf76f99a3b1f0ee3dfd54dce1237a63bb8ccb7` | 一致（重建后新 head） |
| hunt/sink-scope-2167 | `dbd62c90a917df99989d857cad86b5023e69bb10` | 一致（新建 ref） |
| hunt41-cmd-credits-reset | `27f1b86151dd12e996ea1c3277caa977a9f9a76e` | 一致（新建分支） |

### 评论回合检查（`gh api repos/yetone/magpie/issues/<N>/comments?per_page=100`）

| issue | 评论情况（末 3 条） | 判定 |
| --- | --- | --- |
| #2198 | Edward4226（10-16 05:46）→ ggbdpq（10-16 06:27） | 维护者 10-17 后无新回合；Edward 独立验证前提未变，可发 |
| #2725 | yetone（10-17 12:38，route (a) 否决 v1）→ ggbdpq（10-17 13:29，review-fix） | 维护者回合即稿件前提本身（route (a)），其后无新回合，可发 |
| #2167 | 仅 ggbdpq（10-17 04:17） | 无维护者回合，可发 |
| #2454 | yetone（10-16 09:43）→ ggbdpq（10-17 04:17、04:19 误读收回） | 维护者回合已被稿件时间线消化；其后无新回合，可发 |

### format-patch 预检（#2167、#2454）

- `git format-patch -1 dbd62c90 --stdout` → 7226 字节；`-1 27f1b861 --stdout` → 10158 字节；均无 ``` fence 行冲突，远低于评论上限。
- #2167 提交正文核验：subject 含 `(#2167)`，正文基线 `4faa9313` + "Re-verified on d783df46…red without the fix, green with it, -race -count=3 ok" 如实措辞，**无 byte-identical 声明**；含 Co-authored-by 与 Generated-by 尾注。
- #2454 提交正文核验：收窄段 "Rebased on d783df46 (2026-10-18), narrowed." 在场，与稿件收窄声明一致。

## 逐单发布（串行，发一核一）

### 1. #2198 — ping

- 稿源：`2198-wsl-codex-standin.md` ⑦，**零改稿**（push-log note 2：可直接用；"I've re-based the branch" 经本路 push 已为真，分支链接不变）。
- 命令：`gh issue comment 2198 -R yetone/magpie --body-file /tmp/post-2198.md`
- 评论 URL：https://github.com/yetone/magpie/issues/2198#issuecomment-6245626660
- 回读（id 6245626660）：user=ggbdpq，created=2026-10-18T04:25:02Z，长度 1508 字符，首句 "Gentle nudge on this one —…"、尾句 "…before this can go in?"，无乱码。

### 2. #2725 — rebase 说明帖

- 稿源：`2725-codex-trigger-gate-recheck.md` 文末英文稿，占位符回填（事实校正）：`<推送后填新 SHA>` / `<SHA>` → `31bf76f99a3b1f0ee3dfd54dce1237a63bb8ccb7`（全文 SHA，按 push-log note 1），`<推送后链接>` → `https://github.com/ggbdpq/magpie/tree/hunt39-b2-gw-trigger-gate`。语义零改动。
- 命令：`gh issue comment 2725 -R yetone/magpie --body-file /tmp/post-2725-top.md`
- 评论 URL：https://github.com/yetone/magpie/issues/2725#issuecomment-6245627864
- 回读（id 6245627864）：user=ggbdpq，created=2026-10-18T04:25:12Z，长度 1219 字符，首句 "Rebased onto current `main` (`d783df46`)…"、尾句 "(head 31bf76f9…，on `d783df46`)."，无 fence、无乱码。

### 3. #2167 — patch 重发帖

- 稿源：`2167-remote-429-sink-recheck.md` 英文稿 + 两处硬性要求落地：
  1. **byte-identical 括注已删**：原句 "(`4faa9313` and `d783df46`; the touched files are byte-identical across them)" → 删除分号后整段，保留 "(`4faa9313` and `d783df46`)"。理由：该说法实测不成立（routing.go 两基线间差 427 行）；帖子红/绿/race 如实措辞与提交正文（dbd62c90）一致。
  2. 尾句 "Patch below / branch on the fork." → 展开为分支链接行（`hunt/sink-scope-2167` @ `dbd62c90`）+ `<details>` 折叠内嵌 `git format-patch -1 dbd62c90 --stdout` 全文（含 Generated-by 尾注）。
  - 未含报告"可选加段"（X-Magpie-Limit-Reset 传输层发现）——任务未授权，留给后续单。
  - Verification 矩阵三条 bullet 行间无空行（GitHub 渲染要求）。
- 命令：`gh issue comment 2167 -R yetone/magpie --body-file /tmp/post-2167.md`
- 评论 URL：https://github.com/yetone/magpie/issues/2167#issuecomment-6245628709
- 回读（id 6245628709）：user=ggbdpq，created=2026-10-18T04:25:19Z，长度 8175 字符；`byte-identical` 全文检索 **0 命中**（删除已落实）；`<details>` ×1、fence ×2 配对完整，无乱码。

### 4. #2454 — 收窄重发帖

- 稿源：`2454-cmd-credits-reset-rescope.md` 文末英文稿 + 任务指定调整：
  1. 订阅半边放弃声明保留原句（"that half is withdrawn"），对 issue 内旧 patch/旧评论不作任何编辑或删除，仅声明 scope 变更。
  2. 原稿 `[attach 2454-cmd-credits-reset-rebased.patch]` 占位 → `<details>` 折叠内嵌 `git format-patch -1 27f1b861 --stdout` 全文。
  3. 事实校正两处：summary "Patch (git apply, …)" → "Patch (git am, on current main)"（内嵌物为 format-patch，git am 为其实际投递方式）；新增分支链接行（`hunt41-cmd-credits-reset` @ `27f1b861`）。
- 命令：`gh issue comment 2454 -R yetone/magpie --body-file /tmp/post-2454.md`
- 评论 URL：https://github.com/yetone/magpie/issues/2454#issuecomment-6245629661
- 回读（id 6245629661）：user=ggbdpq，created=2026-10-18T04:25:27Z，长度 12207 字符；"that half is withdrawn" 在场；`<details>` ×1、fence ×2 配对完整，无乱码。

## 汇总

- 4/4 发布成功，0 跳过，0 失败。
- 成功 URL 清单：
  1. #2198 https://github.com/yetone/magpie/issues/2198#issuecomment-6245626660
  2. #2725 https://github.com/yetone/magpie/issues/2725#issuecomment-6245627864
  3. #2167 https://github.com/yetone/magpie/issues/2167#issuecomment-6245628709
  4. #2454 https://github.com/yetone/magpie/issues/2454#issuecomment-6245629661
- #2167 稿的 byte-identical 删除已落实并经回读全文检索验证（0 命中）。
- 遗留：#2167 的 X-Magpie-Limit-Reset 传输层新发现（`2167-finding-keylimit-header-lost-in-relay.md`）未随帖发出，仍待用户授权另开单。
