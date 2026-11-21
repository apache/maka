# WP0 · 接口契约（最先合并）

**目标**：只加类型、空实现、ADR 和 spec 草案，让第一批 5 个包能同时开工。**不改任何行为**。

**langchain 对标**：`libs/langchain/src/agents/middleware/types.ts:534-604`（中间件钩子定义）、`libs/langchain-core/src/messages/tool.ts`（`invalid_tool_calls`）。

**归属文件**：`src/kernel/types.ts`、`src/kernel/plugin.ts`、`src/core/middleware.ts`（新，只有类型和直通组合器）、`docs/adr/ADR-003-轮内中间件.md`（新）、`specs/*.md`（只加"修订草案"段落）。

## 步骤

1. 按 [02-接口契约](../02-接口契约.md) §1 给 `kernel/types.ts` 加 `FinishReason`、`CompletionResult.finishReason?`、`ToolErrorKind`、`GovernanceAt`、三个新事件、`trimmed/compact` 的可选 `at`。
2. `kernel/plugin.ts` 的 `ToolPlugin` 加可选 `grantKey?`。
3. 新建 `core/middleware.ts`：导出 02 §2 的全部类型；`composeMiddleware()` 先做直通实现；`assertInvariants()` 先空实现并标 `// WP1`。
4. `TurnDeps` 加 `middleware?`、`onMessage?`、`maxRounds?`，**不在 agentloop 里使用**。
5. `PermissionRequest` 加可选 `grantKey?`、`grantLabel?`（WP4 再改成必填）。
6. `shell/repl.ts`、`shell/web.html`：确认未知事件被忽略（加一个测试即可，不改渲染）。
7. 写 ADR-003（草稿在 [01-目标架构](../01-目标架构.md) 末尾）。
8. 在 `specs/` 对应文件末尾加"修订草案（ADR-003）"段落，内容取 02 §5 表格。

## 验收

- `npm test`、`npm run check` 全绿；`git diff --stat` 只涉及上述文件。
- 新增一个测试：向 repl/web 渲染发 `context_edit`/`tool_error`/`limit` 事件，不抛异常。

## Cursor 提示词

```text
你在 coding-agent 仓库（impls/typescript）工作，分支 feat/wp0-contracts，从最新 develop 拉。
任务：只加接口契约，不改任何运行行为。
参考：附带的 02-接口契约.md。
1. kernel/types.ts：新增 FinishReason、CompletionResult.finishReason?、ToolErrorKind、GovernanceAt；AgentEvent 新增 context_edit、tool_error、limit；trimmed/compact 增加可选字段 at。
2. kernel/plugin.ts：ToolPlugin 增加可选 grantKey?(args) => string。
3. 新建 core/middleware.ts：导出 TurnState、Jump、ParsedToolCall、ToolOutcome、TurnMiddleware；composeMiddleware 为直通实现；assertInvariants 空实现并注释 "WP1 实现"。
4. TurnDeps 增加 middleware?、onMessage?、maxRounds?，agentloop 暂不使用。
5. PermissionRequest 增加可选 grantKey?、grantLabel?。
6. 加一个测试：shell 收到上述 3 种新事件时不抛异常。
7. 新建 docs/adr/ADR-003-轮内中间件.md；在 specs/agent-loop.md、context.md、permission.md、session-turn.md、event.md、provider.md 末尾各加"修订草案（ADR-003）"段落。
硬约束：零新增依赖；不改已有字段名/事件名/工具 id；core/ 不 import 网络模块；npm test 与 npm run check 必须全绿；diff 只能涉及上述文件。
完成后输出：改动文件列表、测试结果。
