---
slug: agent-todo-01-system-overview
title: "01 · 系统全景与数据底座"
series: "Agent Todo 设计笔记"
source: agent-todo
date: 2026-08-15
excerpt: "这是一个「待办清单 + 智能体」的单机全栈应用：左边是你手动管理的 todo，右边是一个能替你增删改查 todo 的 AI 对话面板，所有数据存在一个 SQLi"
---

# 01 · 系统全景与数据底座

> 系列定位：这个项目是 AI 全程编写的，本系列带你用「人脑」把它重新走一遍。
> 你的阅读原则已内置于每篇：**精读**接口/表/性能/安全/链路，**略读** UI，**跳过**测试与样式。

## 一句话定义

这是一个「待办清单 + 智能体」的单机全栈应用：左边是你手动管理的 todo，右边是一个能替你增删改查 todo 的 AI 对话面板，所有数据存在一个 SQLite 文件里。

核心只有一条业务主线，即设计时定下的七步流水线：

```
① 前端提交上下文/意图
② 后端校验参数、权限、上下文
③ 后端查询业务数据（把 todo 清单注入给模型）
④ 后端整理成模型可用输入
⑤ 后端调用大模型（流式）
⑥ 流式输出给前端
⑦ 前端增量渲染（loading → partial → done / error）
```

后面三篇讲的所有代码，都是在为这七步服务的。看到任何文件先问一句：它属于第几步？

## 三个包的分工：contracts 是图纸

```
packages/contracts/   契约包：所有 Zod schema（实体、错误、SSE 事件、env、工具参数）
apps/server/          服务端：Fastify + node:sqlite + DeepSeek 客户端
apps/web/             前端：React + Vite（你只需略读）
```

**类比**：contracts 是一张零件图纸，前后端各拿同一张开工。图纸改了，两边编译期就报错，而不是等联调时才发现字段对不上。这是 monorepo 最大的单点收益——传统前后端分离项目里「字段漂移」是日常事故，这里被 TypeScript + Zod 压缩为零。

一个具体例子：SSE 事件的前后端共用校验。

- 服务端产出事件：`apps/server/src/routes/chat.ts` 里的 `send()`
- 契约定义形状：`packages/contracts/src/sse.ts` 的 `SseEventSchema`
- 前端消费时校验：`apps/web/src/chat/sse.ts` 每帧都过一次 `SseEventSchema.parse(...)`

服务端发错字段，或前端读错字段，任何一端漂移都会在解析瞬间抛错。

## 表设计：三张业务表 + 一张迁移账本

全文见 `apps/server/src/db/migrations.ts`（精读，共 73 行）。

### todos：业务主表

```sql
CREATE TABLE todos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL CHECK (status IN ('todo','doing','done')) DEFAULT 'todo',
  priority     TEXT CHECK (priority IN ('low','medium','high')),
  due_date     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  completed_at TEXT,      -- 语义列：进 done 打时间戳，离开清空
  deleted_at   TEXT       -- 软删标记：非空即不可见
);
CREATE INDEX idx_todos_status ON todos(status) WHERE deleted_at IS NULL;
```

四个设计决策，每个都有理由：

1. **枚举用 `CHECK` 约束而非应用层校验**。数据库是最后一道门：就算某天某个 bug 绕过了 Zod，脏数据也写不进去。注意 API 出参是驼峰（`dueDate`），入库是下划线（`due_date`），转换集中在 `repo-todos.ts` 的 `toEntity()` 一处，不散落。
2. **软删（`deleted_at`）而非真删**。类比回收站：用户「删除」只是贴上时间戳，查询永远带 `WHERE deleted_at IS NULL`。这是数据安全网——智能体误删一条，数据还在，可手工恢复。真正的物理清理留给未来的运维脚本。
3. **`completed_at` 独立于 `status`**。只存「是否完成」会丢失「何时完成」；两者都存，报表和排序才有原料。打戳逻辑在 `repo-todos.ts` 的 `updateTodo()`：进 done 时 `current.completedAt ?? now`（停在 done 改标题不打新戳），离开 done 清空。
4. **部分索引** `WHERE deleted_at IS NULL`。类比「只给在售商品印目录页」：已删除的行不进索引，索引更小、写入维护更便宜，而所有业务查询恰好都只查未删数据。这是 SQLite（以及 PG）都支持的高级特性，本项目唯一一处索引就用了它。

### conversations 与 messages：会话与事件日志

```sql
CREATE TABLE conversations ( id, title, created_at, updated_at );
CREATE TABLE messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id),
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system','tool')),
  content         TEXT NOT NULL DEFAULT '',
  raw_json        TEXT,        -- 事件溯源载荷
  created_at      TEXT NOT NULL
);
CREATE INDEX idx_messages_conversation ON messages(conversation_id);
```

关键在 `messages.raw_json` 这一列。它存的是「这条消息产生时的完整上下文」：

- assistant 消息 → `{ model, usage, finishReason, toolCalls }`（模型名、token 用量、结束原因、工具调用）
- tool 消息 → `{ toolCallId, approved, status, action, result }`（确认结果、执行结果）

**类比银行流水**：余额（todo 表）可以随时重算，但流水（messages 表）记录了每一笔怎么来的。这就是「事件溯源」——设计铁律之一是「模型所见必可从日志重建」：任何时候模型读过什么、说过什么、调过什么工具、用户批没批，全部可以从 `messages` 表完整回放。审计、debug、换模型重跑，都靠这一列。

`idx_messages_conversation` 的原因：messages 表唯一的访问模式是「按会话取最近 N 条」（见下一篇的 40 条窗口），索引恰好服务它。

### schema_migrations：迁移账本

`migrate()` 的逻辑（`migrations.ts:47-73`）：

1. 建一张 `schema_migrations(version, applied_at)` 账本表
2. 读出已应用版本集合
3. 逐个执行未应用的迁移，每个包在 `BEGIN ... COMMIT` 事务里，失败 `ROLLBACK`

**类比装修施工日志**：每完成一步登记一笔，工程中断后重开，从日志断点继续，而不是从头砸墙。两条铁律：**迁移只追加、不修改**（已发布的 v1 是历史，改需求就写 v2）；**每个迁移必须可整体成功或整体失败**（事务保证不会出现「表建了一半」）。

数据库打开时还有三个 PRAGMA（`apps/server/src/db/database.ts`）：`journal_mode = WAL`（写不阻塞读，第四篇细讲）、`foreign_keys = ON`（SQLite 默认关外键，必须显式开）、以及首次运行自动建 `data/` 目录。

## 常见误解纠偏

**误解：「AI 应用就是无状态聊天，不需要认真设计数据库。」**

恰恰相反。这个项目里 SQLite 承担**双职能**：一是业务数据（todos），二是 AI 的记忆与审计（messages 事件日志）。智能体每次对话都要「带着你的清单现状」去见模型（七步流水线的第③步），数据层设计直接决定 AI 的回答质量。AI 应用工程师的一天，有相当比例是在和数据结构打交道。

## 本篇精读清单

| 文件 | 行数 | 看什么 |
| --- | --- | --- |
| `apps/server/src/db/migrations.ts` | 73 | 三表 DDL、CHECK、部分索引、事务迁移 |
| `apps/server/src/db/repo-todos.ts` | 114 | snake↔camel 转换、completed_at 打戳、软删 |
| `apps/server/src/db/repo-conversations.ts` | 114 | messages 落库、recentMessages 倒序窗口 |
| `packages/contracts/src/todo.ts` | 41 | 实体契约与库表的一一对应 |

## 动手练习

给 todos 加一个 `created_by` 列（区分手动创建 / 智能体创建）。要求：写迁移 v2（`ALTER TABLE todos ADD COLUMN created_by TEXT`）、更新 `repo-todos.ts` 的读写、在 `contracts/todo.ts` 补字段。三处都动，体会「图纸改了两侧跟着改」的流程。

## 下一篇

表是死的，请求是活的。第二篇走接口设计与一次 chat 请求的完整链路——从 `POST /api/chat` 进来到 SSE 流结束，中间每一跳发生了什么。
