# WP8（可选）· 对话内下单 + 人工确认（humanInTheLoopMiddleware）

**目标**：用户说"就要第一个"，智能体调用 `create_order`，**执行前**暂停，等待用户在卡片上确认，确认后才调用 FastAPI 下单。价格只信目录（WP1 的前提）。

**依赖**：WP5（需要 threadId 才能恢复）。**分支**：`feat/wp8-hitl-order`。**需要新 ADR-0006**（契约新增事件）。

## 契约增量（ADR-0006 草案要点）

```ts
// 新增事件（AgentStreamEvent 联合追加，旧前端遇到未知 type 会报协议错误 → 必须与前端同 PR 发布）
export const ConfirmEvent = z.object({
  type: z.literal('confirm'),
  interruptId: z.string(),
  action: z.literal('create_order'),
  summary: z.object({ skuId: z.string(), name: z.string(), priceFen: z.number().int(), quantity: z.number().int().min(1) }),
});
// 恢复请求
export const ResumeRequest = z.object({ threadId: z.string(), interruptId: z.string(), decision: z.enum(['approve', 'reject']) });
```

- 中断时的序列：…→ `confirm` → `done`。本轮正常结束，S1 仍成立。
- `POST /api/agent/resume` 返回新的 SSE 流（可能有 token、card），以 done 结束。

## 设计要点

- 工具 `create_order({skuId, quantity})`：从 CATALOG 取价格，调 FastAPI `POST /api/orders`（金额单位为分）。
- `humanInTheLoopMiddleware({ interruptOn: { create_order: { allowedDecisions: ['approve','reject'] } } })`。
- 翻译层：识别 `__interrupt__` 更新。需要在 `streamMode` 里加 `'updates'`，只解析中断，其他 updates 忽略。
- 恢复：`agent.stream(new Command({ resume: { decisions: [{ type: 'approve' }] } }), { configurable:{ thread_id } })`。
  - 决策格式以所装版本的 `hitl.d.ts` 为准，先写 spike 验证。

## 验收

- 新增单测：中断 → confirm 事件 → resume approve → 下单被调用一次；reject → 不下单，模型回复"已取消"。
- E2E 追加 1 条：点卡片"确认下单"后出现订单号。

## Cursor 提示词

```text
仓库 agent-hub，分支 feat/wp8-hitl-order（从已合并 WP5 的 main 拉）。
目标：对话内下单 + 执行前人工确认。
先读：工作包/WP8、02-接口契约.md、ADR-0004/0005、langchain 的 hitl.d.ts（node_modules/langchain/dist/agents/middleware/hitl.d.ts）。
步骤：
0. 先写 spike：createAgent + humanInTheLoopMiddleware + MemorySaver，确认中断在 stream 中的形态（updates 里的 __interrupt__）与 resume 的决策格式，把结论写进 PR。
1. 起草 docs/adr/0006-hitl-order.md：新增 ConfirmEvent 与 ResumeRequest（见 WP8 文档），说明旧前端兼容性（必须与前端同 PR 发布）。
2. contracts.ts 追加 ConfirmEvent 并加入 AgentStreamEvent 联合、ResumeRequest；schemas.py 同步；fixture 只追加样例。
3. tools.ts 新增 create_order({skuId, quantity})：价格取 CATALOG，调用 FastAPI POST /api/orders。
4. agent.ts 挂 humanInTheLoopMiddleware({ interruptOn: { create_order: { allowedDecisions: ['approve','reject'] } } })；translate.ts 识别中断并输出 confirm，再 done；server.ts 新增 POST /api/agent/resume。
5. 前端：confirm 片段渲染为确认条（确认/取消），调用 resume 接口并复用流式消费。
6. 测试先行：approve 下单一次、reject 不下单；e2e 追加确认下单用例。
硬约束：金额单位分；价格只信服务端；不加依赖；DoD 全绿。
完成后输出：spike 结论、改动文件、测试结果。
```
