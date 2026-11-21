# WP2 · 入口保真（Q-P0-2）

- **目标**：三个入口把下游请求无损转成 `CanonicalRequest`：工具定义、assistant 工具调用轮、工具结果（`tool_call_id`）、图片、thinking 块与签名、`cache_control`。
- **依赖**：WP0
- **分支**：`feat/wp2-ingress`
- **归属文件**：`apps/gateway/src/protocols/openai/request.ts`、`anthropic/request.ts`、`apps/gateway/src/core/request.ts`（只加字段）；`test/protocols/ingress/**`

## 现状证据

- `openai/request.ts:19` `if (!text) continue`：content 为空的 assistant 工具调用轮被整条丢弃；
- `:15-27`：`tool_call_id` 不保留；
- `:111-130`：图片变成 `[image: …]` 占位文本；
- `anthropic/request.ts:47-63`：`tool_use` / `tool_result` / `thinking` 块被压平为文本。

## 步骤

1. 在 `core/request.ts` 给 `CanonicalMessage.content` 增加 part 类型：`text`、`image{mediaType, data|url}`、`tool_call{id,name,arguments}`、`tool_result{toolCallId, content, isError?}`、`thinking{text, signature?}`；允许 `providerExtras`（原样透传 `cache_control` 等）。现有 provider 读取 `text` 的路径保持兼容（提供 `textOf(message)` 辅助）。
2. OpenAI Chat 入口：`tool_calls` → `tool_call` parts；`role: tool` → `tool_result`；`image_url` → `image`。
3. Responses 入口：`input` item（`message`、`function_call`、`function_call_output`、`reasoning`）逐项映射；`previous_response_id` 暂不支持，收到时返回 400 并说明（05 R6）。
4. Anthropic 入口：`tool_use` / `tool_result` / `thinking`（含 `signature`）/ `image` 块逐项映射。
5. 性质测试：随机生成 200 个合法消息序列，下游 → Canonical → 下游，断言等价（用 WP1 的出口或测试内的反向函数）。

## 验收

- 上面 4 个证据点各有一个先红后绿的回归用例。
- 性质测试 200 例 0 差异。
- Qoder 现有 provider 的请求体（characterization 快照）对纯文本输入不变。

## 不要做

- 不要在入口做"兼容性降级"（例如把图片转文本）——那是 provider 或中间件的事，在 Canonical 层必须保真。
- 不要改出口。

## Cursor 提示词

```text
你在 qoder-proxy-api 做 WP2：入口保真。只改 apps/gateway/src/protocols/openai/request.ts、apps/gateway/src/protocols/anthropic/request.ts、apps/gateway/src/core/request.ts（只加字段，不删），以及新增 apps/gateway/test/protocols/ingress/**。

现状缺陷（先各写一个失败用例）：
1. openai/request.ts:19 的 `if (!text) continue` 把 content 为空的 assistant 工具调用轮整条丢掉；
2. tool 消息的 tool_call_id 没保留；
3. 图片在 :111-130 被替换成 "[image: …]" 文本；
4. anthropic/request.ts:47-63 把 tool_use / tool_result / thinking 块压成文本，thinking 的 signature 丢失。

给 CanonicalMessage.content 增加 part 类型：text、image、tool_call、tool_result、thinking(含 signature)，以及 providerExtras 透传 cache_control 等字段。提供 textOf(message) 让现有 provider 只读文本时行为不变。
OpenAI Chat、OpenAI Responses、Anthropic 三个入口逐项保真映射。Responses 的 previous_response_id 暂不支持：返回 400 并给出清楚的错误信息。
再写一个性质测试：随机生成 200 个合法消息序列做往返，断言无丢失。

约束：不改出口序列化器；不在入口做任何降级；现有 provider 对纯文本请求的上游请求体必须不变（characterization 测试保持绿）。
完成后贴出 4 个回归用例名和测试输出。
```
