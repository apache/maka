# WP1 · 轮内中间件骨架

**目标**：把 `agentloop.ts` 里内联的 Plan Mode、权限检查改成固定顺序的中间件，并在**每次模型调用前**留出 `beforeModel` 钩子。这是 C1/C5 的基础。

**langchain 对标**：`agents/middleware.ts` 的 `createMiddleware`；`types.ts:534-604` 的 `beforeModel`/`afterModel`/`wrapToolCall`。只借语义：钩子位置、洋葱顺序、`jumpTo`。**不借** LangGraph 状态图、`Command`、`interrupt()`。

**归属文件**：`src/core/middleware.ts`、`src/core/agentloop.ts`（骨架）；`src/core/turn.ts` 只加一行把 `middleware` 传给 `runTurn`。

**接口依赖**：WP0。

## 步骤

1. 先写 `test/middleware.test.ts`（见 04 §2 的 5 个用例），确认红。
2. 实现 `composeMiddleware(list)`：
   - 顺序固定为 `planMode → 用户中间件 → permission`；permission 不在最内层就抛错。
   - `beforeModel`/`afterModel` 按顺序执行，任一返回 `jumpTo` 立即停止。
   - `wrapToolCall` 是洋葱：`list.reduceRight` 包住真正的工具执行。
3. 实现 `assertInvariants(messages, mark)`：
   - I1 `messages[0]` 若原来是 system 仍是 system；
   - I2 每个带 `tool_calls` 的 assistant 后面紧跟全部对应 `tool` 消息；
   - I3 `mark` 指向本轮用户消息；
   - I4 本轮用户消息不能被删除或改写。
4. 改 `agentloop.ts`：
   - 循环里每次调用 `provider.chat` 之前 `await mw.beforeModel(state)`；强制总结那次也要调。
   - 把 Plan Mode 拦截改写为 `planModeMiddleware.wrapToolCall`；把权限检查改写为 `permissionMiddleware.wrapToolCall`（调用现有 `createPermissionGate`，不改其逻辑）。
   - `state.replaceMessages(next)`：校验不变式 → 就地替换数组内容 → 重算 `mark` → `app.store.checkpoint?.(next)`。
   - `deps.middleware` 缺省为 `[]`，此时行为与现状一致。
5. **保留** WP3 的 `parseToolArgs` 调用和 WP5 的 `deps.maxRounds ?? MAX_TOOL_ROUNDS`（若它们先合并，rebase 时搬进新骨架）。
6. `specs/agent-loop.md` 新增 R9（中间件顺序）。

## 验收

- 现有 `test/loop.test.ts`、`planmode.test.ts`、`approval.test.ts` 不改一行仍全绿。
- 新测试 5 个用例全绿。
- `agentloop.ts` 里不再出现 Plan Mode 和权限的内联判断。

## Cursor 提示词

```text
仓库 coding-agent，目录 impls/typescript，分支 feat/wp1-middleware（从已合并 WP0 的 develop 拉）。
目标：在 core/agentloop.ts 引入轮内中间件，让每次模型调用前都有 beforeModel 钩子；Plan Mode 和权限检查改为中间件。
参考：附带的 01-目标架构.md、02-接口契约.md、工作包/WP1。
步骤：
1. 先新建 test/middleware.test.ts，写 5 个用例：空中间件时与现状一致；beforeModel 在每次模型调用前都被调用（含 40 轮后的强制总结调用）；wrapToolCall 洋葱顺序；permission 不在最内层时 composeMiddleware 抛错；replaceMessages 破坏"assistant.tool_calls 后紧跟对应 tool 消息"时抛错。先跑确认失败。
2. 在 core/middleware.ts 实现 composeMiddleware 和 assertInvariants（不变式 I1–I4 见 01 文档）。
3. 改 agentloop.ts：provider.chat 前调用 beforeModel，后调用 afterModel；工具执行经过 wrapToolCall；Plan Mode 和权限检查移到 planModeMiddleware / permissionMiddleware（权限逻辑仍调用现有 createPermissionGate，不改它）。replaceMessages 需校验不变式、重算 mark、调用 app.store.checkpoint?.()。
4. turn.ts 只加一行，把 middleware 传给 runTurn。
5. 如果 develop 上已有 parseToolArgs 调用或 deps.maxRounds，保留它们。
6. specs/agent-loop.md 增加 R9：中间件顺序 planMode → 用户中间件 → permission（固定最内层）。
硬约束：loop 不插件化，中间件只是内部组合点；零新增依赖；不改已有事件和字段；现有测试一行不改必须全绿；npm test 和 npm run check 全绿。
完成后输出：改动文件、测试结果、agentloop.ts 改动前后的结构对比（10 行内）。
