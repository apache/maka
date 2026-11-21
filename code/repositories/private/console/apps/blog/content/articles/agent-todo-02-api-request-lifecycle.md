---
slug: agent-todo-02-api-request-lifecycle
title: "02 · 接口设计与一次请求的完整链路"
series: "Agent Todo 设计笔记"
source: agent-todo
date: 2026-08-15
excerpt: "这个系统对外只有两组接口：一组普通的 REST（管 todo 和会话历史），一组特殊的 SSE 流（管智能体对话）——REST 是「问一句答一句」，SSE 是「"
---

# 02 · 接口设计与一次请求的完整链路

> 前置：读過 01（三张表 + 迁移）。本篇把视角从「存」切到「传」。
> 精读对象：`apps/server/src/routes/` 三个文件 + `packages/contracts/src/sse.ts`。

## 一句话定义

这个系统对外只有两组接口：一组普通的 REST（管 todo 和会话历史），一组特殊的 SSE 流（管智能体对话）——REST 是「问一句答一句」，SSE 是「水龙头开了持续放水」。

## REST 面：五个约定

以 `apps/server/src/routes/todos.ts` 为例（约 80 行，精读）：

| 路由 | 方法 | 语义 |
| --- | --- | --- |
| `/api/todos` | GET | 列表（软删过滤，id 倒序） |
| `/api/todos` | POST | 新建 |
| `/api/todos/:id` | GET | 单条，不存在 404 |
| `/api/todos/:id` | PATCH | 部分更新（至少一个字段） |
| `/api/todos/:id` | DELETE | 软删，成功 204 无-body |

五个贯穿性约定，每一个都有工程理由：

1. **入参必过 Zod**。所有 body 经 `parseBody(schema, req.body)`（`apps/server/src/lib/http.ts`），失败统一抛 `ApiError(400, 'VALIDATION_ERROR', ...)`。注意校验不写在路由函数里而收在 `parseBody` 一处——校验是横切关注点，集中才有单一出口。
2. **错误是统一信封**。任何非 2xx 响应都是 `{ code, message, details? }` 形态（`contracts/error.ts`）。类比快递面单：不管里面装的什么货，面单格式全国统一，前端解析逻辑只写一遍。错误码是枚举（`VALIDATION_ERROR / NOT_FOUND / DB_ERROR / LLM_ERROR / CONFIRM_MISMATCH / INTERNAL_ERROR`），前端靠 code 分支而不靠解析中文 message。
3. **PATCH 而非 PUT**。PATCH 语义是「给一部分字段」，与 `UpdateTodoInputSchema` 的 `refine(至少一个字段)` 呼应；PUT 语义是「整体替换」，会逼前端每次发全量。
4. **删除返回 204**。成功且无内容，标准做法；失败才回错误信封。
5. **404 有两道**。路由不匹配走 Fastify 的 `setNotFoundHandler`（`apps/server/src/app.ts`）；id 不存在走业务抛 `ApiError`。两者最终都落进同一个错误信封。

## SSE 面：为什么不用 EventSource、不用 WebSocket

需求是：**POST** 发消息（请求体有 conversationId 和 message），然后**流式**收模型输出。

三个候选方案的取舍：

| 方案 | 为什么不行/行 |
| --- | --- |
| 轮询 | 每 N 秒问一次「生成到哪了」：延迟高、空请求多、服务端还得存中间态 |
| WebSocket | 双向长连接，但这里只有「服务端→前端」一个方向的数据流，杀鸡用牛刀，且要维护升级/心跳/断连重连协议 |
| **SSE（POST + ReadableStream）** | 本质还是一个 HTTP 响应，只是不一次性发完，逐帧写。**选中** |

浏览器原生 `EventSource` 只支持 GET，发不了请求体，所以本项目手写：`fetch(POST)` 拿到 `res.body` 这个 `ReadableStream`，用 reader 逐块读。前端解析器在 `apps/web/src/chat/sse.ts`（20 行核心逻辑，值得一读）：按 `\n\n` 切帧、取 `data: ` 行、`JSON.parse` 后立即 `SseEventSchema.parse` 校验。

### 六类事件：协议即状态机

契约在 `packages/contracts/src/sse.ts`（discriminatedUnion，精读）。每类事件对应前端一种渲染状态：

| 事件 | 载荷 | 前端动作 |
| --- | --- | --- |
| `meta` | conversationId, userMessageId, model | 记住会话 id（刷新后可续） |
| `delta` | text | 追加到气泡，光标闪烁（partial 态） |
| `tool_confirm` | messageId, toolCallId, action, args | 弹确认卡片，流挂起等用户 |
| `tool_result` | toolCallId, approved, status, summary | 卡片显示结果，流继续 |
| `done` | messageId, usage | 定稿气泡（done 态） |
| `error` | code, message | 红色错误（error 态） |

**协议设计的一处返工教训**：初稿里 `meta` 事件带 `messageId`、`tool_confirm` 不带——实现时发现 assistant 消息要到第一轮流结束落库后才存在 id，`meta` 根本发不出；而 confirm 独立端点又必须靠 `messageId + toolCallId` 定位挂起请求。于是契约改为：`meta` 去掉 messageId，`tool_confirm` 加上。**教训：契约在实现前只是假说，跑不通就改图纸，别硬拗代码迁就过时的图纸。**

## 一次 chat 请求的完整链路

`apps/server/src/routes/chat.ts` 是全项目最重要的一个文件（约 300 行，本系列最值得精读）。以「帮我记一条：明天买牛奶」为例，逐跳走：

```
前端 fetch POST /api/chat
  │
  ├─ ② ChatRequestSchema 校验 body（conversationId? + message）
  ├─ ② 会话定位：带 id 则验证存在，不带则 createConversation（标题=消息前 20 字）
  ├─ ② user 消息落库 → 拿到 userMessage.id
  │
  ├─ SSE 通道接管：reply.hijack() + 手写 200/SSE 头
  │    （从这刻起 Fastify 不再管响应，写什么、何时结束全是我们的代码）
  │    注册 raw.on('close')：断线时 abort 上游 + 清理挂起确认
  │
  ├─ ③ buildSystemPrompt()：listTodos() → 格式化为「#id [status] 标题...」清单
  │    注入最多 50 条（CONTEXT_LIMIT，超出明确告知模型已截断）
  ├─ ④ toChatMessages(recentMessages(conv, 40))：历史窗口 40 条
  │    + system prompt = 最终模型输入
  │
  ├─ ⑤ for(;;) 循环（每轮）：
  │    streamChat() 流式调 DeepSeek
  │      ├─ chunk.text   → send({type:'delta'})  ⑥ 实时转发
  │      ├─ chunk.toolCalls 分片 → 按 index 累积（id/name/argsStr 拼装）
  │      └─ 轮尾：assistant 消息 + rawJson 落库
  │    ├─ 无工具调用 → send({type:'done'})，结束
  │    └─ 有工具调用 → 进入第三篇的确认回路（tool_confirm / 等待 / tool_result）
  │       然后把工具结果 push 进 messages，round++，回到 ⑤ 再问模型
  │
  └─ finally：touchConversation + raw.end()
```

四个容易看漏的细节：

1. **`hijack()` 是分水岭**。调用之前是 Fastify 的世界（自动序列化、错误处理），之后 raw socket 归我们：SSE 头自己写、每帧自己 `raw.write()`、结束自己 `raw.end()`。错误处理也从「抛 ApiError 自动变信封」变成「catch 里手动 send error 事件」。
2. **流式转发是即时的**。`delta` 在 for await 循环体内逐 chunk 发出，不是攒完一整轮再发——这就是「流式」的全部秘密，没有黑魔法。
3. **工具参数是流式分片拼出来的**。模型说「我要调 todo_create」时，参数 JSON 也是一小段一小段到的（`{"tit` + `le":"买牛奶"}`），`toolAcc` Map 按 `index` 累积、轮尾 `JSON.parse`。解析失败不崩，落成 `{__invalidArgs: 原文}` 回给模型自己看。
4. **`MAX_TOOL_ROUNDS = 5`**。超过 5 轮就不再给模型提供工具定义，逼它文本收尾。这是防失控护栏：模型若无限循环「调工具→看结果→再调」，最多烧 5 轮。

## 常见误解纠偏

**误解：「SSE 是一种特殊协议，需要专门的库和服务器。」**

SSE 就是一个普通的 HTTP 响应，`content-type: text/event-stream`，body 里按 `event: x\ndata: {...}\n\n` 格式逐帧写。Fastify 里 10 行手写完毕（`encodeSseEvent` 在 `contracts/sse.ts`，总共 5 行）。任何 HTTP 框架都能做，难的不是发，而是「发完之后连接生命周期管理」——这才是 `hijack` + `close` 监听 + `finally` 这些代码存在的原因。

## 行业对比

- **SSE vs WebSocket 的行业现状**：OpenAI、Anthropic 的官方流式 API 都是 SSE；ChatGPT 网页端也走 SSE。需要「前端→服务端」高频推送（协同编辑、游戏）才用 WebSocket。方向单一的数据流，SSE 是行业默认。
- **错误信封 vs RFC 7807 Problem Details**：本项目信封是 Problem Details 思想的简化版。真实多团队环境可直接上 `application/problem+json` 标准，前端生态有现成解析器。

## 本篇精读清单

| 文件 | 看什么 |
| --- | --- |
| `apps/server/src/routes/chat.ts` | 全链路（配合上面的逐跳图读） |
| `packages/contracts/src/sse.ts` | 六事件契约 + encodeSseEvent |
| `apps/server/src/lib/http.ts` | parseBody / serializeError 集中化 |
| `apps/server/src/agent/prompt.ts` | 数据如何变成模型可读文本 |
| `apps/web/src/chat/sse.ts`（略读） | 与服务端对称的流解析 |

## 动手练习

给 `GET /api/todos` 加 `?status=todo|doing|done` 过滤参数。完整走一遍契约流程：`contracts/todo.ts` 定义 query schema → 路由解析 query → repo 层过滤。体会「一个需求从图纸到落地经过哪几站」。

## 下一篇

链路图里留下了一个悬念：`tool_confirm / 等待 / tool_result` 那三行。第三篇进入 Agent 的心脏——模型怎么「说」要调工具、写操作怎么挂起等你批准、以及这套系统的安全设计全清单。
