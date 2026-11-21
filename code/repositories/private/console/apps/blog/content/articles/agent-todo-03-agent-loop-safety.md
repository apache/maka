---
slug: agent-todo-03-agent-loop-safety
title: "03 · Agent 回路：工具调用、写确认与安全设计"
series: "Agent Todo 设计笔记"
source: agent-todo
date: 2026-08-15
excerpt: "Agent（智能体）= 大模型 + 一双可以真实干活的手；模型负责决定「调用什么工具、给什么参数」，后端代码负责真正执行并把关——两者一圈圈转起来，就是 Age"
---

# 03 · Agent 回路：工具调用、写确认与安全设计

> 前置：读過 02 的链路图。本篇是全系列的核心——「智能体」三个字到底由哪些齿轮构成。
> 精读对象：`apps/server/src/agent/` 四个文件（合计约 400 行，值得逐行）。

## 一句话定义

Agent（智能体）= 大模型 + 一双可以真实干活的手；模型负责决定「调用什么工具、给什么参数」，后端代码负责真正执行并把关——两者一圈圈转起来，就是 Agent 回路。

## 核心要素一：模型如何「说」它要调工具

先破除一个最普遍的错觉：**模型从来不能直接碰你的数据库。** OpenAI 兼容协议的 tool calling 是这样的：

1. 后端在请求里声明工具清单（名字、描述、参数 schema）——见 `apps/server/src/agent/llm.ts` 里的 function 定义
2. 模型如果决定用工具，返回的不是普通文本，而是一段结构化输出：`我要调 todo_create，参数 {...}`
3. **真正执行的是你的后端代码**，执行结果以 `role: 'tool'` 消息塞回对话，再问模型下一轮

类比：模型像一位坐在玻璃后面的顾问，它只能隔着玻璃递纸条说「请帮我按计算器，算式是 1+2」；按下等号、拿到 7 的，永远是你的程序。玻璃就是安全边界。LLM 行业有一句行话「模型输出不可信是工程前提」——模型可能幻觉出不存在的工具、非法的参数，所以本项目每个工具的 args 在执行前都要再过一次 Zod（`apps/server/src/agent/tools.ts` 的 `executeTool`，每个 case 第一行都是 `parse`）。

**双重校验的位置差异**要注意：路由入口的 `parseBody` 防的是「外部用户」，工具入口的 `TodoCreateArgsSchema.parse` 防的是「模型」。两道门都不能省。

## 核心要素二：读直执、写过门禁

读工具与写工具在 `tools.ts` 顶部的 `NEEDS_APPROVAL` 表里分成两类：

```ts
const NEEDS_APPROVAL = {
  todo_list:       false,  // 读：直接执行
  todo_create:     true,   // 写：必须先过用户确认
  todo_update:     true,
  todo_delete:     true,
  todo_clear_done: true,   // 一张确认卡批量软删已完成
}
```

这是设计期定下的「写前确认」铁律。类比银行柜员：查余额（读）柜员直接办；转账（写）必须你在回单上签字。权限表用声明式对象而非 if-else 散落各处——将来加工具，改一行表即可。

## 核心要素三：确认回路——SSE 长连接怎么「挂起」等人

这是全项目最精巧的一段（`apps/server/src/routes/chat.ts` 工具段 + `apps/server/src/agent/approvals.ts`，两文件对照精读）：

```
服务端 agent loop                          前端
─────────────────────                    ──────────
send({type:'tool_confirm', ...})  ───→   弹确认卡片（批准/拒绝）
outcome = await approvals.wait(           （此时 SSE 连接挂着，
              messageId, toolCallId)        不发任何字节，也不超时）
        ↓ 挂起中……
                                           用户点「批准」
                              ←── POST /api/chat/:id/confirm
approvals.resolve(id, callId, true)
        ↓ wait() 的 Promise 兑现
executeTool(...) 真正执行
send({type:'tool_result', ...})  ───→    卡片显示结果
push 工具结果 → 回到模型下一轮
```

`ApprovalRegistry`（`approvals.ts`，60 行）实现要点：

- `wait()` 返回一个**永不 reject 的 Promise**，把 resolve 函数存进 Map，key 是 `messageId:toolCallId`
- `resolve()` 由 confirm 端点调用：从 Map 取出并兑现——这就是「一个 Promise 的 resolve 被另一个 HTTP 请求触发」的模式，JS 异步的经典用法
- **120 秒超时**：`setTimeout` 到点自动兑现 `{approved:false, status:'timeout'}`，走与拒绝相同的分支。关键决策是**超时不报错**——结果作为 tool 消息回给模型（「等待确认超时，操作未执行」），模型会自然地向用户解释。类比客服电话：你离开十分钟，客服不会把系统搞崩，而是留一句「稍后再联系您」继续服务下一位
- `cancelAll()`：断线时把该消息所有挂起确认立即兑现为 rejected，防止 Promise 泄漏

**为什么独立 confirm 端点而非「在 SSE 流里回包」**：SSE 是单向的（服务端→前端），前端没法往一条进行中的流里写数据。所以确认走第二个普通 HTTP 请求，用 messageId+toolCallId 对上号。这是流式 Agent 系统的标准解法。

## 安全设计全清单

把散在各文件的安全决策集中盘点（每条都能落到具体代码）：

| # | 措施 | 位置 | 防什么 |
| --- | --- | --- | --- |
| 1 | 写操作用户确认门禁 | `tools.ts` NEEDS_APPROVAL + approvals.ts | 模型幻觉指令直接改库 |
| 2 | 工具参数二次 Zod 校验 | `tools.ts` executeTool | 模型输出非法参数 |
| 3 | API 入口 Zod 校验 + 统一错误信封 | `lib/http.ts` | 外部恶意/畸形请求 |
| 4 | 数据库 CHECK 约束 | `migrations.ts` | 绕过应用层的脏数据 |
| 5 | 外键约束显式开启 | `database.ts` PRAGMA | 孤儿消息行 |
| 6 | 软删而非物理删 | `repo-todos.ts` | 误删不可恢复 |
| 7 | API key 只存服务端 `.env`，前端零密钥 | `index.ts` loadDotEnv + EnvSchema | 密钥进前端 bundle 被扒 |
| 8 | 环境变量启动期校验 | `contracts/env.ts` | 缺 key 时带病运行到半夜才炸 |
| 9 | 依赖构建脚本白名单 | `pnpm-workspace.yaml` allowBuilds | 供应链投毒（npm 包 install 钩子执行任意代码） |
| 10 | 请求体上限 1MB | `app.ts` bodyLimit | 超大 body 打爆内存 |
| 11 | 工具轮数上限 5 | `chat.ts` MAX_TOOL_ROUNDS | 模型无限循环烧 token |
| 12 | 监听 127.0.0.1 而非 0.0.0.0 | `index.ts` listen | 局域网意外暴露 |

第 9 条值得展开：pnpm 默认拒绝执行依赖的构建脚本（如 esbuild 的 postinstall），本项目只在 `allowBuilds` 里放行 esbuild 一个。类比小区门禁——快递员（依赖包）想进门施工（跑脚本），物业（你）只放行登记过的那家。Node 生态近年多起供应链攻击都走 install 脚本这条路，这是零成本高收益的防线。

第 12 条与 CORS（`app.ts` 里 `origin: true` 放开）表面矛盾，实际分层：CORS 管浏览器内跨源读，监听地址管网络可达。本机工具放开 CORS 无害；若将来部署公网，需要收紧 CORS 白名单 + 加鉴权，那时第 7、12 条要整体重审。

## 常见误解纠偏

**误解：「流式输出 = 模型边想边给最终答案。」**

流式切分和「答案正确性」无关，模型内部该怎么算还是怎么算；流式改变的只是**传输形态**——完整回答被切成上百个小 chunk，网络上一段一段到，前端一段一段画。用户体感「秒回」，实际总生成时间没变。理解这点你就明白为什么断线时已到的部分是可用的、没到的部分永远丢了（所以有第四篇要讲的 abort 落库）。

## 行业对比：确认回路的三个流派

| 流派 | 思路 | 代表 |
| --- | --- | --- |
| 前置确认（本项目） | 写操作先问人 | Claude Code 的权限模式、GitHub Copilot Workspace |
| 沙箱执行 | 随便干，但在隔离环境里干，事后可回滚 | 代码解释器、agent 沙箱 |
| 事后审计 | 直接执行，靠日志追溯 | 低风险内部工具 |

选择依据是**误操作代价 × 频率**：todo 删除代价中等、频率低，前置确认体验最好；若做的是「批量重命名 10 万行代码」的高频操作，前置确认会烦死人，就该上沙箱。

## 本篇精读清单

| 文件 | 看什么 |
| --- | --- |
| `apps/server/src/agent/llm.ts` | 工具的 OpenAI function 定义、消息格式转换、signal 透传 |
| `apps/server/src/agent/tools.ts` | NEEDS_APPROVAL、executeTool 的双重校验 |
| `apps/server/src/agent/approvals.ts` | wait/resolve/cancelAll 三方法（60 行读懂挂起模式） |
| `apps/server/src/routes/chat.ts` 工具段 | 事件时序与 ApprovalRegistry 的配合 |

## 动手练习

`todo_clear_done` 已按四站落地：① `contracts/tools.ts` 空对象 schema → ② `llm.ts` function 定义 → ③ `tools.ts` 实现 + `NEEDS_APPROVAL` 登记 → ④ 回路测试（一张 `tool_confirm`，多条 done 软删）。人设与快捷键见 [05-人设模板与快捷键.md](./05-人设模板与快捷键.md)。

## 下一篇

最后一篇集中过性能点位与容错矩阵——这套系统哪里快、哪里省、哪里容易死、死了怎么活，以及给你一张按自己阅读原则定制的全项目阅读地图。
