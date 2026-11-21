# hunt38 B 路 · #2682 共享失效代理的重复拨号与末位退避重试

- issue: https://github.com/yetone/magpie/issues/2682
- claim 评论: https://github.com/yetone/magpie/issues/2682#issuecomment-6231320907
- 交付评论: https://github.com/yetone/magpie/issues/2682#issuecomment-6232636339（回读核验：37160 字符，patch/分支链接/Co-authored-by/Generated-by 齐全，围栏配对正常）
- 基线: 先 cb05dc2d，后 rebase 至发帖时 tip bad4508c（新增 #2656 custom tool 改动，与本项目无交集）
- commit: e503baa3f912eaa9e4a46a3f463862c13a62be6b
- fork 分支: https://github.com/ggbdpq/magpie/tree/hunt38-b-gw-proxy-shared-outage
- patch 存档: docs/issues/hunt38/b-proxy-shared-outage.patch
- 新 tip 重放：摘产品文件到 bad4508c 版本、保留测试 → 三测试全红；恢复后 gateway 全包绿（313.5s）

## 现象与根因

报告者 congee949：多个候选共享同一失效代理时被顺序重试 + 末位退避重试，796 秒 8 次尝试（7 次同代理 `127.0.0.1:1082` 拨号失败、1 次 Qoder CN 502）。`failProxy`（#381）已防账号冷却但不防同出口重复尝试。

根因两处：
1. `internal/gateway/gateway.go` serve 候选循环：failProxy 分支只 `continue` 到下一候选，不记录失效出口——同出口的后续候选仍逐个拨号。
2. `internal/gateway/fallback.go` `passing()`：502（含 proxyconnect 文案）落入「末位同候选退避重试」分支（`again < lastRetries`），拨死代理最多再 2 次。

## 修复（最小）

- gateway.go：serve 内 `proxyFailed := map[string]string{}`（本请求内的出口→错误）；failProxy 分支记录 `c.p.ProxyChoice()`（账号/密钥自有代理，否则 provider 的，`""` 表示跟随全局）；循环开头候选的 choice 命中即跳过（记 skipped/Fallback、other、`last` 时直接 failTo 502），不 rest、不冷却——下一请求照常重试代理，恢复速度与 #381 保持一致。
- fallback.go：`passing()` 对 `proxyDown.Match(body)` 的 502 返回不重试（同时封掉 3079/3192 两个重试分支的 failProxy 路径）。
- 保守边界：`"direct"`、不同代理地址、直连失败（无 proxyconnect 文案 → 非 failProxy）均不受影响；插件桥接路径的错误文案不判 failProxy，行为不变（不在本轮范围）。
- docs/subsystems/gateway-routing.md 第 98 行补 failProxy 行为描述。

## 红/绿证据（当前 tip cb05dc2d 上）

新增三个测试（追加 `internal/gateway/proxy_down_test.go`，构造沿 #381 的 `TestProxyDownDoesNotRest` 模式：httptest 假厂商回 200 + `deadAddr` 死代理）：

| 测试 | 场景 | 修前（红） | 修后（绿） |
| --- | --- | --- | --- |
| TestProxyDownSkipsSharedProxy | a/b 同死代理 + c 独立出口 | 3 tries，b 被拨号（Fail=proxy） | 2 tries（a proxy + c 200），restingUntil 空 |
| TestProxyDownLastNotRetried | a/b 同死代理，无 c | 4 tries，b 退避重试 Again:1→Again:2 | 1 try（b 被跳过），502 立即返回，Again 全 0 |
| TestProxyDownDistinctProxiesLastNotRetried | a/b 不同死代理，无 c | 4 tries，b（不同出口）退避重试 | 2 tries，Again 全 0 |

- 修前红命令：`GOTOOLCHAIN=auto go test -tags nogui -p 2 -run 'TestProxyDown' -count=1 ./internal/gateway/` → FAIL（三测试各自红，错误文案 `proxyconnect tcp: dial tcp 127.0.0.1:<port>: connect: connection refused`）。
- 修后绿：同命令 ok；`-race -count=3` ok（2.85s）。
- 消融回红：两产品文件 `git checkout cb05dc2d --` 摘回基线、保留测试 → 三测试各自回红（红法上表）；恢复修复 → 复绿。消融前修复文件备份于 /tmp/hunt38-ablation-bak。
- 定向回归：`-run 'TestProxy|TestAgentGone|TestPatience|TestReplan|TestOverload|TestRetry|TestAgain|TestBusy|TestPassing|TestLastRetried|TestOutOfBudget|TestStreamless|TestTooLong|TestSink|TestLaneMate|TestGroupFailsOver|TestFallback|TestFirstToken|TestKeptAlive|TestQuiet'` → ok（19.2s）。
- gateway 全包：`GOTOOLCHAIN=auto go test -tags nogui -p 2 -count=1 -timeout 45m ./internal/gateway/` → ok（cb05dc2d 基 308.6s；rebase 到 bad4508c 后 313.5s，两次均绿）。
- 发帖前 tip 动了（cb05dc2d → bad4508c，#2656 custom tool 翻译）：rebase 后重放修前红（摘产品文件到 bad4508c、保留测试 → 三测试全红），恢复后全包绿。
- gofmt -l internal/gateway/ → 无输出。
- vet/build：`go vet ./...`（darwin，trayimage_darwin.go 的 cgo -Wenum-conversion 警告为预存）OK；`GOOS=linux go vet -tags nogui ./...` OK；`GOOS=windows go vet ./...` OK；`go build` darwin/linux(nogui)/windows 三平台 OK（ld 的 macOS 版本 warning 为预存）。

## 没跑什么

- 全仓 `go test -tags nogui ./...` 未跑（任务门禁为定向 + gateway 包全量）；guard 测试在别的包的面未触及（改动仅 internal/gateway 两个产品文件 + 测试 + 一处文档）。
- 插件 host（Bun fetch/HTTP2）路径的共享代理失败未处理：其错误文案不判 failProxy，行为与基线一致（不回归、不修复）——报告者 scope 的这一面留作后续。
- 跨请求的进程级代理健康记忆（报告者建议的后续项）未做：本轮按报告者建议的 per-request 范围。
- GUI/Playwright、真实代理进程恢复计时：不适用。

## 发帖正文（发帖前一刻 fetch + tip 复核后使用）

见下方正式 issue 评论草稿。
