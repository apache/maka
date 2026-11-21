# provider: a Command Code Credits window says when it renews

## 现象

#2451 让 Command Code 的卡片（订阅卡与 plan key 卡）把月度 credits 画成 *Credits* meter，排在 5-hour 和 Weekly 两窗旁边。那两窗各自带「↻ resets …」行（卡片行、tooltip、菜单栏面板都读窗口的 `resetsAt`），Credits 一行却没有：月度 credits 恰恰是按订阅周期重置的，用户看不到它何时回来。同家族其它月度窗都有重置时间——Ollama Cloud 的 *Month* 窗接 `period.until`（readOllamaPlan）、StepFun 的 *Credits* 窗接 `subscription_credit_reset_time`（readStepPlan）、WorkBuddy 企业版接 `cycleResetTime`——唯独 Command Code 的没接。

## 最小复现

`TestCommandCodeCreditsWindowRenewsAtPeriodEnd`（新测试）在修复前的树上（1d227a7e）红：

```
--- FAIL: TestCommandCodeCreditsWindowRenewsAtPeriodEnd (0.00s)
    commandcode_key_credits_test.go:116: the key card's credits have no reset: {Name:Credits Used:47.8 ResetsAt:<nil> ...}
    commandcode_key_credits_test.go:128: the subscription card's credits have no reset: {Name:Credits Used:47.8 ResetsAt:<nil> ...}
```

假服务器按 #2451 测试同款形状回答 `billing/credits` 与 `billing/subscriptions`（后者带 `currentPeriodEnd`），分别走 `planKeyWindows`（key 卡）与 `cmdQuota`（订阅卡）。

## 根因

`internal/provider/commandcode_plan.go` 的 `cmdQuotaOf` 造 Credits 窗时不带重置时间：

```go
q.Windows = append(q.Windows, QuotaWindow{Name: "Credits", Used: min(100, 100*(pool-left)/pool),
    Display: money("$", pool-left) + " / " + money("$", pool)})
```

而两条调用路径手里都有周期端点：

- 订阅卡 `cmdQuota`：`cmdSubscription` 已返回 `until`（`billing/subscriptions` 的 `currentPeriodEnd`），只写进了 `q.Until`，没接到窗上；
- key 卡 `cmdKeyWindows`（#2451）：`cmdKeyPlanID` 调同一个 `cmdSubscription` 拿 plan id，把 `until` 扔掉了。

## 修法

`cmdQuotaOf` 加一个 `until *time.Time` 参数，Credits 窗带上 `ResetsAt: until`；两条路径各自把手里的周期端点传进来。key 卡侧 `cmdSeen` 增加 `until` 字段，`cmdKeyPlanID` 返回 `(id, until)`，缓存命中与读取失败时一并返回（和 id 的保留规则一致）。没有周期端点（`billing/subscriptions` 不可读）时窗上无重置，行为同修复前。

语义上 period end 就是月度池的重置点：Credits 窗的 `Used` 分子只反映月度 credits 的消耗（`pool-left = max(planMonthly, monthly) - monthly`），bought/free credits 只抬高分母，不随周期重置的部分不在这扇 meter 的读数里。

## 验证

| 检查 | 结果 |
| --- | --- |
| `TestCommandCodeCreditsWindowRenewsAtPeriodEnd`（新） | 修复前红（上表输出），修复后绿 |
| 消融（产品文件回父提交 1d227a7e，旧调用点测试文件同回，新测试保留） | 红，失败断言与修前红同形 |
| `TestCommandCodeKeyCardHasCredits` / `TestKeyQuotasKeepLast` / `TestCommandCodeQuotaShowsWindows`（其两处 `cmdQuotaOf` 调用改传 `nil`） | 绿 |
| `go test -tags nogui -p 2 ./internal/provider/ ./internal/usage/ ./internal/catalog/` | 三包全 ok |
| `gofmt -l internal/` | 无输出 |
| `go vet`（darwin）与 `GOOS=linux go vet -tags nogui`、`GOOS=windows go vet` | 通过 |
| `go build`（darwin、linux nogui、windows） | 通过 |

补丁（基于 1d227a7e，commit 889280a2）：

```details
<summary>patch</summary>

```diff
```

## 没跑什么

- 没有对 Command Code 真实 API 试过（本机没有 plan key），`currentPeriodEnd` 即月度 credits 重置点是从订阅周期语义推的，与维护者在 #2451 的读法一致。
- 没跑 GUI 套件；`resetsAt` 的消费面（卡片 reset 行、tooltip、面板汇总行）读自 `app.js` 与 `trayusage.go` 现有代码，未实测渲染。

分支：[ggbdpq/magpie `hunt29-prov-cmd-credits-reset`](https://github.com/ggbdpq/magpie/tree/hunt29-prov-cmd-credits-reset)（commit 889280a2，基于 yetone/magpie 1d227a7e）。合入请保留原作者或加 Co-authored-by: ggbdpq <ggbdpq@gmail.com>。

Generated-by: GLM-5.3-Flash (ZCode)
