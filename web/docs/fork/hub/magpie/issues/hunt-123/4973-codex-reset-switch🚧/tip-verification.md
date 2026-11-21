# #4973 判定 — tip 核对记录

- 日期：2026-11-04
- worktree：/private/tmp/mg123-t（分支 fix/4973-codex-reset-switch，基 upstream/main 69eb93e0a）
- tip SHA：**69eb93e0a**
- 判定车道：调查单（diagnose）——判定为**预期行为**，发机理判定帖，不发 patch

## 报告者时间线（issue 全文摘录）

| 时间（2026-11-02, UTC+8） | 事件 |
| --- | --- |
| 16:08:57 | 最后一批旧式请求：requested=`gpt-6.1-sol`，席位=OpenAI · Codex's own sign-in，upstream=Codex · chatgpt.com |
| 16:12:05 | magpie 0.1.2693 重启 |
| 16:54:19 | 第一条新式请求：requested=`codex/gpt-6.1-sol`，席位=Codex · \<同 email\>，upstream=Codex · chatgpt.com as \<email\> |
| 16:54:23 | app.log：`codex reset used for <account>, its week used up: 2 windows started again` |
| 16:54:41 | 同一 rollout 首条非空 reasoning 摘要 |
| 17:24:58 | magpie 0.1.2710 启动 |

## 机理（tip = 69eb93e0a 逐条核对）

### 1. 周窗口用尽 → `Held` 读数

- `internal/provider/subscription_usage.go:1169` `codexHeld`：`rate_limit.allowed=false`（`codexAtLimit`:1204）且无 credits 可垫（Plus 无 credits，`c == nil` 不兜底）→ `q.Held=true`。
- `internal/provider/login_usage.go:557` `CodexUsedUpKnown` 缓存该读数。

### 2. 切换的两条入口（同一根因，两条路都通）

- **网关侧**（解释 16:54:19 的直接原因，无需重启）：`internal/gateway/codex_backend.go:796-799` `codexAccounts` 的 `codexHeldKnown()` 支路（**34b2dd9b7，2026-10-29，含于 v0.1.2693**）：sign-in 已知 out 且请求以 sign-in 名义签发 → 自己命名 `codex/<model>` 进 routing，"served as that restarted Codex's are, they go where routing sends them, with no restart"。
- **agent 接线侧**（#540 takeover，`internal/agent/codex.go:1728`）：`joined() && out()` 且 `codexOwnViaMagpie(m)` 非空 → 改写 config 模型为 `codex/<model>`（stash `codex.out_own` 留回切）。v0.1.2693 的 `internal/agent/codex.go:1674` 已有同分支。
- 两者都只在账号 out 后发生；out 前同会话所有请求走 relay-as-came。

### 3. reset 的果（16:54:23）

- 切换后该账号以 routing 候选出现，周窗口 100% 且开了 auto-reset（`CodexAutoResetWhen`，`internal/provider/codex_autoreset.go:40`）。
- 三条触发路：routing 层 `s.autoReset`（`gateway.go:4558`）、`resetBeforeCreditsOn`（`codex_backend.go:1185`）、relay 429 后 `autoResetSignedIn`（`codex_backend.go:1291`）。
- `AutoUseCodexReset`（`provider/codex_autoreset.go:189`）→ `weekUsedUp`（:259，周窗 ≥24h、Used≥100、未到 ResetsAt）+ 有 reset 卡 → 花卡 → `autoResetOf` 打日志 `codex reset used for <user>, its week used up: 2 windows started again`（`gateway/codex_autoreset.go:82`，`ResetOutcome.Text` 复数形式，`provider/codex_resets.go:221`）。
- **因果方向**：报告者已正确指出切换（16:54:19）早于 reset 日志（16:54:23）。代码层结论一致：reset 不是切换的原因，而是切换让请求进了 routing，routing 看到唯一候选周窗用尽，替它花了 reset 再重问。两者同为「周窗口用尽」的果，4 秒差自洽。

### 4. 三个显示维度为何联动

- **requested model**：客户端实际发的 model id。relay 路径=Codex 原发的 `gpt-6.1-sol`；routed 路径=网关自己命名/客户端改发 `codex/gpt-6.1-sol`（`withModel(body, id)`，`codex_backend.go:298`；usage `Requested: call.Model`，`gateway.go:3776`）。这是两条**真实不同的路由路径**，不是显示错误。
- **席位**（Routing Accounts & Keys）：relay 路径硬编码 `Who: "Codex's own sign-in"`（`codex_backend.go:1041`）；routed 路径 `weighed` 取 `Account.User`（`trace.go:533`）→ 同一账号显示为邮箱。账号没变，变的显示的是「这条请求走的路径」。
- **upstream host**：routed 记录 `Host: where = c.p.Where()`（`gateway.go:3255`）→ `"chatgpt.com as <email>"`（`provider.go:2077`）；relay 记录 `Host: provider.HostOf(base)` = 裸 host（`codex_backend.go:1581`）。Requests 表原样拼接（`plugins/usage/page.js:2478`）。
- **Usage 分组**：`Record.Account()` = ProviderAccount（`usage.go:98`）；分组键 provider+account（`usage-accounts.test.cjs:34`）→ 同一模型出两行（`codex@`/裸 vs `codex@<email>`）。历史行不回填（#2297 语义，540454ace 注释 "Rows already written are not rewritten"）。
- **reasoning 摘要**：两条路径对上游请求等价（同账号同 token 同 chatgpt.com 后端，请求体改写仅 model id）；摘要差异属上游自身波动（报告者已引 openai/codex#58548/#38160），非 magpie 路由导致。

## 版本核对

- 报告者运行 **0.1.2693**（e7185daeb，11-02 15:03）切换、**0.1.2710**（07f4d46c5，11-02 17:08）重启——两个版本 `codexAccounts`/`codexHeldKnown` 与 tip 完全一致（diff 零命中），takeover 分支 2693 已存在。机理对报告者版本成立。
- 34b2dd9b7（无重启切换支路）已含于 v0.1.2693。
- 540454ace（2026-10-15，#2297，作者 ggbdpq——本车道早前单）让 relay 行开始记账号，正是「同模型两行」的历史账本来源。

## 判定

**(a) 预期行为**。三显示维度同时切换是因为它们都是「这条请求走了哪条路径」的下游：served model 不变（同一 ChatGPT 后端），但 requested id、席位、host 记账按路径分开。reset 日志是切换后 routing 的果不是因。不修；帖内回应报告者 4 问并说明 display 标签改进可作 suggestion 留给维护者。

## 待改进（非本单 patch 范围）

报告者建议 2（UI 明示 native sign-in vs via-magpie-account）是合理的 UX 改进候选，但涉及 Routing/Usage 两页显示设计与 #2297 账本语义权衡，留给维护者定；判定帖如实说明现状分组逻辑与不回填语义。
