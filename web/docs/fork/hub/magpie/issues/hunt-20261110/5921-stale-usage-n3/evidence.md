# #5921 验证与消融日志（2026-11-10，车道 3，base=4623f5419）

## 修前红（生产代码未动）
命令：go test -tags nogui -count=1 -run 'TestClaudeUsageOfASignInBeforeGivesWay|TestSignInDropsTheKeptAllowance' ./internal/provider
结果：双 FAIL
- GivesWay：重登换凭据后 claudeWindows 仍 serve 旧 100% 双窗、0 runs（报告者「100% 而真 0%」形状）
- SignInDrops：addLogin 后 claudeReadAt 仍站 T0

## 修后绿
同命令：ok（四文件 +47/-1 + 测试 98 行）

## 消融三刀（各自精确恢复）
- A 摘 tie 块（claudeWindows）→ GivesWay 红、SignInDrops 绿
- B 摘 addLogin forgetClaudeUsage 行 → SignInDrops 红、GivesWay 绿
- C 摘 moved-off 守卫 → TestClaudeUsageOfAnotherAccountNotKept + TestClaudeSeatKeepsItsOwnUsage 双红（新 2 绿）——守卫必要
- 全部还原：git diff --stat = +47/-1

## 实名测试
- 新 2 + TestClaudeUsageOfAnotherAccountNotKept + TestClaudeSeatKeepsItsOwnUsage：绿；-race 绿
- ./internal/provider 整包：绿（136s）；父提交 4623f5419 整包对照：绿（131s）——本单无预存红项
- gateway 依赖面（TestRefusedMidReadRestsByWindow、TestClaudeSubscriptionFailedTryKeepsItsTokens、client-cache usage 组）：绿
- gofmt 净

## 中途修正记录
- 初版 tie 无守卫 → switched/seats 双红（父提交对照确认系我引入）→ 加 !ClaudeCodeMovedOff(user) 守卫（moved-off 时旧 entry 是该账户真读数，kept() 依赖）→ 四测试全绿
- git checkout 误抹 subscription_usage.go 全部修法 → 从 abl 备份恢复 + 重打守卫 → diff --stat 复证 +47/-1

## am 即进 + push
- 干净树 @4623f5419 git am：零冲突（077f8dca8）
- sha256[:16]=e733696720f7fb48
- push: d537...→ 1724af304661a8efb0bb97a6f77cd7e04b961d4d:refs/heads/fix/5921-stale-claudeusage --force-with-lease（ls-remote 实时空值）→ [new branch]

## 发帖与回读
- 帖 id 6771943664（15:48:16Z）；单评端点复核 user=ggbdpq；len 6303 逐字节一致
