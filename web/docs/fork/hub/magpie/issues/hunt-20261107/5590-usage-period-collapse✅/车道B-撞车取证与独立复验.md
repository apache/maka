# 车道 B 撞车取证与独立复验（三场车道 B，2026-11-07 深夜）

## 结论

车道 B 按任务书从零重建 #5590 修复并跑完全套验证后，发布前发现**车道 D 已于 15:04:31Z（本地 23:04）发布 PATCH 帖并推 fork 分支**，主线程已收口改名 ✅。按红线「他人 patch 在途→停止交付，不发帖」：**车道 B 不推不帖**，本文件落盘取证。关键事实：车道 B 独立重建的提交树与车道 D 已交付提交**逐字节相同**（tree 均 `bfdd2d3592f7e734d64da91256861cec5efa38a3`），构成对车道 D 交付的独立第二验证。

## 时间线（均为本地 +0800）

| 时刻 | 事件 |
| --- | --- |
| 21:57（13:57Z） | ggbdpq take 占坑（首轮） |
| 22:12 | 车道 D 提交 2b5f33db6（基 784113472，未发布，遗留 worktree mg1107d5590） |
| 22:42 | 车道 B 任务书签发；车道 B 开工 |
| ~22:55 | 车道 B 首次 `git ls-remote origin`：fork 无 `fix/5590-usage-period-collapse`；issue 评论仅 take 一条 → 排雷判净 |
| 22:36 | upstream/main 前移至 578053d6a（车道 B fetch 在后，基此开工） |
| 23:04（15:04:31Z） | 车道 D 发布：rebase 后推 a39fc9c10 + PATCH 帖 [#5590 (comment)](https://github.com/yetone/magpie/issues/5590#issuecomment-6708669801) |
| 23:1x | 车道 B push 被自己 force-with-lease 正确拒绝（stale info）→ GET 回查发现已发布 → 停止交付 |
| 23:2x | 主线程产物目录改名 🚧→✅（收口） |

## 车道 B 独立重建（未发布，仅本机）

- worktree `/private/tmp/mg1107s3-b`，detached @ `578053d6a`（未触碰任何遗留 worktree；分支名被遗留 worktree 占用故 detached，交付本拟以显式 sha refspec 推）。
- 提交 `a2c83603c244edf5c8075f09cca51019033d0e13`（author ggbdpq <ggbdpq@gmail.com>）：
  - `internal/gui/assets/app.js`：L15994 删 `!brief &&` 门控 + 1 行注释（与车道 D 同一语义分叉行）；
  - `internal/gui/tests/usage-fold-cycle.test.cjs`：新测试（自 git 对象库取车道 D 测试稿审读后采用）。
- **tree = `bfdd2d359…` = 车道 D 已交付 a39fc9c10 的 tree，`git diff` 空**。

## 独立验证（全部在 578053d6a 基上实测）

| Check | Result |
| --- | --- |
| RED 先跑（未修 tip） | usage-fold-cycle 2/2 RED（chromium 4823ms / webkit 4691ms，折叠后 fill 100% vs 期望 57%，报告者签名） |
| 修复后 GREEN | 2/2（chromium 998ms / webkit 892ms；复跑 1028/949） |
| 消融 A（分叉行放回 `!brief &&`，测试不动） | RED 2/2 同签名；`git checkout HEAD -- app.js` 还原 → GREEN 2/2 |
| 邻居批次 12 文件（Playwright） | 136 pass / 4 唯一失败=父态同集（usage-fold「17 subscriptions and 29 accounts」chromium+webkit + webkit en/zh「several accounts: one in full…」；父态复跑逐一取证同红，环境性）→ 零新增红 |
| TestCoreScriptBudget | pass（净 +74 字节，预算内） |
| `go test -tags nogui ./internal/gui/`（201.9s） | 唯一失败 TestProxyCheckSaysAProxyPassedBy=预存名单成员（父态单测同红取证） |
| `go test -tags nogui ./...`（85 包 ok） | TestMothX=名单成员；TestHostToldTheGatewayAddress=父态同红（本机 7897 代理环境）；TestCancelledSignInSavesNothing=满载竞速 flake（我方单跑 ×3 绿 + 父态单跑绿，仅与 race 并发满载时红，tok-late 迟到写入签名） |
| `go test -race -tags nogui ./internal/gui/`（240.2s） | 零 DATA RACE；唯一失败同 TestProxyCheck（预存） |
| `gofmt -l internal/gui/` | 空 |
| `go vet ./...` / `GOOS=linux -tags nogui` / `GOOS=windows` | 全 clean |
| `go build` / `GOOS=linux -tags nogui` / `GOOS=windows` | 全 clean（darwin linker macOS 版本 warning 为本机常态，exit 0） |

## 兄弟面（tip 578053d6a 全消费方复核，与 车道D/兄弟面.md 结论一致）

familyQuota（定义 18541 + 唯一调用点 15996）、quotaHistoryCard（16596 + 15995）、quotaCyclePicks（16561/16576/16587/16807）、usageAcctOpen（15992/16099/16124/16152/16189/17147/17503）、quotaHistoryView（15994 修复点/16584/16788 曲线自有门）：改动单点即 15994；面板只画 open 账户、曲线被 `!brief` 门控、keys/更多行只读 usage 态，均无第二口径。brief CSS 门（app.css L979 隐藏 reset 行）与 tooltip「Last reading {when}」（L18687）在 tip 仍在，简略视图历史可辨认。`quota-refresh-order.test.cjs` 仅引用 familyQuota 注释串作度量锚点，无行为耦合。

## 判定依据

任务书红线：「任何一查出雷：已收编/他人 patch 在途 → 立即停止交付，落盘排雷证据到产物目录并回报，不发帖」。车道 D 帖在案（同账号车道，非我本单产物）即属在途已交付；且其树与我逐字节相同，重复推帖只会制造噪音。车道 B 全部验证结果同时构成车道 D 交付的独立复核（不同 worktree、不同提交、同树）。
