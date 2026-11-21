# Git 推送路执行记录（2026-10-18）

执行者：Git 推送路子智能体。基线 `upstream/main = d783df46cbac9021e26a6bd71ca0b55544552eb2`（推送前现核，未前进）。origin = ggbdpq/magpie。提交身份 = 仓库既有配置 `ggbdpq <ggbdpq@gmail.com>`，未改动。全部 message 以 `cat-file commit` 原始字节经 `-F` + `commit.cleanup=verbatim` 写入（中途发现 `git rebase --continue` 的 cleanup=strip 会吞掉以 `#254` 开头的正文行，已用 verbatim amend 还原并逐字节核对）。

结果总览（四个远端 head 均以推送后 `ls-remote` 复核）：

| 分支 | 旧 head → 新 head | 推送方式 |
| --- | --- | --- |
| `hunt19-c-wsl-codex-standin` | `e98d7063` → `519cc6c4` | force（`--force-with-lease`，forced update） |
| `hunt39-b2-gw-trigger-gate` | `37040572` → `31bf76f9` | force（`--force-with-lease`，forced update） |
| `hunt/sink-scope-2167` | 无（新建 ref） | push --force（实为新建） |
| `hunt41-cmd-credits-reset` | 无（新建分支） | 普通 push |

---

## 1. #2198 — `hunt19-c-wsl-codex-standin`

- **旧 head → 新 head**：`e98d706353b3` → `519cc6c465537a01be0d7401551d07c9f10909b6`
- **重建方式**：在 worktree `/private/tmp/magpie-rev-c-prov` 建本地分支于 `e98d7063`，`git rebase --onto d783df46 ebf3f48f`（单提交）。冲突仅 `docs/subsystems/gateway-routing.md`（与报告预判一致），三个代码文件自动合并。doc 冲突按报告方案解决：取 d783df46 版本，在 Model resolution 行（现 line 32）`when magpie is its provider` 后插入 `— in a WSL distro, the distro's own, of the ones running now —`。
- **等价性核对**：doc 的 Model resolution 行与原分支 `e98d7063` 的对应行**逐字节一致**；`wsl.go`、`wsl_codex_stand_test.go` 的提交 diff 与原提交逐字一致；`claude.go` 的改动行逐字一致（仅 hunk 头行号因上游漂移偏移，属 rebase 正常现象）。message 经 verbatim amend 后与 `e98d7063` 原文**逐字节一致**（含 `#254` 开头正文行与 Generated-by 尾注），作者与作者日期保持原件（ggbdpq，2026-10-14 20:14:38 +0800）。
- **测试**（`GOTOOLCHAIN=auto go test -tags nogui -count=1`，HOME=/tmp/revc-home，复刻报告环境）：
  - 五测 `-run 'TestWSLCodexStandIn|TestWSLCodexStandInSkipsStopped|TestWSLClaudeStandIn|TestCodexStandIn|TestClaudeStandIn' ./internal/agent/` → **ok 1.157s**
  - `gofmt -l internal/agent internal/provider` → 无输出；`go vet -tags nogui` 两包 → 无输出
  - 消融红/mutation 红未在本路重跑（报告 2026-10-18 当日已在同树内容上复现，代码 diff 逐字一致）
- **推送**：完成。old head 先经 ls-remote 记录，推送后 ls-remote 核对一致。
- worktree 已恢复 `rev/c-prov` 干净态。

## 2. #2725 — `hunt39-b2-gw-trigger-gate`

- **旧 head → 新 head**：`37040572d50b` → `31bf76f99a3b1f0ee3dfd54dce1237a63bb8ccb7`
- **重建方式**：worktree `/private/tmp/magpie-rev-a-gw` 从 `d783df46` 建分支，`git apply --check` 干净后应用 `2725-rebased-onto-d783df46.patch`（3 文件：`native_compaction.go`、`native_compaction_test.go`、`docs/subsystems/gateway-routing.md`），以 `37040572` 的原始 message（cat-file 原始字节，verbatim）提交。
- **message 核对**：与原件逐字节一致（含 `Fixes #2725`、Generated-by 尾注）；作者 = 当前仓库配置（新提交，规则允许）。
- **测试**（`GOTOOLCHAIN=auto go test -tags nogui`，-timeout 300s）：
  - 基线两测 `-run 'TestNativeCompactionTriggerSummarisedWhenNoListedKeyCarriesIt|TestNativeCompactionTriggerThroughTheListedKeyThatCarriesIt' ./internal/gateway/` → **ok 1.163s**
  - 同两测 `-count=3 -race` → **ok 2.106s**
  - 消融：`git checkout d783df46 -- internal/gateway/native_compaction.go`（测试保留）→ **红**：`native_compaction_test.go:849: 400, the relay asked 0 times`（与报告逐字一致；保护性测试仍绿）；还原后复 **ok 1.001s**
  - `gofmt -l internal/gateway` → 无输出；`go vet -tags nogui ./internal/gateway/` → 无输出
- **推送**：force-push 完成，old/new head 均经 ls-remote 核对。
- worktree 已恢复 `rev/a-gw` 干净态。

## 3. #2167 — `hunt/sink-scope-2167`（新建 ref）

- **旧 head → 新 head**：无 → `dbd62c90a917df99989d857cad86b5023e69bb10`
- **分支名决定**：报告与 issue 评论均确认**从未有过 fork 分支**（patch 只在 issue 正文，台账 10-18 亦记"分支刷新不适用"）；本地原始提交 `745934b0` 所在分支名为 `hunt/sink-scope-2167`（journal/编年全录 10-14 条），故按原名在 fork 新建。**发帖路请知悉：这是新 ref，无 force 覆盖任何旧对象。**
- **重建方式**：worktree `magpie-rev-a-gw` 从 `d783df46` 建分支，`git apply --check` 干净后应用 `2167-applies-onto-d783df46.patch`（3 文件：`remote_magpie_rest_test.go`、`routing.go`、`sink.go`；**确认 patch 内无 P3-5 的 key-limit 端到端钉子测试**）。
- **P3 吸收（P3-1/2/3 做了，措辞有一处偏离报告稿，见下）**：
  - P3-2 subject 补 `(#2167)`：已做。
  - P3-3 正文基线哈希：`50929661` 改为 `4faa9313`，并新增一句 "Re-verified on d783df46, where the patch applies clean and the same test is red without the fix, green with it, -race -count=3 ok."
  - **P3-3 偏离说明（重要）**：报告英文稿括注 "the touched files are byte-identical across them（4faa9313 与 d783df46）"——实测**不成立**：routing.go 在两基线间差 427 行（4faa9313..d783df46 有 7 个提交动过它，含 b14784c0 roomy 改造）。原审计的"字节一致"只对 50929661↔4faa9313 成立（已实测 diff 为空）。故 commit message 采用如实措辞（apply clean + 同测试红→绿 + race 绿），未写入被证伪的字节一致声明。发帖路引用报告英文稿时请同步删掉该括注。
  - P3-1（`From <commit>` 占位符）：对分支形态天然消解——commit 的父提交即真实基 `d783df46`，此后 `format-patch` 自带真实 From SHA。无需也无处落地。
  - P3-4（sunkAt 先 restID 后 restKey）：按 patch 原样保留，未改。
  - P3-5（key-limit 端到端钉子）：确认不在 patch 中，未进提交。
  - 其余正文（含 Co-authored-by、Generated-by 尾注）与 `745934b0` 原文逐字一致。
- **测试**（`GOTOOLCHAIN=auto go test -tags nogui`）：
  - 目标测试 `-run 'TestRemoteMagpieRateLimitSinksTheModel' ./internal/gateway/` → **ok 1.151s**
  - 同测试 `-count=3 -race` → **ok 2.124s**
  - 消融（还原 routing.go + sink.go，测试保留）→ **红**：`remote_magpie_rest_test.go:135: the group: 200 {...from ko...}; the remote was asked [], other [ko]`（与报告/issue 复验评论逐字一致）；还原后恢复
  - 家族回归 `-run 'TestRemoteMagpie|Sink|Sunk|Test.*RestsTheKey|KeyLimit'` → **ok 2.902s**
  - `gofmt -l internal/gateway` → 无输出；`go vet -tags nogui ./internal/gateway/` → 无输出
- **推送**：完成（push --force 语义上等于新建远端 ref），old（空）/new head 均经 ls-remote 核对。

## 4. #2454 — `hunt41-cmd-credits-reset`（新建分支）

- **旧 head → 新 head**：无 → `27f1b86151dd12e996ea1c3277caa977a9f9a76e`
- **重建方式**：worktree `/private/tmp/magpie-rev-b-usage` 从 `d783df46` 建分支 `hunt41-cmd-credits-reset`（报告未建议分支名，按任务默认），`git apply --check` 干净后应用 `2454-cmd-credits-reset-rebased.patch`（3 文件：`commandcode_plan.go`、`planquota_test.go`、`commandcode_key_credits_test.go`）。任务提示的"原目标文件被 be62bcf7 删除"风险**未触发**——rebased patch 本就只落 key 卡缺口文件，apply 一次干净。
- **message**：复用原 hunt29 提交（origin `hunt29-prov-cmd-credits-reset` @ `7846e571`，cat-file 原始字节，verbatim），原文全保（含原 Run 段对双卡测试的记述），在尾注前按报告收窄声明增补一段 "Rebased on d783df46 (2026-10-18), narrowed."：be62bcf7 退役订阅半边即撤回（mover min 0.1.13 = 53009f81 + MoveRetiring 覆盖订阅用户）；存活面=计划 key 卡（`cmdKeyWindows` 无 reset、`cmdKeyPlanID` 丢弃 until）；签名改动（`cmdKeyPlanID` 返回 until、`cmdQuotaOf` 接到 `ResetsAt`）；订阅卡测试随卡删除，key 卡半边 = `TestCommandCodeKeyCreditsRenewAtPeriodEnd`（走真实 `planKeyWindows` 路径）。
- **测试**（`GOTOOLCHAIN=auto go test -tags nogui -count=1 -p 2`）：
  - 新测试 `-run TestCommandCodeKeyCreditsRenewAtPeriodEnd -v ./internal/provider/` → **PASS (0.00s)**
  - 消融（还原 commandcode_plan.go + planquota_test.go，仅留新测试文件）→ **红**：`commandcode_key_credits_test.go:114: the key card's credits have no reset: {... ResetsAt:<nil> ...}`（与报告逐字一致）；还原后恢复
  - provider 全包 → **ok 66.357s**；相邻包 `./internal/usage/` → **ok 12.455s**、`./internal/catalog/` → **ok 1.000s**
  - `gofmt -l internal/provider` → 无输出；`go vet -tags nogui` darwin / GOOS=linux / GOOS=windows → 均无输出
- **推送**：普通 push 完成，old（空）/new head 均经 ls-remote 核对。
- worktree 已恢复 `rev/b-usage` 干净态。

---

## 发帖路注意事项

1. **#2725 英文稿占位符**：报告稿中 `<推送后填新 SHA>` / `<SHA>` 填 `31bf76f99a3b1f0ee3dfd54dce1237a63bb8ccb7`；分支链接 `https://github.com/ggbdpq/magpie/tree/hunt39-b2-gw-trigger-gate`。
2. **#2198 ping 稿**可直接用（分支链接不变，head 即 `519cc6c465537a01be0d7401551d07c9f10909b6`；"I've re-based the branch" 现在为真）。
3. **#2167**：报告英文稿需按上文 P3-3 偏离说明修订（删 byte-identical 括注）；分支为本路新建 `hunt/sink-scope-2167` @ `dbd62c90a917df99989d857cad86b5023e69bb10`；报告中"From SHA/分支链接由用户推送后回填"的回填值即此。
4. **#2454**：英文稿按报告发即可，分支链接 `https://github.com/ggbdpq/magpie/tree/hunt41-cmd-credits-reset`，head `27f1b86151dd12e996ea1c3277caa977a9f9a76e`。
5. 本路未发任何 GitHub 评论、未关单、未开新 issue、未动其它分支；未跑任何全量测试套件。
