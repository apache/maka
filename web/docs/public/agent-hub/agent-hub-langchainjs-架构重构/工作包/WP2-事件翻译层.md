# WP2 · 事件翻译层（agent stream → AgentStreamEvent）

**目标**：把 createAgent 的 `messages` + `custom` 流翻译成现有五事件协议。在这里做出站 zod 校验、开场白扣留和 error/done 收口。修复 A-P1-1。

**依赖**：WP0（可与 WP1 并行：用录制的 chunk 测试，不依赖工具实现）。**分支**：`refactor/wp2-translate`。**参考实现**：`附录/代码骨架/translate.ts`

## 归属文件

`apps/agent/src/translate.ts`、`translate.test.ts`、`sequence.ts`（S1–S5 断言，供其他测试复用）、`test/fixtures/*.json`（录制的流）

## 步骤

1. `sequence.ts`：导出 `assertSequence(evs)`，实现 02 §2 的 S1–S5。可从骨架 `run-demo.ts` 的 `checkSequence` 移植。
2. 先写 `translate.test.ts` 的 9 个用例（04 §2 WP2），确认红。
   - 输入构造：`AIMessageChunk({ id:'run-1', content, additional_kwargs, tool_call_chunks })`、`ToolMessage({status:'error', ...})`，metadata `{langgraph_node:'model_request'|'tools'}`。
   - 也可以用骨架跑一次真实图，把 `[mode, chunk]` 序列化成 fixture。
3. 实现 `translate(stream, signal)` 与 `toError(err, signal)`，规则以 02 §2、§5 为准：
   - 同一次模型调用以 `msg.id` 判定（langgraph 对同一 run 的增量使用稳定 id）；
   - `PREAMBLE = 24` 导出为常量，便于 WP7 调整。
4. `toError` 不把上游原始 message 放进事件，只 `console.error`。

## 验收

- 新测试全绿；`translate.ts` 只 import `@langchain/core/messages`（类型判断）、`zod`、`@agent-hub/shared`。
- 所有用例的输出都通过 `assertSequence`。

## 不要做

- 不调用模型；不改事件契约；不把工具参数透传到 thought 文案。

## Cursor 提示词

```text
仓库 agent-hub，分支 refactor/wp2-translate（从已合并 WP0 的 main 拉）。
目标：实现 apps/agent/src/translate.ts：把 createAgent 的 stream（streamMode ['messages','custom'] 的 [mode, chunk] 序列）翻译为 @agent-hub/shared 的 AgentStreamEvent。
先读：02-接口契约.md §2（映射表与 S1–S5）、§5（错误码）、01-目标架构.md §4.3–4.4、工作包/WP2；参考实现 附录/代码骨架/translate.ts、run-demo.ts 的 checkSequence。
步骤：
1. 新建 src/sequence.ts 导出 assertSequence(evs)（S1 done/error 恰好一次且在最后；S2 thought.seq 单调不减、final 后无 thought；S3 首个 card/token 前有 final thought；S4 卡片引用的证据都下发；S5 每个事件 AgentStreamEvent.parse）。
2. 先写 src/translate.test.ts，用手工构造的 AIMessageChunk/ToolMessage + metadata 作为输入（async generator），覆盖：reasoning 同调用追加/新调用新段；开场白+tool_call_chunk 进 thought 不出 token；30 字正文无工具调用→final thought 后 token 且全文无损；ToolMessage status=error→"校验未通过"thought；非 model_request 节点忽略；custom card 不合契约→error{protocol} 且无 done；抛 {status:500}→error{server} 且不含原始文本；signal 已 abort→error{aborted}。每个用例都过 assertSequence。先确认失败。
3. 实现 translate(stream, signal) 与 toError(err, signal)；同一模型调用用 msg.id 判定；PREAMBLE=24 导出。
硬约束：translate.ts 不 import langchain 运行时（只用 @langchain/core/messages 的 isInstance）；前端协议不变；只改归属文件；pnpm test:agent 全绿。
完成后输出：改动文件、测试结果、映射表中你认为有歧义的地方。
```
