# provider: Antigravity 池的 7 天窗口收不到重置提醒——aside 一刀切挡掉了 #523 明确要告知的窗口

基线：`331c2770`（分支 `hunt19/b`，提交 `5fe77cb0`）。发稿前已再 fetch upstream：tip 前进到 `b7a2e7376`（新增 8 个 commit），`git diff 331c2770 b7a2e7376 -- internal/provider/quota_alert.go` 为空，缺陷仍在，patch 可直接 apply。

## 现象

开了 Settings › Usage 的 Reset reminder（如 24h）后，Antigravity 账号的池周窗口（"Gemini · 7 days"、"Claude & GPT · 7 days"）**永远不会**触发"窗口将续期、还剩很多"的提醒——哪怕它只用了 40%、20 小时后就清零续期。而同一个窗口的**用量警报**是正常的：用到 80% 会响（#523 特意让警报告知它）。

后果：用户对池周窗口"只被告知用得多了，从不知道快清零了"。同一账号、同一个 7 天窗口，两套通知对它说的是两套话。若同样的窗口出现在没有 aside 标记的厂商（Codex 的 7 days），40% 剩余 + 20h 续期会正常提醒。

说明：这是机制推演 + 单元级复现，没有真实 Antigravity 账号的端到端通知截图；池窗口的形状（aside、weekly、带 ResetTime）以仓内 `TestDueAlertsPoolWindows` 记录的厂商真实报告为准（该测试注释："the windows Antigravity really reports"）。

## 最小复现

新增 `TestDueRemindersPoolWeekly`（`internal/provider/quota_alert_test.go`）：给 `dueReminders` 喂 Antigravity 真实报告形状的窗口——池周窗口（`Pool: "Gemini", Span: 7d, Aside: true, Used: 40, ResetsAt: 20h 后`）和池 5 小时窗口——提醒开 24h。修前（把 `quota_alert.go` 的判定还原为 `w.Aside || …`）：

```text
--- FAIL: TestDueRemindersPoolWeekly (0.00s)
    quota_alert_test.go:217: got []
FAIL
FAIL	github.com/yetone/magpie/internal/provider	0.992s
```

即：还剩 60% 的周窗口在提醒窗口期内一言不发。修后同测试绿：周窗口报一次 `renews`（名字是池化的 "Gemini · 7 days"），同 run 不重报；5 小时池窗口仍然不报；用到 90% 的周窗口也不报（没什么可挽回，#720 原意）。

## 根因

`internal/provider/quota_alert.go`，`dueReminders`：

```go
for _, w := range PooledWindows(q.Windows) {
    if w.Aside || w.Span < reminderSpan || w.Used >= reminderUnder {
        continue
    }
```

`w.Aside` 一刀切。但 Antigravity 的池窗口在 `google.go` 的 `pools()` 里天生 `Aside: true`（注释："They are Aside: routing goes on reading the per-model windows"），经 `PooledWindows` 替换后，这个账号在提醒路径上能看到的 ≥1 天窗口**只有**池周窗口——全被 `w.Aside` 挡掉，5 小时池窗口再被 `reminderSpan` 挡掉，于是该账号的 renews 提醒永远为零。

对照：一天前的 #523（29a14c9a）给 `dueAlerts` 定下的豁免是有声明的——commit 原文 "A pool's weekly window is aside (using it up doesn't stop the account) but is still told of; the pools' 5-hour asides aren't"，且有 `TestDueAlertsPoolWindows` 守护。#720（6e500cb52）次日写 `dueReminders` 时只声明了两个排除理由（5 小时窗口 "renews too often to be news"、用满 ≥85% "little is lost"），aside 不在其列；`TestDueReminders` 也没有任何 aside 断言——是沉默，不是有意守护。两处遍历的是同一个 `PooledWindows` 集合，判定却分了叉。

## 修法

把 #523 的豁免提成两处共用的谓词 `toldAside(w)`（`w.Pool != "" && w.Span == 7*24*time.Hour`），`dueAlerts` 原条件换成它（行为不变），`dueReminders` 的 `w.Aside` 换成 `w.Aside && !toldAside(w)`：

- 池周窗口进入提醒判定（span 7d ≥ 24h 自然通过，used < 85% 时报）；
- 池 5 小时窗口双重挡住（aside 非周 + span < 24h），#720 "太频繁"的原意不变；
- on-demand/Copilot 补全等其余 aside 窗口照旧不提醒。

不扩范围：不给"所有 aside 且 ≥1 天"的窗口开提醒（#523 只声明了池周窗口这一类）；不动 `codex_warmup.go`/`codex_autoreset.go` 里的 aside 判定（Codex 读数不产池窗口，无此形态）。提醒的 key、once-per-run 语义、marks 文件都不变。

## 验证

| 命令 | 结果 |
| --- | --- |
| 修前（判定还原 `w.Aside ||`）跑 `TestDueRemindersPoolWeekly` | FAIL：`got []`（真实断言失败） |
| 修后同测试 | PASS（报一次、不重报、5h 与 90% 不报） |
| 有牙检查：再摘掉修复 | 回红：`got []` |
| `go test -tags nogui -p 2 -count=1 ./internal/provider/`（沙盒 HOME） | ok 72.486s（含既有 `TestDueAlertsPoolWindows`、`TestDueReminders`，均未改断言） |
| `gofmt -l internal/` | 无输出 |
| `go vet -tags nogui ./internal/provider/`（darwin / GOOS=linux）+ `GOOS=windows go vet ./internal/provider/` | 三个 exit 0 |
| `go build -o /dev/null .`（darwin）| OK（仅已知 ld macOS 版本警告） |
| `GOOS=linux go build -tags nogui -o /dev/null .` | OK |
| `GOOS=windows go build -o /dev/null .` | OK |

**没跑什么**：没有真实 Antigravity 账号的通知端到端（`pools()` 的 HTTP 形状由 `TestAntigravityQuotaPools` 系列守护，本单只动其后的判定）；GUI/TUI/CLI 不涉及（它们只显示 pooled 窗口，不过滤 aside）；`internal/gateway` 及其它包未跑全量——改动是 provider 包内未导出函数，无 API 变化，三平台 vet/build 已覆盖编译面。既有测试断言零改动（仅新增一个测试）。
