# WP3 · Agent 装配、真实模型工厂与离线剧本

**目标**：唯一的 `createAgent` 装配点，加上 `ChatOpenAI` 工厂和离线 `ScriptedChatModel`。mock 与真实只差 model 一个参数（修复 A-P1-3）。三场景剧本输出与旧 `agent.py` 逐字一致。

**依赖**：WP1、WP2。**分支**：`refactor/wp3-agent-assembly`。**参考实现**：`附录/代码骨架/agent.ts`、`llm.ts`、`scripted-model.ts`、`scripts.ts`、`run-demo.ts`

## 归属文件

`apps/agent/src/agent.ts`、`llm.ts`、`scripted-model.ts`、`scripts.ts`、`agent.test.ts`、`test/parity.test.ts`

## 步骤

1. 先写 `agent.test.ts` 的 5 个用例（04 §2 WP3），确认红。
2. `scripted-model.ts`：`BaseChatModel` 子类，`policy(messages) → {reasoning?, text?, toolCalls?}`。
   - 每个 chunk 都要 `runManager.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk })`。必须传 chunk，否则 reasoning 和 tool_call_chunks 不会出现在 messages 流（已验证）。
   - reasoning 放 `additional_kwargs.reasoning_content`（与 deepseek 在 ChatOpenAI 下的形态一致）。
   - 正文按 6 字切片；`bindTools()` 返回自身；可选 `delayMs`，供 E2E 节奏和中止测试使用。
   - 不写参数属性。
3. `scripts.ts`：`detectScene` 与 `agent.py` 的关键词一致；`floraPolicy` 按"本轮已成功的工具"决定下一步：search_evidence → search_catalog → present_recommendation → 作答。卡片标题、理由、商品、证据、正文从 `agent.py` 逐字复制。
4. `llm.ts`：provider 表与 `llm.py` 一致 → `new ChatOpenAI({ apiKey, model, configuration:{ baseURL }, streaming:true, streamUsage:true, maxRetries:1, timeout:60000 })`。
5. `agent.ts`：
   - `buildAgent({ model, summaryModel?, checkpointer? })`；系统提示词见骨架；
   - 中间件：`toolCallLimitMiddleware({runLimit:6, exitBehavior:'error'})`、`modelCallLimitMiddleware({runLimit:8, exitBehavior:'error'})`（理由见 01 §4.6）；
   - `runTurn(agent, {message, threadId}, signal)` 调 `agent.stream(..., { configurable:{thread_id}, streamMode:['messages','custom'], signal, recursionLimit:100 })`，交给 `translate`；
   - `agent.stream` 自身抛错（例如 abort 发生在首帧前）也要经 `toError` 产出一个 error 事件。
6. `test/parity.test.ts`：若本机有 `apps/api/.venv`，就启动 FastAPI（无 key）对比 3 场景（04 §4）；没有就 `t.skip`。

## 验收

- `agent.test.ts` 全绿；剧本 3 场景的卡片、证据、正文与 `agent.py` 一致。
- `grep -r "createAgent(" apps/agent/src` 只命中 `agent.ts`。

## 不要做

- 不写 HTTP；不启用摘要（WP5）；不改前端。

## Cursor 提示词

```text
仓库 agent-hub，分支 refactor/wp3-agent-assembly（从已合并 WP1、WP2 的 main 拉）。
目标：apps/agent 中实现唯一的 createAgent 装配点、ChatOpenAI 工厂、离线 ScriptedChatModel 与三场景剧本；离线与真实只差 model 参数。
先读：01-目标架构.md §2–4、02-接口契约.md、工作包/WP3、apps/api/app/agent.py 与 llm.py；参考实现 附录/代码骨架/（agent.ts、llm.ts、scripted-model.ts、scripts.ts、run-demo.ts，已在 langchain 1.5.18 上跑通）。
步骤：
1. 先写 src/agent.test.ts：三场景（"日常自用来点花"/"想给妈妈送生日礼物"/"下周去医院探望朋友"）卡片标题/商品 id/证据 id/正文全文与 agent.py 一致；幻觉证据策略→出现"校验未通过"thought 且最终 done；死循环策略→error{server} 含"步数超出上限"且模型调用≤8 次；上游抛 {status:500}→只有一个 error；首事件后 abort→最后是 error{aborted}。全部过 assertSequence。先确认失败。
2. scripted-model.ts：BaseChatModel 子类，每个 chunk 调 runManager.handleLLMNewToken(text, undefined, undefined, undefined, undefined, { chunk })；reasoning 放 additional_kwargs.reasoning_content；正文 6 字切片；bindTools 返回 this；支持 delayMs 与 signal。
3. scripts.ts：detectScene 与 agent.py 一致；floraPolicy 按本轮已成功工具推进；文案逐字复制 agent.py。
4. llm.ts：provider 表同 llm.py，返回 ChatOpenAI。
5. agent.ts：buildAgent（toolCallLimit runLimit 6 + modelCallLimit runLimit 8，exitBehavior 都用 'error'，原因见 01 §4.6）与 runTurn（streamMode ['messages','custom']、recursionLimit 100、signal），agent.stream 抛错也要转成 error 事件。
6. test/parity.test.ts：有 apps/api/.venv 时对比 FastAPI 离线剧本与 ts 剧本（卡片深度相等、证据 id 相等、正文全文相等），否则 skip。
硬约束：createAgent 只在 agent.ts 出现；不加依赖；Node 24 strip-only；只改归属文件；pnpm test:agent 全绿。
完成后输出：改动文件、测试结果、与骨架实现的差异。
```
