# WP1 · 出口序列化完整映射（Q-P0-1）

- **目标**：三个出口序列化器把 Canonical Event 完整映射到下游协议：文本、思考、工具调用（含分片参数）、stop reason、usage、错误。
- **依赖**：WP0
- **分支**：`feat/wp1-egress`
- **归属文件**：`apps/gateway/src/protocols/openai/chat.ts`、`openai/responses.ts`、`openai/stream.ts`、`anthropic/messages.ts`、`anthropic/stream.ts`；`test/protocols/egress/**`（新增）

## 现状证据

- `openai/chat.ts:60-75,88-89`：只处理 `text.delta`，文件里没有一处 `tool`；
- `anthropic/messages.ts:40,65-77`：同上，`stop_reason` 固定；
- `openai/responses.ts:71`：只输出 `output_text` item。

## 映射表

| Canonical | OpenAI Chat | OpenAI Responses | Anthropic Messages |
|---|---|---|---|
| `text.delta` | `delta.content` | `response.output_text.delta` | `content_block_delta` / `text_delta` |
| `thinking.delta` | `delta.reasoning_content`（非标准，主流兼容客户端认） | `response.reasoning_summary_text.delta`（reasoning item） | `thinking` block + `thinking_delta`；结束时 `signature_delta` |
| `tool.start{id,name}` | `delta.tool_calls[i]{id,type,function.name}` | `response.output_item.added` function_call | `content_block_start` tool_use |
| `tool.delta{argumentsDelta}` | `delta.tool_calls[i].function.arguments` | `response.function_call_arguments.delta` | `input_json_delta` |
| `tool.end` | — | `response.function_call_arguments.done` + `output_item.done` | `content_block_stop` |
| `message.end{stopReason}` | `finish_reason`: stop/tool_calls/length | `response.completed` status / `incomplete_details` | `message_delta.stop_reason`: end_turn/tool_use/max_tokens |
| `usage` | 末帧 `usage`（`stream_options.include_usage` 时） | `response.completed.response.usage` | `message_start.usage` + `message_delta.usage` |
| `error`（流内） | `data: {"error":{…}}` 后 `[DONE]` | `response.failed` | `event: error` |

非流式（聚合）路径用 `core/aggregate.ts` 的结果按同一映射生成完整 JSON。

## 步骤

1. 先写失败的测试：用 `test/fixtures/gateway/thinking-tools.sse`、`text.sse` 驱动三个出口，快照下游输出（流式 + 非流式 = 6 组）。
2. 实现映射；多个工具调用按 `tool.start` 顺序分配 index。
3. 跑现有 characterization 测试，确认纯文本输出逐字节不变。

## 验收

- 6 组快照测试全绿；thinking-tools fixture 下游能看到工具名、完整参数 JSON、`finish_reason: "tool_calls"` / `stop_reason: "tool_use"` / function_call item。
- 原有用例全绿（纯文本行为不变）。

## 不要做

- 不要改 `beginSse` 的调用时机（那是 WP3）。
- 不要改入口 `request.ts`（WP2）。

## Cursor 提示词

```text
你在 qoder-proxy-api 做 WP1：出口序列化完整映射。只改 apps/gateway/src/protocols/openai/{chat,responses,stream}.ts、apps/gateway/src/protocols/anthropic/{messages,stream}.ts，以及新增 apps/gateway/test/protocols/egress/**。

现状：这三个出口只处理 text.delta，工具调用、thinking、stopReason、usage 全部丢失（见 chat.ts:60-75、messages.ts:40,65-77、responses.ts:71）。

按文档 工作包/WP1 的映射表实现 Canonical Event → OpenAI Chat / OpenAI Responses / Anthropic Messages 的完整映射，流式和非流式都要覆盖。

先写测试：用 test/fixtures/gateway/thinking-tools.sse 和 text.sse 驱动三个出口，对下游输出做快照（6 组），确认测试先失败，再实现。
多个工具调用按出现顺序编号；参数分片原样拼接；Anthropic thinking 块结束时如果 Canonical 带 signature 要发 signature_delta。

约束：不要改 beginSse 的调用位置（另一个工作包负责）；不要改 request.ts；纯文本输出必须与现在逐字节一致（现有 characterization 测试要保持绿）。
完成后贴出新测试列表和 pnpm --filter qoder-proxy-api test 输出。
```
