---
slug: agent-todo-design-decisions
title: "agent-todo 设计定案（2026-08-15）"
series: "Agent Todo 设计笔记"
source: agent-todo
date: 2026-08-15
excerpt: " 2. 数据表结构（3 张业务表 + 1 张版本表）"
---

# agent-todo 设计定案（2026-08-15）

> 本文档是三轮设计面试的共识终稿，开发以本文为准；变更需先改本文再改代码。

## 1. 产品定调

| 项 | 决策 |
|---|---|
| 智能体能力 | 可写 todo + 写前确认（tool calling 完整回路；v1 可先只读行为，schema 不返工） |
| 用户体系 | 单机单用户，无 user_id |
| 学习目标 | 亲手实现七步流水线每一层（校验 → 查数据 → 组装 → 调模型 → 流式 → 增量渲染） |

## 2. 数据表结构（3 张业务表 + 1 张版本表）

```sql
todos
  id            INTEGER PRIMARY KEY AUTOINCREMENT
  title         TEXT NOT NULL
  description   TEXT
  status        TEXT NOT NULL CHECK (status IN ('todo','doing','done'))
  priority      TEXT CHECK (priority IN ('low','medium','high'))
  due_date      TEXT                -- ISO 8601
  created_at    TEXT NOT NULL       -- ISO 8601 UTC
  updated_at    TEXT NOT NULL
  completed_at  TEXT
  deleted_at    TEXT                -- 软删除；查询永远过滤 deleted_at IS NULL

conversations
  id            INTEGER PRIMARY KEY AUTOINCREMENT
  title         TEXT NOT NULL       -- 首条消息截断 20 字
  created_at    TEXT NOT NULL
  updated_at    TEXT NOT NULL

messages
  id                INTEGER PRIMARY KEY AUTOINCREMENT
  conversation_id   INTEGER NOT NULL REFERENCES conversations(id)
  role              TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool'))
  content           TEXT NOT NULL DEFAULT ''
  raw_json          TEXT            -- 事件溯源载荷，见 §5
  created_at        TEXT NOT NULL

schema_migrations
  version       INTEGER PRIMARY KEY
  applied_at    TEXT NOT NULL
```

- DB 文件：`apps/server/data/agent-todo.db`（gitignore），WAL 模式
- `raw_json`：assistant 存 `{ model, usage, finish_reason, tool_calls[] }`；tool 存 `{ tool_call_id, approved, status, result }`

## 3. Contracts 包（Zod v4）

内容 = Todo/会话/消息 schema + 推导 TS 类型 + 统一错误 envelope `{ code, message, details }` + 枚举常量 + SSE 五类事件 schema（前后端共用）+ 环境变量 schema。

## 4. HTTP API（REST，错误统一 envelope）

| 端点 | 用途 |
|---|---|
| `GET /api/todos` | 全量（过滤软删，不分页） |
| `POST /api/todos` | 新增 |
| `PATCH /api/todos/:id` | 修改（状态机自由转移） |
| `DELETE /api/todos/:id` | 软删除 |
| `POST /api/chat` | body `{ conversationId?, message }`；历史后端自查，前端不重放 |
| `POST /api/chat/:messageId/confirm` | body `{ toolCallId, approved }`；写确认回路 |
| `GET /api/conversations` | 会话列表 |
| `GET /api/conversations/:id/messages` | 会话历史 |
| `DELETE /api/conversations/:id` | 硬删除会话及其消息（事务内级联；无软删列，不加迁移） |

## 5. SSE 流式协议（POST + ReadableStream）

> 实现期精化（2026-08-15）：`meta` 去掉尚不存在的 `messageId`（assistant 行在轮尾才插入）；`tool_confirm` 增加所属轮次 `messageId`（confirm 端点定位用）；新增 `tool_result` 事件（前端关闭确认卡片并显示结果）。共六类事件。

| 事件 | 载荷 | 前端四态 |
|---|---|---|
| `meta` | `{ conversationId, userMessageId, model }` | loading |
| `delta` | `{ text }` | partial |
| `tool_confirm` | `{ messageId, toolCallId, action, args }` | 确认卡片，流暂停 |
| `tool_result` | `{ toolCallId, approved, status, summary }` | 卡片转结果 |
| `done` | `{ messageId, usage }` | done |
| `error` | `{ code, message }` | error |

## 6. Agent 回路与边界

- 上下文：后端自查注入最近 50 条未删 todo + 总数统计，超限告知模型截断
- 写确认：SSE 长连接悬挂等待；确认走独立 POST，同一连接续流
- 超时 120s：把 `{ approved:false, status:'timeout' }` 作为 tool 结果回给模型，模型自行文本收尾（不猝死）
- 断线：AbortController 中止上游生成，已生成内容落库
- LLM 错误：v1 不重试，`LLM_ERROR` 事件 + 前端手动重发
- 工具集：`todo_list`（读，直执；可选 `dueWindow: today | overdue`，日期比较用本地日历日，模型不得自行推算逾期）＋ `todo_create` / `todo_update` / `todo_delete` / `todo_clear_done`（写，需确认；`todo_clear_done` 一张确认卡批量软删所有已完成项）

## 7. 工程收尾

- 运行形态：Fastify `@fastify/static` 托管前端 dist，单进程
- 测试三件套：contracts schema 单测 / CRUD+迁移集成测试（`:memory:`）/ agent 回路 LLM-mock 测试（含确认与超时分支）
- 栈：React 19 + Vite + Zustand + TanStack Query + Tailwind v4 / Fastify + Zod v4 + node:sqlite 裸用 / tsx + Vitest + Oxlint / pnpm workspace 三包
- 配置：`DEEPSEEK_API_KEY / DEEPSEEK_MODEL=deepseek-chat / DEEPSEEK_BASE_URL` 走 `.env`（example 入库）
