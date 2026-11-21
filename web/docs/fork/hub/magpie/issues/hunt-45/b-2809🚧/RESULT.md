# hunt45-b-2809 Copilot Auto 全局锁串行化 — 本地记录

issue: yetone/magpie#2809（source review 发现：`copilotAutoResolve` 持 `copilotAutoMu` 跨网络，一个账号的慢解析串行化所有账号的 Auto 查询/解析）
worktree: /tmp/magpie-h5（分支 `hunt45-b-copilot-auto-mu`，base upstream/main `1a3b9268860263f263a2c832b1f9b6d1b57e3fa0`）
commit: `eeb96ee5eb4e0d2d0c99bc3fcd22930928da5fdb`（作者 ggbdpq <ggbdpq@gmail.com>，未 push）
patch: `0001-provider-a-Copilot-Auto-resolution-for-one-account-d.patch`，sha256 前 16 = `00f0d13ddfedb000`
comment: `2809-comment.body.md`（英文，嵌完整 format-patch，已核对与 patch 文件逐字节一致，零中文字符）

## 改动形状

- `copilot_auto.go:158-186`：新增 `copilotAutoInflight`（key = `{token, fresh}`）+ `copilotAutoWait`（done channel + 结果）。
- `copilotAutoResolve`（:201）：锁只短暂持有三次——缓存读（条件原样，含 `!fresh`、过期窗、`!copilotRefuses`）、flight 登记、结果保存（err==nil 才写 sessions map；写结果、删 flight、close done 同一临界区）。等待者 select `call.done` 或自己的 `ctx.Done()`。
- `copilotAutoAsk`（:238）：原网络体（session 兑换、POST /auto、/models/session 回退）无锁执行；原三处 map 写入（route 成功、fallback、/models/session）合并为 resolve 里的一处。
- `ForgetCopilotForTest`（:518）同时清 flight map。
- 测试 `copilot_auto_test.go:209-346`：`autoHeld`（/auto 404 → /models/session 挂闸门并计数）+ `TestCopilotAutoConcurrent`：A 挂起时 B 冷解析 2s 内必须完成；同账号并发两请求（fresh=true 绕缓存）上游只打 1 次、两边同 session。

## RED / GREEN 实测输出

RED（base `1a3b9268`，修复前）：

```
--- FAIL: TestCopilotAutoConcurrent (2.12s)
    copilot_auto_test.go:303: an account's Auto resolution held another account's: B's wasn't answered within 2s while A's upstream answer was held
    copilot_auto_test.go:343: the same account asked twice together went upstream 2 times, want once
FAIL
FAIL	github.com/yetone/magpie/internal/provider	2.514s
```

GREEN（修复后，全 8 个 TestCopilotAuto* 通过）：

```
--- PASS: TestCopilotAutoPickServed (0.03s)
--- PASS: TestCopilotAuto (0.02s)
--- PASS: TestCopilotAutoSessionShapes (0.00s)
--- PASS: TestCopilotAutoSessionAsVSCode (0.01s)
--- PASS: TestCopilotAutoConcurrent (0.10s)
--- PASS: TestCopilotAutoUnavailable (0.00s)
--- PASS: TestCopilotAutoFallbackServed (0.01s)
--- PASS: TestCopilotAutoRefusedPicksAnother (0.01s)
ok  	github.com/yetone/magpie/internal/provider	1.585s
```

## 消融

`/tmp/h5-keep/` 备份修复版 → `git show upstream/main:internal/provider/copilot_auto.go` 覆盖 → 新测试 RED（2.11s，同样两行失败）→ 恢复 → GREEN（ok 0.961s）。

## 变异（各自命中各自断言，均恢复）

- (a) ask 期间重新持锁：B 2s 超时红（且第二个同账号 caller 进不了 flight，上游 2 次）。
- (b) 去掉 per-account 去重（永远新建 flight、无人等待）：仅 hit-count 红（2 次，want 1）；part 1 保持绿——判别精确。
- (c) 去掉 refusal 失效：**单一去掉不红**——`copilotAutoResolve` 缓存条件里的 `!copilotRefuses(token, a.Model)` 与 `copilotRefused` 里的 `delete(copilotAutoSessions, …)` 条件等价、互为冗余；两者一起去掉才红（`TestCopilotAutoFallbackServed` :209 "after gpt-4.1 was refused, Auto picked \"gpt-4.1\""；`TestCopilotAutoRefusedPicksAnother` :223 重试仍发被拒模型）。

## 验证矩阵

| 命令 | 结果 |
| --- | --- |
| `go test -tags nogui -count=1 -run 'TestCopilotAuto' ./internal/provider/` | ok，8/8 |
| `go test -tags nogui -count=1 ./internal/provider/` | ok 68.7s，1226 个顶层测试（`-v` 实数），0 FAIL |
| `go test -race -tags nogui -count=1 -run 'TestCopilotAuto' …` ×3 | 三轮全过（2.06/2.03/2.01s） |
| `gofmt -l internal/provider/` | 空 |
| `go vet -tags nogui` darwin/linux/windows | 全过 |
| `go build -tags nogui ./...` / `GOOS=linux` / `GOOS=windows -o /dev/null .` | 全过（darwin 有一条 internal/gui/trayimage_darwin.go 的 C 枚举转换 warning，预存、与本改动无关） |

## 对报告读法的核实

- 报告所述锁形状**属实**：entry 处 `defer Unlock`，跨 `app.session`、`copilotAutoRoute`（15s 超时）、/models/session 回退，且其他账号的缓存命中也要排同一把锁。
- 补充事实 1：生产路径只传 `fresh=false`（`copilotAutoSign`、account.go `acct.auto`），`fresh=true` 目前只有测试用；flight key 带 fresh 是保守选择（fresh 请求等自己的 ask）。
- 补充事实 2：refusal 失效是双保险（缓存条件条款 + copilotRefused 的 delete），见变异 (c)。

## Siblings（同包持锁跨网络，未动）

- `copilotToken`（account.go）持 `copilotMu` 跨 token 兑换 GET；`copilotDirect`（copilot_cli.go）持 `copilotMu` 跨 CLI endpoint GET —— 均为报告里说的 #2762 范围。
- `copilotTermsMu`（copilotAutoFallback/copilotAccept）与 `copilotSeenMu`：网络前已释放，无问题。

## 不确定项

- 无真实 GitHub 账号 / 真实 Copilot Auto 上游验证；fake 形状按本仓真实请求路径构造（/auto 2026-08-01 → 404 → /models/session 2025-10-01，session 按 copilotToken 的缓存形状 seed）。
- 同账号断言在上游计数发生在两 caller 都返回后，计数确定；闸门前 100ms sleep 只保证第二个 caller 落进等待（调度极端延迟时理论上可能 miss，概率极低）。
- 等待者加入 in-flight 时不重查缓存（标准 single-flight 取舍）：refusal 恰在 flight 进行中落地的窗口里，joiner 拿到的是刚问完的答案，下一个请求的缓存检查会纠正——报告中已如实说明。
