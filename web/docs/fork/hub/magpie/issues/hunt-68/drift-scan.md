# hunt68 Lane B：在途分支套用性批测 + 账本核对（drift-scan）

- 日期：2026-10-23 晚；执行：hunt68/b worktree（独占），fork=ggbdpq/magpie
- 批测基线：origin/main = **3b8bcc36**（较当日简报基线 85534cd0 又前移 1 提交；tip 即 #2973 修复提交）
- 方法：`git ls-remote` 全量分支表核对 head → `git cherry origin/main <head>`（patch-id 让位初筛）→ 近 900 条 main 提交 subject 扫 59 个 issue 号（收编面扫描）→ `format-patch | git apply --3way --check`（套用批测）+ plain `apply --check`（am 就绪度）→ 关键单语义 rg 复核
- 范围：简报清单 61 号，跳过清单命中 2 号（2259/2473，其余 20 个跳过号不在清单）= **59 issue / 59 分支**（2488/2881 无分支；3045 一 issue 三分支）；59 个 issue 经 gh GraphQL 批查**全部 OPEN**
- 结论：**收编结案 2 单（2973、2316）；head 漂移同步 2 单（2642、2707）；其余 57 单（57 分支）全部「3way 干净、main 未收编」，其中 11 分支 plain am 脏（3way 可落）；零真冲突，rebase 配额 0/3 动用**

## 汇总表

| issue | 分支 | fork 实测 head | issue | 让位（patch-id/issue 号/语义） | 套用（3way/am） | 备注·结局变更 |
|---|---|---|---|---|---|---|
| #1475 | `hunt61-a-1475-unnamed-call` | `fd717150` | OPEN | 未收编 | 干净/am 脏 |  |
| #1677 | `hunt60-d-1677-gateway-lan-probe` | `fd664874` | OPEN | 未收编 | 干净/干净 |  |
| #2167 | `hunt/sink-scope-2167` | `dbd62c90` | OPEN | 未收编 | 干净/干净 | 附 #2791 分支见下行；main d53a51cd 特例在但 keepRetry（现 routing.go:1219）白名单仍无 X-Magpie-Limit-Reset |
| #2791 | `hunt41-relay-limit-reset` | `f4f788ba` | OPEN | 未收编 | 干净/干净 | 白名单 1 行+链路测试仍必要，未收编 |
| #2197 | `hunt19-b-pool-reminder` | `45835415` | OPEN | 未收编 | 干净/干净 | quota_alert.go 10-19 仅 #2513 gui 面触及，池 aside 面未动 |
| #2198 | `hunt19-c-wsl-codex-standin` | `b587514e` | OPEN | 未收编 | 干净/干净 | 今日已 rebase 至 398803e3，本批测只对 3b8bcc36 加验 |
| #2199 | `take-b2-bedrock-vendor-dot` | `9a5ce8c6` | OPEN | 未收编 | 干净/干净 |  |
| #2316 | `hunt25-l2-2316` | `b6fb98b8` | OPEN | 未收编 | 干净/am 脏 | ✅ 已入 main：6f6b7d40（10-15 13:42，subject 引 #2316+clxsh）同根因同三文件同机制（readSSEAlive/KAlive/排队保活）；我方提交晚 3.5h 属平行重做；分支退役，当日「不干净可套」实为修后位移 |
| #2405 | `hunt24-a-opencode-presets` | `43d47e0b` | OPEN | 未收编 | 干净/干净 |  |
| #2454 | `hunt41-cmd-credits-reset` | `27f1b861` | OPEN | 未收编 | 干净/干净 |  |
| #2471 | `hunt30-gw-finish-error` | `30309fec` | OPEN | 未收编 | 干净/am 脏 |  |
| #2481 | `hunt30-gw-relay-route` | `4cc22a8c` | OPEN | 未收编 | 干净/干净 | 今日已 rebase 至 398803e3，本批测只对 3b8bcc36 加验 |
| #2488 | `（无 fork 分支，公司机 patch 附件）` | `—` | OPEN | 未收编 | —（无分支可测） | main 未收编：apiPricer 双键无回退仍在 window_holds.go:301（与 10-18 记录行号一致）；无从批测分支 |
| #2492 | `hunt31-c2-prov-plugin-temp` | `e700d950` | OPEN | 未收编 | 干净/am 脏 |  |
| #2562 | `hunt/2562-proxycheck-home` | `74f704c5` | OPEN | 未收编 | 干净/干净 |  |
| #2580 | `hunt/2580-midstream-reset` | `2acffddf` | OPEN | 未收编 | 干净/am 脏 |  |
| #2587 | `hunt/2587-balance-refresh` | `6ab5c8d3` | OPEN | 未收编 | 干净/干净 |  |
| #2591 | `fix/2591-sessions-cache` | `1020b7b4` | OPEN | 未收编 | 干净/am 脏 |  |
| #2607 | `hunt32-b-gw-2607-reasoning-dup` | `25dc5013` | OPEN | 未收编 | 干净/am 脏 |  |
| #2642 | `hunt43-a-compaction-writer-id` | `ea43d94e` | OPEN | 未收编 | 干净/am 脏 | head 同步：行内 93cad8b9→fork 实际 ea43d94e（10-21 r3，发帖 6303688341）；patch 表面符号核对齐；writer 失配面 main 未收编 |
| #2682 | `hunt38-b-gw-proxy-shared-outage` | `bdcbae59` | OPEN | 未收编 | 干净/am 脏 |  |
| #2685 | `hunt38-c-sess-libmcp-winpath` | `5513a6c9` | OPEN | 未收编 | 干净/干净 | win-path 半今日已发帖；fnm 半（ca89fd36）维持让位 Edward4226 未测 |
| #2707 | `hunt39-c-dsh-sync-compress` | `f698e15a` | OPEN | 未收编 | 干净/am 脏 | head 同步：行内 95c253e7→fork 实际 f698e15a（10-22 三点返工，编年 Lane F 在案）；main 未收编 |
| #2718 | `hunt57-d-rest-paths` | `0f416b44` | OPEN | 未收编 | 干净/干净 |  |
| #2725 | `hunt39-b2-gw-trigger-gate` | `1396156e` | OPEN | 未收编 | 干净/am 脏 | 今日已 rebase 至 398803e3，本批测只对 3b8bcc36 加验 |
| #2798 | `hunt44-c-agent-broken-stub` | `d9afa165` | OPEN | 未收编 | 干净/干净 |  |
| #2809 | `hunt45-b-copilot-auto-mu` | `eeb96ee5` | OPEN | 未收编 | 干净/干净 |  |
| #2813 | `hunt58-e-2813-settings-update` | `7f8c8d4e` | OPEN | 未收编 | 干净/干净 | r2 版 |
| #2814 | `hunt44-a-sessions-steady` | `e0380455` | OPEN | 未收编 | 干净/am 脏 |  |
| #2817 | `hunt46-a-plugin-claude-headers` | `f599af7e` | OPEN | 未收编 | 干净/干净 |  |
| #2826 | `hunt45-c-antigravity-array-items` | `d79961fb` | OPEN | 未收编 | 干净/干净 |  |
| #2833 | `hunt44-b-gw-alma-compact` | `3d8ed856` | OPEN | 未收编 | 干净/干净 |  |
| #2855 | `hunt46-b-reasoning-content-openai` | `e854e285` | OPEN | 未收编 | 干净/am 脏 | r2 版 |
| #2873 | `hunt48-e-cutshort-retry` | `89f9d8c1` | OPEN | 未收编 | 干净/干净 |  |
| #2879 | `hunt50-d-rtk-hook-off` | `49613be9` | OPEN | 未收编 | 干净/干净 |  |
| #2881 | `（诊断评论，无 patch）` | `—` | OPEN | 未收编 | —（无分支可测） | issue open；诊断面无变化（codexTitlesTo 设计行为仍在 main） |
| #2887 | `hunt47-d-shape-failover` | `90401bee` | OPEN | 未收编 | 干净/干净 |  |
| #2899 | `hunt47-e-bridge-effort` | `091ca01d` | OPEN | 未收编 | 干净/干净 |  |
| #2933 | `hunt48-d-bridge-toolresults` | `1de5d792` | OPEN | 未收编 | 干净/干净 |  |
| #2937 | `hunt50-e-sessionid-cache` | `74a4562e` | OPEN | 未收编 | 干净/干净 |  |
| #2939 | `hunt49-c-maxconc-429` | `f52f6382` | OPEN | 未收编 | 干净/干净 |  |
| #2946 | `hunt48-b-redact-gaps` | `afec25ab` | OPEN | 未收编 | 干净/干净 | 对 r3（afec25ab）批测 |
| #2954 | `hunt50-c-git-plugin-lock` | `298be6db` | OPEN | 未收编 | 干净/干净 |  |
| #2955 | `hunt47-c-compact-developer` | `f8d8ae63` | OPEN | 未收编 | 干净/干净 |  |
| #2969 | `hunt49-b-tool-case` | `8107cb2f` | OPEN | 未收编 | 干净/干净 |  |
| #2972 | `hunt47-b-length-reasoning` | `4985b38f` | OPEN | 未收编 | 干净/干净 |  |
| #2973 | `hunt48-c-codex-401-refresh` | `24abb504` | OPEN | 未收编 | 干净/am 脏 | ✅ 已入 main：今日 tip 3b8bcc36 维护者自写 stale-keyed 刷新，commit 明文收编我方 request-path hook+gateway 测试（codex_refresh_401_test.go blob 7bbd2b6b 逐字同一，taken as written），机制半边替代有书面理由；分支退役 |
| #2974 | `hunt47-a-reasoning-dup` | `05b78de0` | OPEN | 未收编 | 干净/干净 |  |
| #2986 | `hunt50-a-panel-space` | `bea05f94` | OPEN | 未收编 | 干净/干净 |  |
| #3039 | `hunt52-c-model429-scope` | `6fc9532c` | OPEN | 未收编 | 干净/干净 |  |
| #3040 | `hunt53-g-agent-env-key` | `92c48a03` | OPEN | 未收编 | 干净/干净 |  |
| #3045 | `hunt58-j-skill-install-json` | `f0d77936` | OPEN | 未收编 | 干净/干净 | 技能安装 JSON 面 |
| #3045 | `hunt52-d-codex-images-red` | `9fe9a642` | OPEN | 未收编 | 干净/干净 | TestCodexFittedImages 预算面 |
| #3045 | `hunt58-d-3045-codex-images-budget` | `86f9707e` | OPEN | 未收编 | 干净/干净 | 同族测试自算预算面 |
| #3049 | `hunt53-e-proc-shellask` | `2edbff0a` | OPEN | 未收编 | 干净/干净 |  |
| #3052 | `hunt58-i-3052-bili-headers` | `1fd206c7` | OPEN | 未收编 | 干净/干净 |  |
| #3055 | `hunt58-a-3055` | `76a40b01` | OPEN | 未收编 | 干净/am 脏 |  |
| #3061 | `hunt53-h-queue-full-state` | `19cd883b` | OPEN | 未收编 | 干净/干净 |  |
| #3083 | `hunt54-d-signin-timeout` | `f21de209` | OPEN | 未收编 | 干净/干净 |  |
| #3161 | `hunt58-g-3161-search-protection` | `128ec704` | OPEN | 未收编 | 干净/干净 |  |
| #3209 | `hunt60-c-3209-gateway-selfport` | `ced73710` | OPEN | 未收编 | 干净/干净 |  |

## 收编结案（2）

1. **#2973**（hunt48-c-codex-401-refresh @24abb504）——今日 tip `3b8bcc36` 为维护者自写修复：stale-keyed 刷新（`codexTokenRenewing`/`renewSavedLoginFrom`），commit 正文明文「The request-path hook and its gateway tests (codex_refresh_401_test.go, taken as written) are ggbdpq's patch on #2973」；测试文件 blob `7bbd2b6b` 与我方分支逐字节同一。机制半边替代我方 force 刷新，理由在案（我方实现跳过 keychain 新读，可能浪费 Codex 已轮换的 refresh token）。→ 行内已改记 ✅，分支退役。
2. **#2316**（hunt25-l2-2316 @b6fb98b8）——`6f6b7d40`（10-15 13:42，subject 即引 #2316+clxsh）同根因、同三文件（search.go/ir.go/claude_subscription.go）、同机制收口（`readSSEAlive` 即该提交引入、`KAlive`、排队保活），并收录报告者测试（search_queue_test.go）。我方 commit 晚 3.5 小时属平行重做；10-23 早记的「不再干净可套」实为修后位移，非需 rebase。→ 行内已改记 ✅，分支退役。

## head 漂移同步（2，台账行内 SHA 已追加修正）

- **#2642** hunt43-a-compaction-writer-id：行内 `93cad8b9` → fork 实际 **`ea43d94e`**（10-21 r3 rebase，发帖 6303688341，编年在案）；patch 表面符号（checkpointWriter.ID/isWriter/checkpointGone/upsertLogin/dedupeLogins）核对齐全；对 3b8bcc36 3way 干净（am 脏）；writer 失配面未收编。
- **#2707** hunt39-c-dsh-sync-compress：行内 `95c253e7` → fork 实际 **`f698e15a`**（10-22 维护者三点返工版，编年 10-22 Lane F 在案、发帖 6342266624）；对 3b8bcc36 3way 干净（am 脏）；未收编。

## 3way 干净但非干净 am（git am 会拒，3way 可落）（11 单）

1475 2471 2492 2580 2591 2607 2642 2682 2707 2725 3055 —— 均为上下文位移级（今日主链 +7/+20 提交所致），无内容冲突；不构成 rebase 义务，仅供维护者取 patch 时选择口径参考。

## 无分支单（2）

- **#2488**：patch 为公司机附件形态，无 fork 分支可批测；让位面核对未收编（apiPricer window_holds.go:301 双键无回退仍在，行号与 10-18 记录一致）。
- **#2881**：诊断评论单（无 patch）；issue open，诊断面无变化（codexTitlesTo 设计行为仍在 main，测试钉死）。

## rebase 动作

零。59 分支对 3b8bcc36 `apply --3way --check` 全部通过，无真冲突；rebase 配额（≤3/轮）未动用，无分支推送。

## 本轮不自信的点

1. 收编判定靠 issue 号扫描 + git cherry patch-id + 关键单语义 rg 三重一致，未对 55 个「未收编」单逐单重放消融测试——若上游以完全不同实现、未引 issue 号地修掉同问题，会漏报；缓解：其中多数行内已有 10-22/10-23 hunt66/67 验证轮的消融句在案。
2. 2642/2707 的 head 漂移结论引自编年（非本次会话动作），本次只做表面符号核对与套用批测，未重放消融/定向测试。
3. plain am 脏的 11 单未逐单人肉检查 hunk 位移内容，仅以 3way --check 通过为放行口径。
4. 索引文件在批测期间被并行 lane 编辑（gateway.md 2607 行号 48→47 等位移实测两次），本次更新改用 anchor+消歧全文定位并在写入前断言，行号类结论以锚点为准。

## 索引行更新

- 结局列追加 60 行（agent-plugin-library.md 9、gateway.md 44、provider-usage-catalog.md 7；其中一行覆盖 #2167+#2791）：53 行记「10-23 晚 drift 批测复测干净」，2 行改记 ✅ 收编（2973/2316），2 行补 head 同步（2642/2707），2488/2881 各记无分支形态结论，2197/2946/2813 带限定说明。编年未动（按约定由主线程统一记）。
- 未发任何帖子；未推送任何分支。
