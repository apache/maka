# WP5 · 通用 OpenAI 兼容 Provider

- **目标**：一个可配置的 `openai-compatible` provider，可接 DeepSeek、Kimi、GLM、通义、OpenRouter、本地 vLLM / Ollama 等。
- **依赖**：WP0
- **分支**：`feat/wp5-openai-compatible`
- **归属文件**：`apps/gateway/src/providers/openaiCompatible/**`、`src/routing/providerRegistry.ts`（加工厂注册）、`test/providers/openaiCompatible/**`
- **起点**：`附录/代码骨架/src/openaiCompatible.ts` + `test/openaiCompatible.test.ts`（5 个用例已绿）

## 要点（骨架已实现，移植时保留）

- 首字节超时用自己的计时器，**拿到响应头就清掉**；不要用 `AbortSignal.timeout`（会掐断流式正文）。
- SSE 解析兼容 `\r\n`；忽略注释行；`[DONE]` 结束。
- `reasoning_content` → `thinking.delta`；`tool_calls` 按 index 聚合分片；`finish_reason` → stopReason；空 `choices` 的末帧只取 `usage`。
- `stream_options: { include_usage: true }`。
- 状态码 → 错误码：401/403 AUTH、404 MODEL_NOT_FOUND、408/504 TIMEOUT、429 RATE_LIMITED（解析 `Retry-After` 秒数或 HTTP 日期）、400/422 REJECTED、5xx UNAVAILABLE。
- 上游干净结束但没有任何内容 → `PROVIDER_PROTOCOL_ERROR`（可改道）。
- `toOpenAiBody` 必须保留工具历史与图片（依赖 WP2 的 Canonical part）。
- 能力由配置声明（02 §7.1），`capabilities()` 返回三态值以通过 `assertProvider`。

## 步骤

1. 移植骨架文件与测试，适配真实 `core/*` 类型。
2. 工厂 `createOpenAiCompatibleProvider(config, secrets)`；注册表支持按配置创建多个实例（id 各不相同）。
3. `listModels()` 调 `GET /models`，失败时回退到配置里的 `models`。
4. 手动对一个真实供应商跑通文本 + 工具调用（记录在 PR，不进 CI）。

## 验收

- 骨架 5 个用例移植后全绿，另加：HTTP 日期格式的 Retry-After、`/models` 失败回退、Key 不出现在错误消息里。
- 注册两个不同 id 的实例互不影响。

## 不要做

- 不做路由组和改道（WP6）。
- 不把 Key 打进日志或错误。

## Cursor 提示词

```text
你在 qoder-proxy-api 做 WP5：通用 OpenAI 兼容 provider。只改 apps/gateway/src/providers/openaiCompatible/**、apps/gateway/src/routing/providerRegistry.ts（只加工厂注册）、apps/gateway/test/providers/openaiCompatible/**。

起点是文档包里的 附录/代码骨架/src/openaiCompatible.ts 和 test/openaiCompatible.test.ts，那 5 个测试已经是绿的。把它们移植进来，适配真实的 core 类型（GatewayProvider、ProviderError、CanonicalRequest 的 part 类型）。

必须保留的行为：首字节超时用自定义计时器且在收到响应头后清除（不要用 AbortSignal.timeout）；SSE 兼容 CRLF；reasoning_content → thinking.delta；tool_calls 按 index 聚合；空 choices 帧只取 usage；发送 stream_options.include_usage；状态码映射 401/403→AUTH、404→MODEL_NOT_FOUND、429→RATE_LIMITED(解析 Retry-After 秒或 HTTP 日期)、400/422→REJECTED、5xx→UNAVAILABLE、408/504→TIMEOUT；干净结束但无内容→PROTOCOL_ERROR。
capabilities() 返回三态值（tools: native|none 等），以便通过 assertProvider。listModels 调 GET /models，失败回退到配置的 models。

新增测试：HTTP 日期格式 Retry-After、/models 失败回退、错误消息中不含 Key、两个实例互不影响。
约束：不做路由组/改道；不加运行时依赖。
```
