# WP10 · playground（createAgent）与中间件扩展点

- **目标**：`apps/playground` 用 langchain `createAgent` 经网关跑真实 Agent 循环，演示路由组与改道；整理 `GatewayMiddleware` 扩展点文档。
- **依赖**：WP6、WP7
- **分支**：`feat/wp10-playground`
- **归属文件**：`apps/playground/**`、`docs/middleware.md`、`apps/gateway/src/routing/middlewares/**`（只新增示例中间件）

## 步骤

1. `apps/playground`：Node 脚本 + 可选极简网页。`createAgent({ model: new ChatOpenAI({ baseURL: "http://127.0.0.1:8320/v1", model: "group/daily-coding" }), tools: [...] })`，内置 3 个场景：两轮工具往返、长上下文、图片。
2. 演示脚本 `--simulate-429`：调用 admin API 让组内第一个成员进入歇息（或用假供应商），展示改道，控制台同步可见。
3. `docs/middleware.md`：`beforeRequest` / `onEvent` 语义、与 langchain middleware 对照（01 §4）、写一个中间件的完整例子（如：给某供应商加默认 `temperature`、按 Agent 限制 maxTokens）。
4. 示例中间件 2 个，带测试，默认不启用。

## 验收

- `pnpm --filter playground start` 对 `group/<id>` 跑通两轮工具往返；控制台路由页出现对应请求（agent 显示为 `playground`）。
- 示例中间件测试绿；默认配置下行为不变。

## 不要做

- 不把 langchain 引入 gateway（ADR-0008）。

## Cursor 提示词

```text
你在 qoder-proxy-api 做 WP10。只改 apps/playground/**、docs/middleware.md、apps/gateway/src/routing/middlewares/**（只新增示例，默认不启用）。

1. apps/playground：用 langchain 的 createAgent + ChatOpenAI（baseURL 指向 http://127.0.0.1:8320/v1，model 用 group/<id>），内置三个场景：两轮工具往返、长上下文、图片输入。用一把 agent key 让控制台显示 agent=playground。
2. 加 --simulate-429 选项，通过 admin API 或假供应商让组内第一个成员进入歇息，演示改道。
3. docs/middleware.md：解释 GatewayMiddleware.beforeRequest / onEvent，对照 langchain 的 beforeModel / modelFallback / modelCallLimit，给一个完整例子。
4. 写两个示例中间件（默认 temperature、按 agent 限制 maxTokens）并测试。

约束：apps/gateway 不得依赖 langchain；示例中间件默认关闭，默认行为不变。
```
