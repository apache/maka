# hunt-123 / #4945 Lane D 执行日志（2026-11-04）

结局：**让位出列（分析帖计完成）**。未产出我方 patch，未动产品文件。

## 时间线
- take 占坑：comment 6610301907（ Lane D 主线程预发于 11-03 17:00Z）
- 英文分析帖：comment 6610917125（GET 回读通过，3510 字符，作者 ggbdpq）
- 产物：`analysis-post.md`（帖稿）、`skygunner-8847ef602.patch`（其 commit 副本，sha256 前 16 = 5e16f96fab8cc954）

## 让位闸判定
触发项：**skygunner 已升级完整 fork 交付**（11-02 21:22Z 评论，branch `fix/4945-deepseek-parallel-tool-uses`，head `8847ef602`，带测试/验证/文档行）。其余闸项：维护者未表态（issue 仅 2 条评论）；`splitParallelToolUses` 未 landed（`git log -S` 空）；报告者未自带修复。skygunner 评论自述"not a claim on the issue's ownership"，我方 take 无冲突。

## 独立核验记录（全部本机实测）
- **Root cause 代码链**：relay 腿 = `gateway.go` `passthrough` Anthropic case（gate `anthropicReplaysThinking` 现仅挂 `withThinkingOnToolTurns`）；translated 腿 = `build` → `anthropicBody`。两处今日均不整形并行 tool_use 交换。
- **上游 tracker 核实**：DeepSeek-V3#967 原文（curl API）——单条 user 消息装全部 tool_result 报错、一条一结果顺序发也报错；评论区 onelife 诊断：Anthropic 只匹配最后 tool_use，DeepSeek 校验全部 id 且 N>1 匹配失败；其 snippet 的 `.copy()` 即"每次一 call"串行形态。该 issue 2025-10-17 closed not-planned。
- **skygunner diff 评审**：4 文件 +298/−1，单 commit。`splitParallelToolUses` 保守（仅拆下一 user 消息完整答齐的交换；单 call/未答齐/答外来 call 原样放行；旁路文本缀于末结果后）；与 `withThinkingOnToolTurns` 同 gate、同两落点、先拆后补 thinking 顺序正确；gate 排除 api.anthropic.com 与 claude-*。
- **基线勘误**：其分支父提交实为 `8abdf53a8`（upstream/main 历史内、非 lane 建单时的 1e1068c86）；6 个新提交（1e1068c86..7785c4278）触 gateway 的仅 browser*.go / claude_subscription.go，与其 4 文件零重叠 → 干净落地。
- **验证矩阵**（review worktree /private/tmp/mg122-d-review，darwin/arm64 go1.25.5）：
  - 定向 4 测试（3 新 + TestMessagesCleanExchangeUntouched）全绿。
  - 消融 RED：`restore --source=8847ef602^ -- internal/gateway/gateway.go`（仅退调用点留函数）→ `TestMessagesParallelToolUsesSplitForDeepSeekUpstream` 以报告者一模一样 400 文案红；`TestTranslatedMessagesParallelToolUsesSplitForDeepSeek` trace 停在 `user assistant(A,B) user[B,A]` 红。
  - 全量 `go test -tags nogui -timeout 25m ./internal/gateway/`：仅 `TestCodexPoolSaysTheClientsVersion` 一红，在父提交 8abdf53a8 复跑同红 → 预存（在 lane 已知预存红清单内）。race 未跑（未改流式代码，让位单不适用）。
  - `go vet` / `gofmt -l`（改动 3 文件）/ `go build ./...` 全净（build 仅 macOS SDK 链接器告警，环境性）。
- **边界（帖内已声明）**：双方均无 DeepSeek 账号，未对真实 api.deepseek.com/anthropic 实测；端点行为依据报告者 live 400 + #967。

## 环境备注
- `git restore --source=upstream/main` 在其分支上会引入 6 新提交符号导致编译错（KeepPluginsSignedIn 等）——消融基线必须用分支父提交，非 upstream/main。
