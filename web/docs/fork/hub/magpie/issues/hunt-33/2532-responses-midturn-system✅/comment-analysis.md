**判定：这是 #502 的声明设计，不是缺陷，本单不动代码。** 报告者正文自己引用了 #502，这一点核对无误；下面把设计声明位置、设计实际边界、以及这个诉求该走哪条既有出口说清楚。

**设计声明位置**

- `internal/gateway/responses.go:279-284`：注释明确声明——首个回复之后出现的 `system`/`developer` 项就地降级为包 `<system-reminder>` 的 user 消息；提升进 system prompt 会改掉提示词开头，整个对话被重新写入厂商缓存（Anthropic 的 system 在最前，Claude 订阅的等待运行靠 system 找回）。
- 修复提交 `0cb6e13d`：提交说明完整记录了动机，包括订阅侧运行亲和（run 按 system 的 turnKey 匹配，system 一变就开新 run、整段对话重讲一遍）。
- 守护测试：`internal/gateway/codex_developer_cache_test.go` 的 `TestCodexLaterDeveloperMessageKeepsTheSystem`（断言两轮的 Anthropic system 字节级一致、后到 developer 项落在 `<system-reminder>` user 消息里、路由分类器只认用户原话）和 `TestCodexThreadKeepsItsClaudeRunAcrossAMemoryCall`（端到端：同会话插一次记忆调用后，developer 项降级，原 Claude Code run 继续接）。按提交说明，没有降级行为时这两个测试会失败。

**设计边界比 issue 正文描述的窄（对定位报告者场景有用）**

- `replied` 标志只在遍历到 assistant/tool-call 项之后才翻转，所以**会话头部（首个回复之前）的 developer 项每一轮都保住 system 权重**——Codex 每轮重发历史，头部的 `<permissions instructions>` 每次都提升进 system，从不降级。
- 按 magpie 自身对 Codex 线格式的记录（`prompt.go:304`、`prompt.go:406`），AGENTS.md 内容走 `<user_instructions>`（**user 角色**），不进降级分支，路由分类器也把它归为 system 上下文而非用户原话。「AGENTS.md 以 developer 项注入」与仓库已知的 Codex 线格式不符。若确有常驻规则被降级，它应 riding 在首个回复之后注入的 developer 项（`<skills_instructions>` 一类）。@MurmuredVelpro 方便的话贴一份线级抓包，看被违反的那条规则具体在哪个 item、什么角色、什么位置——如果它落在首个回复之前却仍被降级，那是降级条件本身的 bug，值得单开 patch 单。

**内容与格式侧核对过，无缺口**

- 降级保文不丢文：`<system-reminder>` 内逐字保留（守护测试断言）。
- `<system-reminder>` 正是 Claude Code 自己给 mid-turn 消息用的原生通道（`claude_subscription.go:3172` 的识别正则就是为它写的）；降级项对 Claude 读起来与 Claude Code 的 mid-turn reminder 同构，是 system 字段之下最强的信号位，不是格式冲突。
- 缓存侧：降级消息追加在消息序列尾部，稳定前缀不变，与缓存目标一致。

**这个诉求的既有出口**

- opt-in 保真模式与 #1378 同构，维护者在 #1378 已表态：订阅适配器保持原生 prompt 是硬约束，不打算加 caller-owned policy。#2322（Chat 路径同根）维护者只修了其中真缺陷（中途加的 tools 丢失，`afb0ff77` 已合），摆放策略维持原样。
- 权衡的另一面是真实的：把 mid-turn developer 项提回 system，每次上下文更新都重写缓存前缀并打散订阅运行亲和——这正是 #502 修掉的 bug，高频全量缓存重写比规则权重降级更贵。
- 若某条规则确实需要高权重，现有可行做法是把它放进会话首轮（Codex 的初始 developer/instructions 区），那里永远保住 system 权重。

综上：声明设计 + 无真缺口 + 同域策略讨论已有维护者立场（#1378）。等线级证据：若降级条件本身被证明有 bug（首个回复之前的项被降级），再开 patch。
