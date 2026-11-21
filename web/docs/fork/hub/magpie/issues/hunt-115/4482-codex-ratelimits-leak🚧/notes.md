# hunt-115 / #4482 — gateway 把 Codex 自己的 `codex.rate_limits` 透传给另一个 agent，强类型客户端丢整个 turn

日期：2026-11-01 ｜ 结论：**让位**（报告者 crayonlu 自带完整修复分支），降级发英文验证/诊断帖

## 让位判定
- 共享规范明文：「报告者自带 patch 的单都不接」。本单报告者 = 修复者：c=1（2026-10-30T18:21Z）crayonlu 宣布 fork 分支 `crayonlu/magpie@codex-lead-events`（`1f6c5e21`，基于 `0fcb3acb3`，三文件 172 行），并明示 "ready to be merged as it is or ported with changes on top"。
- 开不了 PR 的原因：GitHub 限制 PR 创建给协作者（`CreatePullRequest` 权限拒绝）——与 magpie 禁 PR 政策 b91569d3 一致，分支挂 issue 等维护者收编/他人移植。
- 维护者零表态；未发 take，未推分支，未交竞争补丁。

## 排雷
- `0fcb3acb3` 是 upstream/main（`9d08993c8bd4`，开工 SHA）祖先；`codex_lead.go` 未合入 upstream。
- open PR 正文 `Fixes #4482`：无；title 含 rate/codex 的 open PR：#930（Windows Codex CLI 更新，无关）。
- #3427（Responses→Chat 翻译丢 error 事件字段）、#4445（Model Map reasoning.context 400）均 OPEN——同族兄弟单，不构成本单碰撞，也未修掉本单。

## 诊断事实（报告核验，on 9d08993c）
- `codex.rate_limits`/`codex.response.metadata` 进客户端流有两条上游运输，汇入同一写链：
  1. HTTP 直连 reply 的头部 SSE 事件（codex_limits.go 只 tap 读配额，reply 原样放行）；
  2. backend socket 桥（codex_socket.go:347-361）把同两帧 re-insert 进 `body.pending` 交回 relay。
- fallback.go:3535 把 `codex.` 前缀分类为 `eventLead`——failover 忽略，强类型客户端（async_openai `ResponseStreamEvent`）反序列化即死，turn 全丢；后端间歇性发送 → 表现为 upstream 抖。
- crayonlu 修法瓶颈口判定正确：`codexLeadTidy` 挂 passthrough 写链链尾（sniff.write 之后、thinkSigs 之后），守卫 `proto==Responses && sse && !fromCodex(r.Header) && agentOf(r)!="codex"` 与 codex_own_v1.go:39 现有判别逐字同款；丢弃规则按 `event:` 名（无名则 data `type`）的整个 `codex.` 命名空间，非枚举两个已知事件——未来新增 codex.* 也盖住。
- tap/failover 在 sniff 层读 upstream 字节，不受 tidy 影响（写链顺序实测：sniff.write → ids → phases → thinkSigs → leadTidy → 客户端）。

## 兄弟面 rg 全查（改/不改理由）
- **WS 路由（GET /v1/responses + upgrade，responses_ws.go）= 残余暴露面**：`socketTurnWriter.headerFrames()` 从 reply 自身头合成 codex.response.metadata + codex.rate_limits 发给任意 socket 客户端，无任何 agentOf/fromCodex 守卫（流式 turn 开头 + finish() 整 reply 两处）；relay 的 upstream 事件本身被修法盖住（socket turn 走 gateway POST 路径带原客户端头，内层 leadTidy 生效），但合成帧在 passthrough 之外。报告中无客户端走该路（Grok Build 走 SSE）→ 定性潜伏，帖内提示不丢，不改（修复权在 crayonlu/维护者）。
- **其余 codex.* 写出点**：rg `"codex.` 全仓——codex_limits.go（读）、responses_ws.go（WS 合成，上述）、codex_socket.go（backend 侧桥接）、fallback.go（分类）；passthrough HTTP 客户端链上无其它 codex.* 发射点 → 无遗漏。
- **x-codex-* 响应头**：普通头，强类型客户端忽略，不构成 crash 族 → 不改。

## 验证（detached worktree @9d08993c，沙箱 HOME，macOS arm64，Go 1.25.5）
- cherry-pick `1f6c5e21` → 零冲突自动合并，同样 172 insertions（基线落后 515 提交）。
- GREEN：`go test -tags nogui ./internal/gateway/ -run TestCodexLeadEventsStayWithCodex -count=1` → ok；`-race` → ok。
- RED（消融：gateway.go 回退 upstream、codex_lead.go+测试保留）：两外客户端四红齐发——`a client with no User-Agent`/`Grok Build` 各报 `event codex.rate_limits there=true, want false` 与 `codex.response.metadata there=true, want false`（codex_lead_test.go:94）；Codex CLI 用例绿。与 issue 报告逐字吻合。
- `gofmt -l` 三触及文件零输出；`go vet -tags nogui ./internal/gateway/` exit 0。
- 改动包全量 `go test -tags nogui ./internal/gateway/ -count=1` → **ok 546.359s 全绿**（移植到漂移 515 提交后的 base 无语义冲突；本机该包现无预存红——crayonlu 报告里的 #3045/#3547/#3680 红已被上游后续提交修掉）。失败集合为空 → 基线对照运行失去必要性，未跑无 patch 全量。
- 未验证：真实 ChatGPT 账号（二次登录可轮换 live refresh token，报告者同因未跑）、跨平台 vet/build、internal/gateway 之外套件（帖内 Not verified 已声明）。

## 发布
- 帖：https://github.com/yetone/magpie/issues/4482#issuecomment-6558262779（ggbdpq，2026-11-01T12:58:31Z，4414 字符，GET 回读逐字节一致——API 尾部换行规范化外零差异；英文，无 AI use 段、无 Attribution 行——账号即署名，同 #4480 先例）
- 稿件：diagnostic-post.md（自检：零中文、无 AI use 段、表格行间无空行、SHA 引用 5 处、yielding/@crayonlu 各 ≥1）
- crayonlu 补丁存档：crayonlu-1f6c5e21.patch（sha256 前 16：`e327e164d585436d`，10051 字节）
- worktree：/tmp/mg115-b9-4482（验证毕已 remove --force，主 clone 只读未动；我创建的 5 个沙箱 HOME 已清，兄弟车道 /tmp 产物未碰）

## 备注
- 若分支长期无人收编，本记录可直接复用验证结论再评估接手移植（届时按规范先评论声明再动）。
- WS 残余面若未来有人报，直接引用本帖 Sibling sweep 一节。
