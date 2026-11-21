---
slug: agent-todo-05-persona-shortcuts
title: "05 · 人设模板与快捷键备忘"
series: "Agent Todo 设计笔记"
source: agent-todo
date: 2026-08-15
excerpt: "把对应段落替换 apps/server/src/agent/prompt.ts 里「你是嵌在一个 todo 清单应用里的智能体助手。」那一段即可。行为规则（写操"
---

# 05 · 人设模板与快捷键备忘

> 本周只落确认卡手感、截止日期窗口、一键清理已完成。三种人设写死为可粘贴的 system prompt，**不接运行时切换**。
> 交互纯函数在 `@agent-todo/contracts`（`formatConfirmSummary` / `exportConversation*` / `interpretChatKey`），Web 只接线。

## 人设模板

把对应段落替换 `apps/server/src/agent/prompt.ts` 里「你是嵌在一个 todo 清单应用里的智能体助手。」那一段即可。行为规则（写操作过确认、逾期用 `dueWindow`、清理走 `todo_clear_done`）三套共用，不要删。

### 规划师

```
你是嵌在 todo 清单里的规划助手。先帮用户看清优先级和截止日期，再建议下一步，不要急着改数据。
用户问「今天做什么 / 有没有逾期」时，调用 todo_list，dueWindow 用 today 或 overdue，不要自己算日期。
只有用户明确要求新增、修改、删除或清理时才调用写工具。回答用中文，先给结论再给条目。
```

### 执行者

```
你是嵌在 todo 清单里的执行助手。用户给出具体指令就立刻调工具落地，少寒暄。
「记一条」「改成已完成」「删掉 3 号」「清理已完成」分别对应 todo_create / todo_update / todo_delete / todo_clear_done。
清理已完成只用 todo_clear_done 一张确认卡，不要逐条 todo_delete。写操作等用户确认后再真正执行。
```

### 复盘

```
你是嵌在 todo 清单里的复盘助手。默认只读：用 todo_list 汇总已完成、未完成和逾期，指出卡住的项。
不要主动新建或删除。只有用户明确说「清掉已完成 / 把某条改状态」时才调用对应写工具。
逾期必须用 dueWindow=overdue，今天到期用 dueWindow=today。
```

本周不实现 `agent_mode` 切换。若以后要接，只换 prompt 前缀，不要改工具协议。

## 快捷键

焦点在智能体面板内时生效。`Ctrl+F` / `Cmd+F` 只打开会话内搜索，不调用浏览器查找。

| 按键 | 条件 | 行为 |
| --- | --- | --- |
| Esc | 有未确认的写操作卡片 | 拒绝该次调用 |
| Esc | 正在流式生成（且不在等确认） | 停止生成，已输出文字保留，不报网络错误 |
| ↑ | 输入框为空 | 回填上一条用户消息 |
| Ctrl/Cmd+F | 面板内 | 打开并聚焦当前会话搜索 |

复制消息：气泡 hover 后点复制，走 `navigator.clipboard.writeText`，没有额外 toast 库。

导出：header 下载当前会话。txt 行格式为 `用户：` / `助手：`；json 为 `{ conversationId, messages }`。导出读当前 `items`，不另打接口。

停止按钮只在 `partial` 且未进入确认等待时出现。等确认时 Esc 走拒绝，不 abort SSE。

## 萃取备忘（确认卡与导出）

做下一批对话产品时，优先搬这三件事，不必依赖仓库里其它聊天套壳。

1. **确认卡给人口语，不甩 JSON。** `formatConfirmSummary` 按工具分支拼句子（新建带标题/优先级/截止日期，修改只说变更，清理是固定一句「清理所有已完成待办」）。卡片标题仍用动作名，正文用摘要。
2. **停止生成与网络失败分开。** `AbortSignal` 传进 SSE；用户 abort 后 phase 回 idle，assistant 保持已生成文字。只有非 abort 的 throw 才进 error。
3. **导出与搜索都是当前会话的纯函数。** `exportConversationText` / `exportConversationJson` / `filterChatItems` / `lastUserText` / `interpretChatKey` 放 contracts，方便单测，UI 不复制逻辑。

截止日期比较同样是纯函数：`matchesDueWindow(todo, 'today' | 'overdue', today)`。测试必须注入日历日（本仓库用 `2099-01-01`），不要依赖墙钟。
