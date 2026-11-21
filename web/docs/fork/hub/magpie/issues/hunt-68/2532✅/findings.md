# hunt68 #2532 Lane A 验证结论（2026-10-23）

单元：#2532（Responses→Claude mid-turn developer/system 降级）。本轮挑战：MashiroSky 10-23 报 Codex Plan→Default 切换失效 + `codexAsSent: true` 绕过，直接质疑我方 10-17「声明设计」定性。

## 基线核实

- 开场 GET 复核：#2532 `comments=3`（正文 + ggbdpq 10-16 判定 + MurmuredVelpro 10-17 wire capture + MashiroSky 10-23 新帖），与查重基线一致。
- origin/main 开场 fetch 后由 85534cd0 前移到 **3b8bcc36**，worktree 已 ff 到该 tip；`responses.go` 与 `codex_developer_cache_test.go` 在 85534cd0→3b8bcc36 间零变化（diff 仅错误解码器），分析在新 tip 上成立。
- 报告者版本 **0.1.1319**（tag 存在）：`0cb6e13d`（降级提交）**已包含在 0.1.1319**；v0.1.1319→3b8bcc36 的 responses.go 差异仅在 responsesDecoder 错误分支，降级区域逐字节相同。MashiroSky 的 magpie 行为与 tip 一致。

## 机理核实（成立，确定性、无 LLM）

转换路径：`internal/gateway/responses.go` `parseResponses` 341-370（tip 行号）：

- `replied` 标志在遍历到 `assistant` 角色或 `function_call`/`custom_tool_call`/`tool_search`/`reasoning` 项时翻转（344-346）。
- 翻转前：system/developer 项拼接进 `r.System`（361-368）——会话头部 developer 项每轮都提升进 system。
- 翻转后：system/developer 项降级为 `user` + `<system-reminder>\n…\n</system-reminder>`（354-360，发射点 357，全仓唯一）。
- 设计注释（335-340）原文明确列出 "a model switch" 是 Codex 添加 mid-thread developer 消息的场景之一——设计者知晓模式切换走这条路。

RED 见证（`TestHunt68FreshModeInstructionKeepsItsSystemWeight`，失败即证据，全文见 red-run.txt）：Plan(头部 developer)→user→assistant→Default(mid-thread developer)→user 的构造经完整 HTTP handler（Codex 头、fake Anthropic 上游）转发，上游请求形状：

```text
system: "You are Codex.\n\n<permissions instructions>mode: plan — research and plan only, do not modify files</permissions instructions>"
message[0] user: "plan a fix for the bug"
message[1] assistant: "here is the plan"
message[2] user:
    "<system-reminder>\n<permissions instructions>mode: default — you may edit files and run commands</permissions instructions>\n</system-reminder>"
    "execute the plan now"
```

即：旧 Plan 指令保 system 权重，新 Default 指令以 user 权重、且在用户原话前一块到达。按权威解决冲突的模型必然偏向 Plan。形状 pin 测试（`TestHunt68ModeSwitchWireShapeAsItIs`，PASS）进一步钉住：system 与无切换对照字节相同（#502 缓存稳定目标达成），reminder 包裹逐字节 `<system-reminder>\n…\n</system-reminder>`。

## asSent 对照（关键：因果链在 magpie 代码内不闭合）

`CodexAsSent` 全仓唯一行为读取点：`gateway.go:4213`，在 `passthrough`（Responses→Responses 同协议透传）内部，条件 `p.CodexAsSent && p.Account == nil && fromCodex(r.Header)`。CLI 入口 `codex=as-sent`（providers_cli.go:1046-1054），GUI 仅持久化（gui/providers.go:1540）。

两个消融（均确定性、PASS）：

1. **翻译路径（降级所在）**：`TestHunt68CodexAsSentLeavesTheClaudeWireUnchanged`——同一构造、Codex 头、只翻开关，上游请求**字节级相同**，system 依旧只含旧 Plan。开关对降级零作用。
2. **透传路径（开关唯一生效处）**：`TestHunt68ModeInstructionKeepsItsRoleOnAResponsesRelay`——两条 developer 项在开关 off 与 on 下都保持 `role: "developer"`、无 `<system-reminder>`；降级在该线根本不发生（`forVendor` 等适配只动字段/元数据，不动角色）。

**结论**：MashiroSky 报的「codexAsSent 绕过」无法由 responses.go 的降级解释。自洽的解释只剩：(a) 其 provider 走透传（paperhub 是 Responses relay），magpie 从未降级——asSent 翻转改变的是适配形状，起作用的是 **relay 自己**对 fitted vs as-sent 请求的不同处理（这正是 #1758 开关存在的理由）；或 (b) 观察时段有混杂因素（线程/进程状态）。若其 provider 走翻译路径（Claude 模型），asSent 在代码上不可能有作用。已在评论稿内向报告者要 magpie 侧 off/on 请求对。

## 原定性重审

10-17 判定的两个支柱核实仍然成立：

- 设计声明位置与守护测试属实（`TestCodexLaterDeveloperMessageKeepsTheSystem` 字节级钉住 system 一致 + reminder 就位 + 路由分类器只认用户原话；`TestCodexThreadKeepsItsClaudeRunAcrossAMemoryCall` 端到端钉 run 亲和，Windows 按 fakeClaude 守卫 SKIP）。
- 边界比 issue 正文窄属实：头部 developer 项每轮保 system 权重（`replied` 分界）；AGENTS.md 内容走 user 角色 `<user_instructions>`（prompt.go:304-307、400-406 现仍 `txt("user", t)`），不进降级分支。

**判定未计价的代价（本轮新证据）**：设计注释自己把 "a model switch" 列为 mid-thread developer 消息的成因，即「被降级项是早前已提升指令的替换」这一场景在设计自述范围内。在该场景下取舍不是「上下文更新低权重、无碍」，而是**被取代的旧指令在权威上压过其接替者**（优先级倒置）。缓存稳定性的代价表里没有这一项：对增量上下文（skills diff、环境态）代价不可见，对模式切换就是 MashiroSky 的失效。#1378 的维护者表态针对 caller-owned policy，不覆盖 Codex 自身的替换语义——原判定援引它封「fidelity 出口」有用，但不回答「替换语义」问题。

定性措辞：**维持「这是 #502 声明设计的运行结果」（代码+守护测试实证），但「该设计在动态控制指令场景的代价未被计价」成立；是否豁免/改策属维护者裁决，稿内以证据+问句呈交，不单方面翻案。**

## 兄弟面（同一降级的全部路径）

- 降级唯一发射点 `responses.go:357`，作用于 `parseResponses` 之后的所有翻译路由：→Anthropic/Messages（本单主线，含 Claude 订阅 `serveClaudeSubscription`，claude_subscription.go:4146 同经 `parse`）；→Chat（`buildChat` 把 reminder 文本按 user 消息渲染）；→Gemini/Code Assist（`buildGemini`/`buildCodeAssistSent`，reminder 按 user content 进 contents）。三线同型代价。覆盖。
- Chat 客户端方向是**相反策略**：`parseChat`（chat.go:103-105）把所有位置的 system/developer 全部提升进顶部 system（chat.go:110、`r.System = strings.Join(sys, "\n\n")`）——保权威、改前缀（#502 在 Responses 线避免的那个代价）。#2322 维护者只修了工具丢失（liftMessageTools），摆放策略未动。覆盖（与 issue 正文 #2322 引用一致）。
- Gemini/Anthropic 客户端协议无 mid-thread system 角色，无可降级。不适用。
- Responses→Responses 透传（含 asSent 两态）：原样透传，无降级。不适用。

## 验证矩阵（matrix.txt / matrix-race.txt）

- 定向：`TestCodexAsSent` PASS、`TestCodexLaterDeveloperMessageKeepsTheSystem` PASS、`TestCodexThreadKeepsItsClaudeRunAcrossAMemoryCall` SKIP（fakeClaude 需 shell 脚本，Windows 预存守卫）、4 个 TestHunt68：3 PASS + 1 FAIL（RED 见证，唯一 FAIL，故意保持失败）。
- 同集 -race：与上同结果，无 race 报告。
- `gofmt -l` 新文件干净；`go vet ./internal/gateway/` clean。
- 未跑：全 gateway 包、整仓（协议禁止）；LLM 实链路（本单元为纯形状验证，不需要）。

## 产物

- `probe-test.go.txt`：RED+消融测试源（worktree `internal/gateway/hunt68_2532_mode_wire_test.go`，随 worktree 保留可复跑）。
- `red-run.txt`：RED 运行全文（含请求形状原文）。
- `matrix-race.txt`：-race 逐测试明细。
- 评论稿：`docs/issues/hunt68/2532-comment.body.md`。

## 不确定项

1. Codex 真实线里 Plan/Default 指令的确切 item 形态（本机无 Codex 桌面复现环境）：形状测试用合成构造，其忠实性由 #502 提交注释（"a model switch" 产生 mid-thread developer 消息）与 MurmuredVelpro 抓包（index 26 developer 项 post-reply 存在）支撑，非直接抓包。评论稿已向报告者要 off/on 请求对。
2. paperhub 的实际线路（relay vs 翻译）未知，asSent 生效解释只能给到二择一。
3. `TestCodexThreadKeepsItsClaudeRunAcrossAMemoryCall` 在 Windows SKIP，订阅 run 亲和端到端面本机未验证（预存限制，非本轮新缺陷）。

## 本轮不自信的点

- 「asSent 绕过必有 relay 侧原因」是排除法结论：magpie 内证据（唯一读取点+两消融）很硬，但 relay 侧行为本轮完全不可见，不能排除报告者环境里的第三因素。
- 优先级倒置的「模型必然偏向 Plan」是机理推断（system>user 是各家声明层级），没有无 LLM 的办法在本机实证模型行为；稿内措辞已按「has to pick / reads one level under」限定。
- 维护者问句里「按切换频率摊销缓存重写」的量级判断（switch 稀少）是常识假设，无 magpie 侧数据。
