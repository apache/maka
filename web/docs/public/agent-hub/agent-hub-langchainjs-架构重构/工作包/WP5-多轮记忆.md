# WP5 · 多轮记忆（threadId + MemorySaver + 摘要）

**目标**：同一对话里能追问，例如"送礼"→"预算再低一点"。新对话互不可见。长对话自动摘要。修复 A-P1-2。

**依赖**：WP4。**分支**：`refactor/wp5-memory`

## 归属文件

- `apps/web/src/services/agent.ts`、`apps/web/src/stores/chat.ts`
- `e2e/agent-hub.spec.ts`（只追加 1 条）
- `apps/agent/src/memory.test.ts`
- 接线：`agent.ts`（summaryModel）、`server.ts`（threadId 透传、LRU）

## 步骤

1. 先写 `memory.test.ts`（04 §2 WP5 的 1–3、5），确认红。
2. 前端：
   - `streamAgentChat(message, signal, threadId?)`，新参数放末尾，请求体带 threadId；
   - store 增加 `threadId: string | null`；`sendMessage` 时若为空就 `crypto.randomUUID()`；`reset()` 置空。
3. 服务端：
   - 透传 `threadId`；
   - 维护最近使用的 thread 列表，超过 `AGENT_MAX_THREADS`（默认 1000）时调 `checkpointer.deleteThread(oldest)`（MemorySaver 已实现该方法）。
4. 摘要：
   - `AGENT_SUMMARY_MODEL` 存在时，`createChatModel({ ...env, OPENAI_MODEL: AGENT_SUMMARY_MODEL })` 作为 `summaryModel`；
   - `summarizationMiddleware({ model, trigger:{tokens:6000}, keep:{messages:12} })`；
   - 离线模式不启用。验证 05 U5：摘要调用不出现在出站事件里。
5. 剧本：`floraPolicy` 对第二轮"预算再低一点"之类追问的处理——用 `search_catalog({maxPriceFen})` 再出一张卡。可选；如果做，要在 E2E 新增用例里断言。
6. E2E 追加：同一页面连续发两条，第二条请求体的 threadId 与第一条相同；点"清空"后 threadId 变化（`page.waitForRequest` 读 postData）。
7. 验证 05 U2：用 deepseek-reasoner 连续两轮。若 400，就加剥离 reasoning_content 的中间件（写进 PR）。

## 验收

- `pnpm test:agent`、`pnpm test:e2e` 全绿（原 3 条 + 新 1 条）。
- 不带 threadId 的请求行为与 WP4 一致。

## 不要做

- 不持久化记忆到磁盘；不把 threadId 写入 localStorage；不放宽"本轮"证据校验。

## Cursor 提示词

```text
仓库 agent-hub，分支 refactor/wp5-memory（从已合并 WP4 的 main 拉）。
目标：多轮记忆。前端生成并携带 threadId，服务端 MemorySaver 按 thread 存储，可选摘要中间件。
先读：ADR-0005、02-接口契约.md §1 §7、工作包/WP5、apps/web/src/stores/chat.ts、services/agent.ts。
步骤：
1. 先写 apps/agent/src/memory.test.ts：同 threadId 两轮，第二轮模型收到的消息含第一轮 HumanMessage（用记录入参的 ScriptedChatModel 策略断言）；不同 threadId 互不可见；不带 threadId 两次互不可见；配置摘要模型（fakeModel）且历史超阈值时，主模型收到的消息条数下降。先确认失败。
2. 前端：streamAgentChat(message, signal, threadId?) 新参数放末尾；chat store 增加 threadId，首次发送 crypto.randomUUID()，reset() 清空。不写 localStorage。
3. server.ts 透传 threadId；最近使用 thread 超过 AGENT_MAX_THREADS（默认 1000）时 checkpointer.deleteThread(最旧)。
4. agent.ts：AGENT_SUMMARY_MODEL 存在时挂 summarizationMiddleware({ model, trigger:{tokens:6000}, keep:{messages:12} })，离线模式不挂；确认摘要调用不产生出站事件。
5. e2e 只追加 1 条：连续两次发送请求体 threadId 相同；点"清空"后不同。
硬约束：AgentStreamEvent 不改；present_recommendation 仍按"本轮"校验；不加依赖；只改归属文件；DoD 全绿（含 e2e）。
完成后输出：改动文件、测试结果、deepseek-reasoner 多轮验证结论（若有 key）。
```
