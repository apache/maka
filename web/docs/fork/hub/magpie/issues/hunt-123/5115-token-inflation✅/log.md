# 5115 token-inflation — 车道记录（Lane B, 2026-11-04）

结局：已发布 patch 帖 + GET 回读通过。issue #5115，take 评论 6613949063，patch 帖 6614596322。

## 判定链

- 族=gateway usage 语义：`streamTranslated`（continuation.go）三个重试边界（空回复 #667 / 循环守卫 #1359 / cut 续写 #853）的 `before, this = before.plus(this, false), Usage{}` 把每次尝试的 prompt（Input+CacheRead）折进后续事件 → collector（客户端 `prompt_tokens`）与 `call.Usage`（账本）同源双读 → WorkBuddy 把累计值当上下文占用 → 误触发 emergency-auto 压缩；图表 `promptCounted` 读同一聚合值 → ×4 校准。
- #853（f55a13f23）有意引入"client+ledger 一起累计"（修的是当时"只留末次、漏计费"的欠账）；本单是其副作用修复，用仓库现成 Deferred 机制（#1053/3a9d73c5c 先例："billed with this one, never told as its prompt"）。
- **方案 A→C 转向**：最初把 CacheWrite/CacheWrite1h 一并入 Deferred，但 `TestCachePartialUpdateMatrix`（12 例 × continuation 子测试）+ `TestProbe1717ContinuationTotalZeroSplit` + `TestStreamCutZeroCacheSplitKeepsWrites` 钉住"客户端 cache 写入跨尝试求和"是被刻意校准的计费显示面，且报告族 cache_write=0（Antigravity 只报 cachedTokenCount 读）。改判方案 C：只 Input+CacheRead 入 Deferred，CacheWrite/Output/Reasoning 保持原折入。最终只动一个钉住测试 TestStreamCutUsageSumsTries（改名 TestStreamCutUsageBillsTriesTellsOwnPrompt，客户端 18→11、账本仍 7+11）。
- 计数边界守卫：`u.add` 正数才覆盖 → "有计数的尝试 + 无计数的尝试"序列会让 u 保留旧 Input、叠加 Deferred 后账本双计 → `gaveUp` 边界清零 u.Input/CacheRead。中间曾做过一版无清零的方案 A，被新测试 TestGeminiEmptyRetryCountsOnlyWhatWasCounted 抓红后修正（该测试保留为守卫；父提交上平凡绿，消融表里如实注明 2/3 红）。
- 兄弟面不改：search.go（searchReply 多轮，每轮 prompt 确实不同）、claude_subscription.go（跨消息求和，TestClaudeInternalMessagesKeepCacheWrites 钉住）——帖内已列，留给维护者决定是否同法处理。
- 账本/图表闭环：`routeUsage` 把 Deferred 定价为本层、`billed()` 折回全部消费方（ledger/OTel/observe）、`promptCounted` 读主层=回答那次的单次输入。

## 验证

- RED（父提交 c360d9d30）：prompt_tokens=300（复现 4× 形态）+ cut 测试 18。
- GREEN：3 新/改测试 + 矩阵/probe/cache-write 全家不变绿。
- 消融：continuation.go 回父→红（ablation-red-on-parent.log）；恢复→绿（green-after-fix.log）。
- 全量：`go test -tags nogui -timeout 25m ./internal/gateway/` ok 579.0s（gw-full-test.log）；race（触达面）ok；gofmt/vet 干净；`go build ./...` exit 0（gui 包 cgo 警告预存，父提交同样 3 条）。

## 产物

- patch：0001-gateway-a-retried-try-s-prompt-is-billed-as-the-repl.patch（SHA-256 前 16：a6053fd179e70de9）
- 帖：post.md（发布稿）、post-readback.md（GET 回读，与稿仅一尾随换行之差）
- commit c6161fac9，分支 fix/5115-token-inflation（已推 origin=ggbdpq/magpie，head c6161fac99d18655ad39a38b1fd1a8f78cd30037）

## 遗留

- 报告者建议的"续写/路由切换覆盖"：续写已同法修；路由切换（账号 failover）本就按 try 分册记录、客户端读成功那次，帖内已说明无需改。
- searchReply 轮次与 claude_subscription 的同形态累计：帖内列出，未动。
- 图表回归到 ~1.0 需一次真实发生（帖内 Not verified 已注明）。
