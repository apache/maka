# #2454 复查报告 — Command Code Credits 月池窗不显示重置时间（B 路 usage/计价）

复查日期：2026-10-18。审计基线：upstream/main `d783df46cbac9021e26a6bd71ca0b55544552eb2`（2026-10-18 07:13 +0800）。worktree `/private/tmp/magpie-rev-b-usage`。

## verdict：IMPROVE（原 patch 已被现场淘汰；缺口收窄到计划 key 卡，rebase 后仍站得住）

原 patch（`docs/issues/hunt29/c-cmd-credits-reset.patch`，head `889280a2`）**在最新 main 上已不能应用**：其订阅卡半边被维护者自己的退役提交 `be62bcf7`（10-17，作者 yetone）整体删除（`commandcode_go_test.go` 文件已不存在，`cmdQuotaOf` 旧 hunk 失配）。但缺口没有消失——它**收窄到计划 key 卡路径**：`cmdKeyWindows`（`planquota.go:607` 调用）的 Credits 窗仍无重置时间，且周期端数据 `until` 已被 `cmdKeyPlanID` 拉回又**直接丢弃**（`id, _, _, _, ok := cmdSubscription(...)`），修复比原版更便宜（零新增请求）。本复查已完成最小 rebase（`review-2026-10-18/2454-cmd-credits-reset-rebased.patch`），消融断言红、三平台 vet 绿。下一步动作：撤旧稿、发新稿（rebased patch + 分支），正文引用维护者两次已落地动作与退役后的现场事实。

## 现场时间线（一切以这条线为准）

| 时间 (UTC) | 事件 | 证据 |
| --- | --- | --- |
| 10-16 09:43 | 维护者评论：插件 0.1.13 已补 Credits reset（对真实 GOAT key 核过，= `until`）；mover `min` 待提；**"内置侧 magpie main 也还没设——由本帖 patch 补"** | issue 评论 1 |
| 10-16 11:38 | `53009f81` 落 main：mover min 提到 commandcode 0.1.13，提交正文点名 **"commandcode 0.1.13: Credits reset at the subscription's end (#2454)"** | `git log -1 53009f81`（在 d783df46 内，`merge-base --is-ancestor` 验证） |
| 10-16 17:57 | **`be62bcf7` 退役内置 Command Code**：删登录/账号/每登录 usage（`cmdLoginQuota`/`cmdQuota`/perLogin fetch）、Go plan 路径、网关分发；未迁移账号由"无"服务（AGENTS.md） | `git show --stat be62bcf7` |
| 10-17 04:17/04:19 | 我方误读让位 + 即时收回（issuecomment-6229557401），"patch 站住"的判断当时对旧基线成立，但未预见 8 小时前的退役提交 | issue 评论 2、3 |

维护者"内置侧由本帖补"的表态**已被他自己的退役提交在机制上取代**：订阅卡不复存在，谈不上在其上设 reset。这是本单 verdict 从 PUSH 改为 IMPROVE 的根本原因。

## 缺口收窄后的受益面（YAGNI 评估）

- **订阅用户（GOAT 登录账号）**：mover min 已提（`53009f81`）+ 每小时 `MoveRetiring` 强迁（AGENTS.md 10-16 起，无回退）→ 插件 0.1.13 的 `resetsAt=until` 覆盖。**本 patch 对他们已无事可做**——内置侧 patch 的这部分应明确放弃。
- **未迁移用户**：退役后由"无"服务（Providers 列表一行说明 + Move 按钮），根本没有卡，无缺口可言。
- **计划 key 用户（vendor 买的 API key 作为 key provider 接入）**：`planquota.go:607 → cmdKeyWindows → cmdQuotaOf` 路径**不归退役管也不归插件管**（key 是普通 provider，插件服务的是订阅 `commandcode-plan`）。现状 Credits 窗（`commandcode_plan.go:262`）无 `ResetsAt`，同卡 5-hour/Weekly 两窗都有 reset——与 issue 标题描述的缺陷在 key 卡上原样存在。且 `cmdSubscription` 返回的 `until` 在 `cmdKeyPlanID`（:337）被四个 `_` 丢弃——数据在手、扔掉不接。**这是 patch 剩余的真实价值**，不是 YAGNI。

## 我方交付（步骤②）与 rebase（本复查新增）

- 原 patch：订阅+key 双卡；现仅 key 卡存活。rebase 后 diff（3 文件，+58/-14，已存 `2454-cmd-credits-reset-rebased.patch`）：
  - `commandcode_plan.go`：`cmdSeen` 加 `until` 字段；`cmdKeyPlanID` 返回 `(plan, until)` 并把读过的 pair 留在 `cmdKeyPlans`（读失败时回吐旧 pair，与 id 的既有语义一致）；`cmdQuotaOf` 加 `until` 参数接到 Credits 窗 `ResetsAt`（其唯一存活调用方就是 `cmdKeyWindows`）；`cmdKeyWindows` 接住 until。
  - `planquota_test.go`：`TestCommandCodeQuotaShowsWindows` 两处 `cmdQuotaOf` 调用补 `, nil`（签名变化）。
  - `commandcode_key_credits_test.go`：新增 `TestCommandCodeKeyCreditsRenewAtPeriodEnd`（原测试的 key 卡半边，适配现文件脚手架：`rewrite` transport + X-Host 路由，`currentPeriodEnd=4102444800000`（2100-01-01））。
- 原 patch 的订阅半边（`cmdQuota`/`cmdRemember`/`commandcode_go_test.go`/docs 订阅措辞）全部放弃——目标已删。

## RED 复核（步骤③，在 d783df46 上）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 原 patch 可否应用 | `git apply --check c-cmd-credits-reset.patch` | `error: internal/provider/commandcode_go_test.go: No such file or directory` + plan.go hunk 失配（**不能应用**） |
| 修后新测试 | `go test -tags nogui -count=1 -p 2 -run TestCommandCodeKeyCreditsRenewAtPeriodEnd -v ./internal/provider/` | `--- PASS: TestCommandCodeKeyCreditsRenewAtPeriodEnd (0.00s)` |
| ABLATION 还原 plan.go+planquota_test.go（仅留新测试文件，走公开路径 `planKeyWindows`） | 同 run | `--- FAIL ... commandcode_key_credits_test.go:114: the key card's credits have no reset: {... ResetsAt:<nil> ...}`（断言级红） |
| 修后 provider 全包 | `go test -tags nogui -count=1 -p 2 ./internal/provider/` | `ok ... 66.001s` |
| 修后相邻包 | 同法 `./internal/usage/ ./internal/catalog/` | 均 ok（11.9s / 1.3s） |
| gofmt（3 文件） | `gofmt -l` | 无输出 |
| vet | `go vet -tags nogui` darwin / `GOOS=linux` / `GOOS=windows` | 全部无输出 |

注：第一次消融曾因 planquota_test.go 的 `, nil` 编译参数残留而 build failed——签名兼容改动不是断言，已还原后重做，消融红为真断言（`ResetsAt:<nil>`）。

## 对抗攻击（步骤④）

1. **撞已裁决口径？** 不撞，方向反而被两次背书：插件侧口径（`resetsAt = sub.until`）是维护者自己 10-16 定的并核过真实 key；mover 提交正文点名 #2454。key 卡把 Credits 窗的 reset 接到同一 `until` 是同口径的延续。
2. **退役使 patch 过时？** 是，对订阅半边成立——这正是本 verdict 的核心，处理方式是放弃该半边并在对外稿里明说，不嘴硬。
3. **默认覆盖用户自设值？** 无涉：不写任何设置，只把已读到的 `until` 接到窗口字段；读失败语义保持"未知即 nil"，回吐旧 pair 沿用 id 的既有保底（code-standards "failed read means unknown"）。
4. **兄弟路径**：`cmdQuotaOf` 现仅一个调用方（`cmdKeyWindows`），签名改动全量覆盖；`cmdSubscription` 其它消费点无（grep 全仓仅 cmdKeyPlanID）。Ollama Cloud 等其它 plan 的 `period.until` 已各自接好（#1888），无同型遗漏。
5. **测试是否只测实现**：走公开入口 `planKeyWindows`（key 卡的真实读路径），断言 Credits 窗的 `ResetsAt.UnixMilli()`；读失败保底由紧邻既有测试 `TestCommandCodeKeyCardHasCredits`（subsDown 场景）覆盖，其断言（仍 3 窗、plan 仍 "Go"）在 rebase 后保持绿。
6. **热路径**：`cmdKeyPlanID` 原本就每 10 分钟才问一次 billing/subscriptions（15-20s 的慢端点），改动不增加任何请求，只利用既有返回值。无 LESSONS 违规。

## 收益三句话（步骤⑤）

在 magpie 里配了 Command Code 计划 key 的用户（不是订阅登录，是 key provider），Usage 页该 key 卡的月度 Credits 表格终于和同卡其它两窗一样显示何时回满——数据本来就在每次读 plan 时拉回，只是被扔掉。订阅用户与未迁移用户已由插件+mover 覆盖，不在此 patch 影响面内。

## 不自信清单

- 未对真实 Command Code key 实测（本机无 key）；`currentPeriodEnd` 形态取自原 patch 对真实回复的记录（其"Not tried against Command Code's real API: there is no plan key here"的限制原样继承）。
- key 卡与订阅卡在维护者语境里是否算同一件事未可知：他 10-16 只点名"内置（订阅）侧"，key 卡缺口未被明确点名——新稿需把 key 卡作为独立受益面讲清楚，可能被以"另有单更合适"为由移单。
- rebase 未跑 `./...` 全量（纪律 2）；provider 包全量 + usage/catalog 相邻包已绿。
- `MoveRetiring` 强迁是否存在死角（插件未安装/签名失败用户）未逐一验证，但那影响的是订阅侧（本 patch 已放弃的范围），不影响 key 卡结论。

## 英文对外稿（可直接发，含 rebased patch 附件位）

```markdown
The ground moved under this patch, so I rebased what survives. `be62bcf7` retired the built-in Command Code subscription and removed the subscription-card paths the patch reset — that half is withdrawn; between the mover's min now at 0.1.13 (53009f81, whose body names this issue) and the hourly MoveRetiring, the plugin's `resetsAt = sub.until` covers subscription users.

What retirement left behind is the **plan key's card**: `cmdKeyWindows` (`planquota.go`) still builds the Credits window with no reset, and `cmdKeyPlanID` fetches the period end and throws it away (`id, _, _, _, ok := cmdSubscription(...)`). A key provider isn't the retired built-in and isn't served by the plugin, so this card is where the missing reset still lives — same symptom as reported: the 5-hour and weekly windows each say when they start again, the month's credits alone say nothing.

Rebased patch (on `d783df46`): `cmdKeyPlanID` keeps and returns the period end beside the plan id (the pair read before still stands while the endpoint can't be read), and `cmdQuotaOf` puts it on the Credits window's `ResetsAt`. No new request — the endpoint was already being asked every ten minutes; its reply is simply not discarded anymore.

Run (on `d783df46`):
- New `TestCommandCodeKeyCreditsRenewAtPeriodEnd` (key card through the real `planKeyWindows` path, httptest from the reporter's reply shapes): FAIL without the change — `the key card's credits have no reset: {Name:Credits ... ResetsAt:<nil> ...}`; passes with it.
- `go test -tags nogui -count=1 -p 2 ./internal/provider/` ok (66s); `./internal/usage/` and `./internal/catalog/` ok.
- `gofmt -l` clean; `go vet -tags nogui` on darwin, GOOS=linux and GOOS=windows clean.
- Not run: `go test ./...`, the GUI, a real Command Code key (none here) — same limitation as the original posting.

<details><summary>Patch (git apply, on current main)</summary>
[attach 2454-cmd-credits-reset-rebased.patch]
</details>
```
