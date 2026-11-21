# 快速搭建个人 Coding Agent 学习指南

> 目标：用一个真实可运行的个人 Coding Agent 项目，同时完成三件事：理解 Agent Engineering 核心机制、能从零手写最小实现、面试时能解释架构取舍与演进路线。

## 1. 项目定位与当前决策

当前项目定位为 **Coding Agent Lab**。本地建议放在：

```text
E:\guahub\vibe\labs\coding-agent
```

GitHub 仓库可命名为：

```text
coding-agent-lab
```

推荐结构：

```text
coding-agent/
├── docs/           # 学习、架构、面试材料
├── specs/          # 跨语言统一行为规范
├── references/     # Codex / MiniMax Code / ZCode 研究材料
├── typescript/
├── python/
├── rust/
├── go/
└── README.md
```

四种语言是同一套 Coding Agent 思想的独立实现，用于比较语言特性与工程生态。共享 Agent Loop、Tool Protocol、Session/Turn、Context、Permission、Provider、Event 等规格，各自保留原生工具链。

```text
TypeScript  -> pnpm
Python      -> uv / pyproject.toml
Rust        -> cargo
Go          -> go modules
```

顶层工具可以负责统一脚本和 CI，但不应遮蔽各语言原生依赖、构建、测试体系。学习语言时，工具链本身也是学习内容。

遵循 YAGNI。尚未实现的语言不要提前创建空目录，真正开工时再增加。

## 2. Coding Agent 最小心智模型

一句话理解：

> Coding Agent 是一个带工具、状态、上下文和安全边界的 LLM 执行循环。

核心闭环：

```text
User Task
   ↓
LLM
   ↓
Tool Call?
   ├─ No -> Final Answer
   └─ Yes
        ↓
   Permission
        ↓
      Tool
        ↓
   Tool Result
        ↓
     Context
        ↓
       LLM
```

真正应该先手写的是这条闭环。Plugin、MCP、Subagent、TUI 都属于外围能力。

## 3. 面试必须掌握的核心名词

- **Agent Loop**：LLM 决策、调用工具、接收环境结果、继续决策的循环。
- **Turn**：一次用户输入触发的完整执行生命周期，一个 Turn 内可以包含多次 LLM 和 Tool 往返。
- **Session**：多个 Turn 构成的长期会话与持久化边界。
- **Context**：真正发送给模型的信息集合，包括 Prompt、History、Tool Result 等。
- **Provider**：屏蔽 OpenAI、Anthropic、MiniMax 等模型 API 差异的适配层。
- **Tool Runtime**：Read、Grep、Edit、Write、Bash 等工具的注册、校验和执行环境。
- **Approval / Permission**：决定某个动作是否允许执行。
- **Sandbox**：限制进程实际上可以访问的文件、命令、网络和系统资源。Approval 与 Sandbox 应分层设计。
- **Event**：把 Agent 内部状态变化标准化，供 UI、日志、持久化、测试订阅。
- **Plugin / Extension SPI**：给内部功能提供统一扩展接口。
- **MCP**：连接外部工具和数据源的标准协议，不能等同于 Plugin。
- **Subagent**：把独立子任务交给另一个 Agent 执行，再把结果汇总回主 Agent。

## 4. 从三类成熟 Coding Agent 学什么

### Codex

重点学习它的工程执行与安全边界：

```text
Thread / Turn
Op / Event
Tool Orchestrator
Approval
Sandbox
Context Management
```

可借鉴原则：状态清晰、事件协议统一、工具执行集中治理、安全边界独立。

需要警惕：成熟产品的协议、Sandbox、兼容层和大量状态管理复杂度很高，个人 MVP 不应一次复制完整体系。

### MiniMax Code

公开源码最值得学习的是：

```text
TUI / CLI
   ↓
CliService
   ↓
Application
   ↓
Session / Turn
   ↓
Agent Runtime
   ↓
PiTurnRunner
   ↓
Model / Tools
```

`PiTurnRunner` 每个 Turn 创建独立状态，并通过串行事件队列维持事件顺序。`EventBridge` 负责把底层事件转换为统一 Runtime Event。`agent-runtime` 通过 Extension SPI 将 Tool、Prompt、Reminder、Hook 等能力统一接入。

可借鉴原则：Turn 隔离、事件统一、扩展入口统一、UI 与 Runtime 分离。

需要警惕：源码包含历史兼容、`local-runtime` 与 `local-runtime-v2`、第三方 `pi-mono` 等产品级复杂度。学习机制即可，不要复制目录数量。

### ZCode

当前更适合作为产品体验参考，重点观察 Plan/Agent 模式切换、Context 使用、权限模式、持续对话和 Coding UX。对其不可见内部实现不要做无证据推断。

## 5. 自己的项目应该保留什么

当前个人实现最有价值的方向：

1. Agent Loop 自己手写，保持调用链可追踪。
2. Provider 与 Core 解耦，内部消息协议统一。
3. Tool Schema 与实际执行分离。
4. Permission 统一进入一个执行闸门。
5. Session 使用简单可检查的持久化形式，例如 JSONL。
6. Context 有明确预算和裁剪策略，避免无限增长。
7. CLI、Web、未来 TUI 共用同一个 Turn Runtime。
8. Event 逐步统一，避免 UI 直接耦合执行细节。
9. 每一层抽象都必须能解释“它解决什么真实问题”。

核心设计原则：

> 最小机制 + 可组合能力 + 强安全边界 + 可解释调用链。

## 6. 项目最值得讲的重难点

### Agent 怎样停下来

必须防无限循环。常见保护包括最大 Tool Round、AbortSignal、超时、Token Budget、重复调用检测。

### Streaming Tool Call

流式响应可能把一次 Tool Call 的 name、arguments 拆成多个 chunk，需要正确拼装并校验完整性。

### Context 如何长期运行

Context 不应无限追加。最小实现可优先裁剪低价值 Tool Result，进一步演进为 Compaction，把历史压缩成结构化摘要。

### 安全怎样分层

```text
模型提出动作
  ↓
Policy 判断
  ↓
Approval
  ↓
Sandbox / Workspace Boundary
  ↓
真实执行
```

面试时不要把“弹框确认”描述成完整 Sandbox。

### 多 Provider 怎样避免污染 Core

Agent Core 只依赖统一 Provider Interface，各模型协议细节、SSE 差异、Tool Call 结构差异都由 Adapter 处理。

## 7. 推荐演进路线

```text
v0.1  Agent Loop + Provider + Read/Bash
v0.2  Edit/Write + Permission + Session
v0.3  Event Model
v0.4  Context Budget / Trim
v0.5  Workspace Sandbox
v0.6  Compaction
v0.7  Plugin / Extension SPI
v0.8  MCP
v0.9  Subagent
v1.0  TUI + Observability + Acceptance Tests
```

每一阶段都必须保持最小可运行闭环，再进入下一阶段。

## 8. 30 秒面试回答

> 如果让我设计个人 Coding Agent，我会先实现一个最小 Agent Runtime。用户输入进入一个 Turn，模型判断是否需要调用工具；Tool Call 经过权限策略后执行 Read、Grep、Edit、Bash 等工具，Tool Result 再进入 Context，继续调用模型直到任务完成。外围再拆 Provider、Session、Context Manager、Event 和 Permission。后续根据真实需求增加 Sandbox、Plugin、MCP 和 Subagent。我会借鉴 Codex 的安全执行与事件模型、MiniMax Code 的 Turn 隔离与 Extension SPI，以及 ZCode 的交互体验，但始终保持自己的核心调用链足够简单、可解释。

## 9. 面试追问时的项目亮点

可以重点展开四点：

- 同一个 Coding Agent 架构分别用 TypeScript、Python、Rust、Go 实现，用真实代码理解不同语言的类型、错误处理、并发和生态差异。
- 跨语言共享行为规范，不共享实现细节，避免四份代码逐渐产生语义漂移。
- 通过研究 Codex、MiniMax Code、ZCode，吸收成熟设计，同时主动拒绝产品历史包袱和过度抽象。
- 最终只选一个语言版本继续产品化，其余版本保留为架构对照与学习资产。

## 10. Labs 通用治理规则

`vibe/labs/` 用于学习、复刻、技术验证和原理实验。父目录已经表达实验属性，因此子目录直接使用领域名：

```text
labs/
├── coding-agent/
├── language/
└── syntax-party/
```

本地目录使用简洁领域名，独立 GitHub 仓库可以增加 `-lab` 以补充上下文，例如 `coding-agent-lab`、`language-lab`。

子项目目录优先使用完整语言名：

```text
go
python
rust
typescript
```

不要使用 `gcode/pcode/rcode/tcode` 或 `lang-py/lang-rs/lang-ts` 作为长期公开名称。缩写适合临时原型，不利于长期可读性。

另一个“自制编程语言”实验建议迁移为：

```text
vibe/labs/language/go
```

目前只有 Go 有真实实现时，只保留 `go/`。项目成熟并获得正式语言名称后，再升级为独立仓库和产品名。

## 11. 下一步

当前优先级：

```text
1. 完成 coding-agent 目录迁移
2. 保证现有 TypeScript 实现功能不变
3. 固化 specs 中的最小跨语言行为规范
4. 用 Python / Rust / Go 各实现一次最小 Agent Loop
5. 对比四种语言的 Tool、Event、Error、Async 设计
6. 选择一个版本进入真正产品化
```

验收标准只有一个：

> 面试官给一块白板，你能够从 `User -> Turn -> LLM -> Tool -> Result -> Context -> LLM` 开始画，并解释每增加一个模块究竟解决了什么问题。
