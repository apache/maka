# ADR-0003：引入 langchain.js，新增 TypeScript 智能体服务 apps/agent

- 状态：草案（WP0 合并时改为"已接受"）
- 日期：待定
- 相关：ADR-0001（技术栈与 monorepo）、ADR-0002（Python 依赖）

## 背景

`apps/api/app/llm.py` 是单次 Chat Completions 调用加围栏解析，没有工具、循环、记忆和错误事件（见评审 A-P0-1、A-P1-1、A-P1-2、A-P1-3）。要补齐这些能力，需要实现以下全部：

- 工具调用协议与参数校验；
- 错误回灌、循环与限额；
- 中止、多轮存储与摘要；
- 多路流式。

这些正是 agent 框架提供的能力。

## 决定

1. 新增 workspace 包 `apps/agent`（`@agent-hub/agent`，`type: module`，Node 24 直接运行 `.ts`，无构建步骤），端口 8809。它接管 `/api/agent/chat` 与 `/api/evidence/:id`。
2. 运行时依赖（版本用 `~` 锁小版本）：

   | 包 | 版本 | 用途 |
   |---|---|---|
   | `langchain` | ~1.5.18 | createAgent、tool、中间件、fakeModel |
   | `@langchain/core` | ~1.2.18 | 消息、BaseChatModel |
   | `@langchain/langgraph` | ~1.5.1 | MemorySaver（createAgent 的 peer） |
   | `@langchain/openai` | ~1.6.2 | ChatOpenAI（OpenAI 兼容四家） |
   | `@agent-hub/shared` | workspace:* | 契约 |
   | `zod` | 与 shared 同版本 | 工具 schema |

3. HTTP 用 `node:http`，不引 Web 框架。
4. 不引测试框架：`node --test`。
5. FastAPI 保留任务、订单、支付、场景接口。迁移期以 `AGENT_BACKEND=ts|py` 切换，WP9 删除 Python 智能体代码。

## 备选方案

| 方案 | 不选的原因 |
|---|---|
| Python `langchain` + `langgraph` 留在 FastAPI | 契约要在 pydantic 再镜像一份，出站校验和前端不同源；团队主力栈是 TS |
| 继续手写（扩展 llm.py） | 工作量相当于重写 createAgent 的一个子集，且没有测试资产 |
| LangGraph Server + langgraph-sdk 前端 | 替换掉本项目的核心卖点（自研事件协议与 A2UI） |
| Vercel AI SDK | 也可行；但 langchain.js 的中间件（限额、摘要、HITL）与 checkpointer 正好对应路线图 H1–H6，且团队已在 coding-agent 评审中对它建立了认知 |

## 后果

- 正面：mock 和真实走同一张图；工具因果校验；多轮记忆；错误事件规范化；后续 HITL 下单有现成机制。
- 负面：
  - 多一个进程；
  - node_modules 增加约 30 MB；
  - langchain 小版本可能改变流细节（用录制用例兜底，见 05 U11）；
  - TS 7 / tsgo 对第三方类型可能有兼容问题（`skipLibCheck`，见 05 U4）。
