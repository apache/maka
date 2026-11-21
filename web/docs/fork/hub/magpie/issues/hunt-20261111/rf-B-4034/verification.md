# rf-B-4034 验证记录（2026-11-12，tip=6f3e7662）

- 分支 hunt-20261111-rf-4034 @ bfe0cc56beaa1139（author=Haoyang Wu <riafmz@gmail.com> 报告者署名保留；cherry-pick 自 fix/4034-ultrafast-tier-verify@abfe864a3）
- 冲突×2 语义解：docs（HEAD 新文本+报告者 Ultrafast 增量融入）、codex_models.go（保上游新 CodexSeals 行+patch 的 ultra 参 CodexTiers 调用）
- patch sha256 前16: e69994f58264a719
- RED：codexcat 侧 TestUltrafastOfferedPastTheSignedInAccountsCache 断言红（tip 基线+测试）；provider 侧测试直调 CodexTiers 新签名→build failed 不算红→等价断言适配基线签名（tiers 闭包去 ultra 参，断言不变）→红 "an account's model offered [priority], want priority and ultrafast"（与原 commit 引红一字不差）
- GREEN：两测试 ok（provider 1.296s/codexcat 1.518s）
- FULL：provider ok 157.5s + codexcat ok 2.3s 零失败
- RACE：provider 唯一红 TestSignInDoneOnceTheAccountIsBack=预存红（#5791 轮基线 race 单跑同红已归因）；codexcat race ok
- gofmt/vet 净；GOOS=linux(nogui)/windows(nogui) build OK（全仓 linux build 撞 wails beta.24 环境限制非本 patch，改 nogui tags）
- 消融：codexcat.go:368 摘 withUltrafast(e) 调用（cache 面核心 hunk）→TestUltrafast 红→恢复绿；models 面由 RED 等价断言覆盖（基线 CodexTiers 无 ultra）
- am 回放：/tmp/mg-50B-base reset --hard 6f3e7662 git am 即进（author=Haoyang Wu 保留），树零差异
- 兄弟面：CodexTiers 调用方 2（route.go:438/codex_models.go:944 均 patch 内同步改签名）；UltraModels/UltraOn 消费面（gateway/codex_tier.go×2、agent/route.go×3、fastpick.go）上游 10-16 e243937ca（#1954）已有=路由面，本 patch 补输出面（CodexTiers/Entries/cache→/v1/codex/models+models.json），非收编
