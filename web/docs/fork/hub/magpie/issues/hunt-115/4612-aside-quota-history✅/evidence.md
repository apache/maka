# hunt-115 / #4612 — aside 窗口不进 quota-history（已交付 patch）

2026-11-01。issue: https://github.com/yetone/magpie/issues/4612（chowyuan1314，10-31）
回帖: https://github.com/yetone/magpie/issues/4612#issuecomment-6557190270（GET 回读 15182 字节完整）
分支: `fix/4612-aside-quota-history` → https://github.com/ggbdpq/magpie/tree/fix/4612-aside-quota-history
head: `8835a061cbf9acd57f9ef3c42eaf0757952171c4`（rebase 后，基线 9d08993c8 = upstream/main）
patch: `4612.patch`，SHA-256 前 16 `ab280916bfb2c53a`
认领: `take` https://github.com/yetone/magpie/issues/4612#issuecomment-6556893611

## aside 语义判定（主仓可修，非跨仓）

- `QuotaWindow.Aside` 文档声明为纯路由信息（"Aside when using it up doesn't stop the account"）；`Text` 才是「无真实读数」（Used 不是测量值）。
- pointOf 的 aside 排除来自 #651（9ccabdfbd），pools 例外来自 14e4d8040（10-27，Antigravity 卡片修曲线）——当时只放行「卡片显示的那一行」，未推广到「凡有真实读数」。判定：遗漏而非声明设计。
- pointOf 唯一生产调用方 = noteQuotaHistory（quota_history.go:338）→ 单口修复。GUI app.js `quotaLines` 按窗口名查线、只跳 unlimited/family，不跳 aside → 线一记录卡上自动出现，无需 GUI 改动。
- 插件仓不动（报告者同建议，避免影响路由）。

## 最终改动（5 文件 +89 −11，提交 `provider: quota history draws measured windows set aside for routing (#4612)`）

1. `internal/provider/quota_history.go`：pointOf 条件 `w.Aside && !w.PoolWindow()` → `w.Text`（pools 例外被吸收）；头注释与函数注释同步。
2. `internal/provider/factory_usage.go`：Factory "Extra usage"（余额美元数、无 share）加 `Text: true`——不加会成假 100% 线；Claude 同名行（claudeOveragesWindow）已是 Text，先例在内。
3. `internal/provider/quota_history_test.go`：TestQuotaHistoryKeepsAntigravityPools 按新语义更新（aside "Extra" 行现被记录，3→4 线 + 断言）。
4. `internal/provider/quota_history_aside_test.go`（新）：TestQuotaHistoryKeepsAsideReadings（#4612 快照形状）+ TestFactoryExtraUsageIsTextAlone。
5. `docs/subsystems/providers-accounts.md`：quota-history 段补 aside/Text 语义。

## 关键转折：撤回第三个改动（quotaOfPlugin 去 `!x.Aside`）

原计划三改：quotaOfPlugin 让 aside+无读数行也打 Text（fail-closed 不变式）。全量跑挂 `TestPluginTextRowIsText`：
`!x.Aside` 自 #3650（9733ed1b4）就有，1dfa28484 的测试**故意锁定** Bare（aside+无 used）非 Text、带 limit 的 aside 行是真实 0%——是 maintainer 的有意决定，非缺口。按让位闸撤回，边界在帖子里披露：
- 带 display+limit 的 aside 行（"0 / 50"）按 maintainer 注释是真实 0% → 记 100% left 是对的；
- 纯 Bare 形状（无 used 无 display）会记假 100% 线，但已录插件无此形状（cursor 插件 aside 行全带真实 used，08ad5e39 已核），留给 maintainer 拍板。

## RED / GREEN / 消融（原文）

RED（父提交 d1a94f579，改动前）:
```
--- FAIL: TestPluginWindowSetAsideWithoutUsedIsText (0.00s)   ← 后随第三改动撤回而移除
--- FAIL: TestQuotaHistoryKeepsAsideReadings (0.00s)
    quota_history_aside_test.go:32: histories = [], want the Weekly and Grok Bot lines alone
--- FAIL: TestFactoryExtraUsageIsTextAlone (0.00s)
    quota_history_aside_test.go:59: Extra usage: Text false, Aside true, want its text alone
```
消融（81c850e67 后回退 quota_history.go + factory_usage.go 两产品文件，测试保留）:
```
--- FAIL: TestQuotaHistoryKeepsAsideReadings
--- FAIL: TestFactoryExtraUsageIsTextAlone
FAIL  →  restore 后 ok
```

## 矩阵

- `go test ./internal/provider -tags nogui -count=1`：ok（102.8s，0 FAIL；rebase 后定向复跑 ok）
- `go test ./internal/usage -tags nogui`：ok（26.1s）
- gofmt -l：净；vet darwin/linux/windows（nogui）：净
- build：darwin ok / windows ok / linux `-tags nogui` ok（CGO=0 亦 ok）；**linux 无 nogui build 挂在 wails GTK/cgo（宿主预存，未触改动文件）**——帖内已如实标 Not exercised

## 兄弟面清单（rg Aside 全查）

- gateway `asideOf`/`trace.go`：candidate 的 `Weighed.Aside`，另一类型，无关。
- `credits_daily.go`：creditOf 以 `w.Text` 排除、aside 仅随行携带——未触，不受影响。
- `quota_last.go`：Aside 进 sidecar 持久化/回填——未触。
- `codex_switch.go`：读 Text（不读 Aside）——未触。
- copilot（completions/premium overage 有真实百分比 → 新增记录线，诚实读数）、google.go:1339 pool 窗（原本就在）、plugin_usage（Text 规则未动）。
- 已知旁系（未动，可另开单）：非 aside 的余额窗口（#3950 wallet，Used=0 无 Text）今天就会记 100% 假点——另一根因，帖内一句带过未展开。
