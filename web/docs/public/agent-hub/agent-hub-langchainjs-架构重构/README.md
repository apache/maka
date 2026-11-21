# agent-hub × langchain.js：智能体层架构重构与并行开发包

> 评审对象：`ggbdpq/agent-hub` **main @ `d0b6873`**（apps/web + apps/api + packages/shared）
> 参照系：langchain 1.5.18 / @langchain/core 1.2.18 / @langchain/langgraph 1.5.1 / @langchain/openai 1.6.2（npm 实装验证）
> 用途：交给 Cursor / ZCode 等编码代理**并行开发**。每个工作包写明归属文件、接口、验收和可直接粘贴的提示词。

## 一页结论

1. **这次是"引依赖"，和 coding-agent 正好相反。** coding-agent 的卖点是零依赖手写，所以只借语义；agent-hub 的卖点是"流式事件管线 + A2UI + 证据溯源"的**产品形态**，智能体循环本身不是卖点。现在的 `llm.py` 是手写的单次调用，没有循环、没有工具、没有记忆，自己补齐等于重写半个 langchain。所以直接用 `createAgent`。
2. **绞杀者迁移，不改前端协议。** 新增 `apps/agent`（TypeScript，Node 24，`node:http`，端口 8809），只接管 `/api/agent/chat` 与 `/api/evidence/:id`。FastAPI 继续负责任务与订单。前端只改两处：Vite 代理分流、请求体多带一个 `threadId`。五种事件、帧格式、`sse-decoder` 签名全部不动。
3. **A2UI 改成"工具即 UI"，并加因果校验。** 卡片不再靠 Markdown 围栏解析，改成工具 `present_recommendation`。工具只接受**本轮** `search_evidence` 返回过的证据 id、`search_catalog` 返回过的 skuId；不满足就报错，错误回灌给模型，模型自我修正。这同时修掉两件事：
   - 证据"引用洗白"（A-P0-1）；
   - 模型自己报价（价格只从目录取）。
   > 这里推翻了 05 评审里"保留围栏"的 YAGNI 判断。理由：有了智能体循环，校验失败可以让模型自我修正；围栏模式只能丢弃。
4. **离线剧本走同一张图。** mock 模式不再是另一条代码路径（A-P1-3），而是一个按会话状态决策的 `ScriptedChatModel`，和真实模型共享 createAgent、工具、中间件、翻译层。旧剧本文案逐字保留，现有 3 条 E2E 不改即绿。
5. **多轮记忆**：`threadId` + checkpointer（先用 `MemorySaver`）+ 摘要中间件（A-P1-2）。
6. **Python 侧只修不迁**：任务重启僵尸（A-P0-2，含 `tasks.py:68` 的 bug）独立修复。旧 `agent.py`/`llm.py` 在对等验证通过后删除。

| # | 现状问题（05 评审编号） | 证据 | 重构后 | 工作包 |
|---|---|---|---|---|
| A-P0-1 | 证据按场景静态注入，模型引不引都会挂上去 | `llm.py:99` `SCENE_EVIDENCE`、`:160` 丢弃模型的 refs | 工具因果校验：只认本轮检索结果 | WP1 |
| A-P1-1 | 上游异常不发 `error` 事件；空 `choices` 直接 IndexError；`replyId=模型名` | `llm.py:235`、`:243`、`:248` | 翻译层统一 `error{code}`，error/done 互斥 | WP2 |
| A-P1-2 | 只发 `[system, user]`，没有多轮 | `llm.py:221` | `threadId` + checkpointer + summarization | WP5 |
| A-P1-3 | mock 与真实是两条路径，E2E 只测 mock | `main.py:56` 二选一 | 同一张图，只换 model | WP3 |
| A-P2-2 | `llm.py` 四种职责混在一起（配置/提示词/传输/围栏解析） | `llm.py` 全文 | `llm.ts`（配置）/`agent.ts`（装配）/`tools.ts`/`translate.ts` | WP1–WP3 |
| A-P2-3 | 围栏解析的 hold-back 状态机脆弱 | `llm.py:137` | 删除：卡片走工具 + custom 流 | WP1/WP2 |
| A-P0-2 | 重启后任务永远停在 running；`:68` 判断写错 | `tasks.py:55-69`、`:115` | 判失败可重试 + 强引用 | WP6 |

## 已经验证过的（不是推测）

- `附录/代码骨架/` 是一套**能跑**的最小实现。`node run-demo.ts` 覆盖了：
  - 3 场景剧本；
  - 同 thread 多轮、跨 thread 隔离；
  - 幻觉证据 → 校验失败 → 自我修正；
  - 死循环模型 → 限额报错；
  - 上游 500 不外泄原始报错；
  - 中止。
  
  所有事件都过了 `AgentStreamEvent.parse` 和序列约束断言。`server.ts` 用 curl 验证过 SSE 帧、证据接口、422。
- `附录/技术验证/` 是 3 个 spike：createAgent 流式与证据校验、中止与异常、ChatOpenAI 对接假的 OpenAI SSE 上游（空 choices、reasoning_content、HTTP 500）。
- 验证中发现、已写进设计的 4 个坑：
  1. 自定义模型必须把 chunk 传给 `handleLLMNewToken`，否则 messages 流拿不到 reasoning 和工具调用增量；
  2. 挂了中间件后每轮约 5 个图步数，默认 `recursionLimit: 25` 会抢在业务限额之前触发；
  3. `toolCallLimitMiddleware` 默认的 `continue` 在一步内所有调用都被拦截时，会**直接结束本轮且没有正文**；
  4. Node 24 strip-only 不支持参数属性和 enum。

## 文档目录

| 文档 | 内容 |
|---|---|
| [00-评审：现状与借鉴什么、不借什么](00-评审-现状与借鉴什么不借什么.md) | 为什么这次要引依赖；用哪些、不用哪些 |
| [01-目标架构](01-目标架构.md) | 进程拓扑、分层、数据流、迁移阶段 |
| [02-接口契约（WP0）](02-接口契约.md) | 事件映射表、工具 schema、HTTP、契约增量，**最先合并** |
| [03-并行开发计划](03-并行开发计划.md) | 依赖图、文件归属矩阵、合并顺序、worktree |
| [04-测试与验收](04-测试与验收.md) | 测试分层、序列约束、对等测试、DoD |
| [05-风险与不确定点](05-风险与不确定点.md) | 置信度、待验证假设、回退方案 |
| ADR草案/ADR-0003~0005 | 引入 langchain.js 与 TS 智能体服务；A2UI 工具化；会话记忆 |
| 工作包/WP0–WP9 | 每包一份：目标、文件、步骤、验收、不要做、**Cursor 提示词** |
| [附录](附录/README.md) | 可运行代码骨架、技术验证脚本与输出 |

## 怎么用

1. **先合并 WP0**：契约增量、ADR、`apps/agent` 空壳与 CI 接线，约半天。
2. **第一批并行**：WP1 工具与数据、WP2 事件翻译层、WP6 Python 任务修复。三者文件不重叠。
3. **第二批**：WP3 Agent 装配与离线剧本（依赖 WP1+WP2）→ WP4 HTTP 层与切流（E2E 绿是切流门槛）。
4. **第三批并行**：WP5 多轮记忆、WP7 真实路径契约测试。
5. **收尾**：WP9 删除 Python 智能体代码、更新文档与 CI。WP8（对话内下单 + 人工确认）可选，排在 WP5 之后。
6. 每个包的合并门槛：`pnpm build && pnpm test:shared && pnpm test:api && pnpm test:agent` 全绿 + 包内新增测试全绿；WP4 起加 `pnpm test:e2e`。
