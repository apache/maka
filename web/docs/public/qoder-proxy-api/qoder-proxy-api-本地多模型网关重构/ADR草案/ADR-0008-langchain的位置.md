# ADR-0008：langchain.js 不进数据面，只在三处出现

- 状态：草案（Proposed）
- 相关：00 §取舍；01 §4；WP4、WP10

## 背景

langchain.js v1 有成熟的 middleware（beforeModel、modelFallback、modelCallLimit）、`createAgent` 和 standard-tests。有人提议用 langchain 的消息模型替代 Canonical Event，直接复用它的 fallback。

## 决定

langchain **不进入网关数据面**。原因：

1. **保真**：langchain 的 `BaseMessage` 会丢或改写 Anthropic thinking `signature`、`cache_control`、Responses 的 item id / `previous_response_id`。网关的首要职责是透明转发，这些丢了 Agent 就坏了。
2. **延迟与体积**：多一层对象转换和依赖树，和 ADR-0007 冲突。
3. **控制粒度**：commit 前扣住事件、首字节判定，需要在原始流事件层面做，langchain 的 fallback 是"整次调用"粒度。

langchain 只在三处出现：

| 用法 | 位置 | 依赖类型 |
|---|---|---|
| **借语义**：middleware 钩子命名与职责 → `GatewayMiddleware.beforeRequest / onEvent`、路由组改道、`maxAttempts` | `apps/gateway/src/routing/pipeline.ts`（自己实现） | 无 |
| **契约测试**：standard-tests 风格用例 + `ChatOpenAI` / `ChatAnthropic` / `createAgent` 两轮工具往返 | `test/standard/`、`examples/langchain-smoke/` | devDependency |
| **playground**：用 `createAgent` 经网关跑真实 Agent 循环，演示路由组 | `apps/playground/` | 该 app 自己的 dependency |

## 后果

- 正面：数据面保真、零依赖；langchain 作为"最挑剔的客户端"来验收网关。
- 负面：middleware 要自己写；langchain 升级时契约测试可能先红——这正是我们想要的信号。
