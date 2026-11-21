# #2197 复查（C 路 provider/agent，2026-10-18）

审计基线：worktree `/private/tmp/magpie-rev-c-prov`，HEAD = upstream/main = `d783df46`。fork 分支 `hunt19-b-pool-reminder` 现指向 `45835415`（基 `ebf3f48f` 2026-10-17，issue 所引 `5fe77cb0`/基 `331c2770` 之后已 rebase；patch 内容与 issue 正文引用一致）。

## verdict：PUSH

缺陷仍在、区域零提交、patch 干净可落且今日红绿闭环。比 issue 原稿更强的论据：**#720 自己的提交正文写明的提醒规则就已把池周窗口划进来了**，现行 `w.Aside` 一刀切与 #720 的书面规则相抵——本单不是"扩展 #523 豁免进裁决区"，而是"让实现回到 #720 自己声明的规则"。最小推进动作 = 发英文 ping（稿见文末）。

## ① 现状复核

- 缺陷仍在：`internal/provider/quota_alert.go:163`（`d783df46`）`dueReminders` 判定仍为 `if w.Aside || w.Span < reminderSpan || w.Used >= reminderUnder { continue }`——aside 一刀切。
- `dueAlerts`（line 81）已是行内豁免形态 `w.Aside && !(w.Pool != "" && w.Span == 7*24*time.Hour)`，与 patch 重构后的 `w.Aside && !toldAside(w)` 经 De Morgan 逐字等价（行为不变由既有 `TestDueAlertsPoolWindows` 绿色佐证）。
- 区域零提交：`git log --since=2026-10-13 --oneline upstream/main -- internal/provider/quota_alert.go` → **空**。近期唯一沾过 provider 配额邻域的 `7dc5cd8f`（10-15，Codex keychain）触及的是 `codex_store.go`/`account.go`/`codex_resets.go` 等，不含 quota_alert。
- 同题无 PR：`gh pr list --search 2197` → `[]`；`git log --grep '#2197' upstream/main` → 空。

## ② 本体对齐（"有意豁免"质疑的解除）

- **#523 本体（`29a14c9a`）提交原文**："A pool's weekly window is aside (using it up doesn't stop the account) **but is still told of**; the pools' 5-hour asides aren't." ——豁免是有声明的、有 `TestDueAlertsPoolWindows` 守护的。
- **#720 本体（`6e500cb52`）提交原文**（`dueReminders` 的诞生提交，晚 #523 一天，其循环已经遍历 `PooledWindows`）："- **a window of a day or more (weekly, monthly) renewing within those hours with under 85% of it used.** A 5-hour window renews too often to be news." ——书面规则**只字未提 aside**，且其文字（≥1 天、weekly、<85%、期限内续期）恰好逐字命中 Antigravity 池周窗口（aside、7d、40% used、20h 后续期）。代码里多出来的 `w.Aside` 排除是沉默实现，不是有意守护（`TestDueReminders` 原本没有任何 aside 断言）。
- 结论：patch 把实现拉回 #720 自己声明的规则，同时把豁免范围收在 #523 已声明的类别（仅池周，不开"所有 ≥1 天 aside"），on-demand 等其余 aside 照旧沉默。保守且两端都有本体文本背书。
- 兄弟面：全仓 `\.Aside` 过滤点（gateway/affinity、usage/window_holds、codex_limits、codex_autoreset、codex_switch、planquota 等）各有各的声明用途，与"重置提醒"同形矛盾的仅 `dueReminders` 一处；`codex_warmup`/`codex_autoreset` 不产池窗口（issue 已核对）。

## ③ RED 消融（沙盒 HOME + 缓存钉死，-count=1）

| 步骤 | 命令（`GOTOOLCHAIN=auto go test -tags nogui`，HOME=/tmp/revc-home） | 结果 | exit |
| --- | --- | --- | --- |
| GREEN（d783df46 + patch） | `-run 'TestDueRemindersPoolWeekly\|TestDueAlertsPoolWindows\|TestDueReminders' ./internal/provider/` | `ok ... 1.005s`（报一次、5h 不报、90% 不报；两既有测试断言零改动） | 0 |
| ABLATION RED（`git checkout -- quota_alert.go` 保留测试） | `-run TestDueRemindersPoolWeekly` | `--- FAIL: TestDueRemindersPoolWeekly ... quota_alert_test.go:217: got []` | 1 |
| 复 GREEN | 三测试同跑 | `ok ... 0.970s` | 0 |

`git apply --check /tmp/bpool.patch`（diff ebf3f48f→45835415）对 `d783df46` → **APPLIES CLEAN**。

## ④ 对抗攻击其余各项

- 热路径：`dueReminders` 只在配额读数 watcher 里跑，`toldAside` 是纯谓词，无代价。
- 默认覆盖用户自设值：不适用（提醒判定，不写设置）。
- 提醒噪音面：once-per-run + 85% 守护都保留（patch 测试三断言），不会造成重复轰炸。
- 平台面：纯判定逻辑，三平台 vet/build 在 issue 交付时已过；本单无平台分支。

## ⑤ 不自信清单

- 没有真实 Antigravity 账号的端到端通知截图（issue 已声明；池窗口形状以仓内 `TestDueAlertsPoolWindows` 记录的厂商真实报告为准）。
- 维护者仍可能以"提醒要比警报更克制"为由拒绝——但该政策性理由需要推翻 #720 自己的书面规则，打回成本高。
- patch 里 `w.Aside && !toldAside(w) || ...` 依赖 Go 运算符优先级（&& 先于 ||），语义正确但加括号更易读；若 review 挑风格，属一行改动。

## ⑥ 英文 ping 稿（可直接发）

> Gentle nudge on this one. Re-checked on today's tip (`d783df46`): `internal/provider/quota_alert.go` hasn't moved since 10-13, the patch still applies clean, and `TestDueRemindersPoolWeekly` passes with it and fails without it (`got []` — the account's weekly pool at 40%, renewing in 20h, saying nothing).
>
> One framing that may help the call: #720's own commit message states the reminder rule as "a window of a day or more (weekly, monthly) renewing within those hours with under 85% of it used" — no aside exception. The blanket `w.Aside` skip in `dueReminders` silently removes exactly Antigravity's weekly pools from that declared set, the same windows #523's alerts deliberately still tell of ("using it up doesn't stop the account but is still told of"). The patch makes the reminder path follow the alerts' exemption: pool weekly windows are reminded, the pools' 5-hour asides and every other aside stay silent, and once-per-run plus the 85% guard are unchanged.
>
> Branch: [hunt19-b-pool-reminder](https://github.com/ggbdpq/magpie/tree/hunt19-b-pool-reminder), one commit, one new test, no existing assertion touched, `git am`-able. If you'd rather reminders stay stricter than alerts, say the word and I'll close — but then #720's text is the thing to update, not just this patch.
