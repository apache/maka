# WP3 · 错误码、延迟写头、心跳与背压、assertProvider、请求体上限

- **目标**：上游失败时下游拿到真实 HTTP 状态码；SSE 有心跳和背压；Provider 注册校验真正生效；请求体有上限。
- **依赖**：WP0；与 WP1 同改出口文件——**WP1 先合，WP3 rebase**
- **分支**：`feat/wp3-errors`
- **归属文件**：`apps/gateway/src/server/{server,sse,http}.ts`、`src/sse.ts`；出口文件中 `beginSse` 调用前后几行；`src/core/provider.ts` 的 `assertProvider`；`test/server/**`
- 对应原路线图：Q5（错误码 + Retry-After）、Q6（心跳 + drain）、Q7（assertProvider）；Q8（`reasoningEffort` 入口映射）可选附带

## 步骤

1. **peekFirst**：把出口的"先 `beginSse` 再迭代"改为"先取首事件"。首事件是 `error` → 按 02 §5 回 JSON 错误 + 状态码；否则 `beginSse`，先写首事件再写其余。骨架 `pipeline.ts` 的 `peekFirst()` 与 `gatewayServer.ts` 可直接参照。
2. **mapError**（`server.ts:195-209`）：按 02 §5 表映射，429 带 `Retry-After`（秒，向上取整）。上游 401/403 对下游是 502，不是 401。
3. **心跳**：SSE 开始后每 15 秒无输出写 `: ping\n\n`；请求结束清计时器。
4. **背压**：`res.write()` 返回 false 时 `await once(res, "drain")`，同时监听 `close` 以便客户端走掉时中止上游。
5. **assertProvider**（`core/provider.ts:35`）：只检查 provider 自身返回的 capabilities 对象的键和值域，不先合并默认值；支持 `capabilities()` 返回 Promise。注册表 fail-fast 行为保留。
6. **请求体上限**：8 MB，超过 413，错误体按协议格式。
7. （可选 Q8）`reasoning_effort` / Anthropic `thinking.budget_tokens` 映射到 Canonical `reasoningEffort`。

## 验收

- 假 provider 首事件前抛 429（retryAfterMs 2500）→ 下游 `429` + `Retry-After: 3`，不是 200。
- 首事件后抛错 → 200 + 流内错误事件。
- 假 provider 30 秒不出事件（用假时钟）→ 下游收到 ≥2 个 `: ping`。
- 慢读客户端下 `write` 返回 false 时不继续写（用桩 `res` 断言）。
- 缺 `tools` 能力的 provider 注册时抛错（现在会通过）。
- 9 MB 请求体 → 413。

## 不要做

- 不要碰事件映射主体（WP1）。
- 不要引入改道逻辑（WP6）。

## Cursor 提示词

```text
你在 qoder-proxy-api 做 WP3。只改 apps/gateway/src/server/{server,sse,http}.ts、apps/gateway/src/sse.ts、apps/gateway/src/core/provider.ts 里的 assertProvider，以及三个出口文件中 beginSse 调用前后的几行；新增 apps/gateway/test/server/**。WP1 已合并，先 rebase。

任务：
1. 出口改为先 peek 首个事件：如果首事件是 error，按文档 02-接口契约.md §5 的表返回 JSON 错误和真实状态码（429 带 Retry-After 秒数）；否则再 beginSse 并写出首事件和后续事件。参考 附录/代码骨架/src/pipeline.ts 的 peekFirst 和 gatewayServer.ts。
2. server.ts:195-209 的 mapError 按同一张表映射；上游 401/403 对下游返回 502。
3. SSE 每 15 秒无输出写 ": ping\n\n"；res.write 返回 false 时等待 drain；客户端 close 时中止上游 signal。
4. core/provider.ts:35 的 assertProvider 目前先合并默认值再检查键，导致恒通过。改为只检查 provider 自己返回的 capabilities（可能是 Promise）。
5. 请求体超过 8 MB 返回 413。

每一条先写失败测试（用假时钟测心跳，用桩 res 测 drain），再实现。
约束：不改事件映射主体；不加改道；不加运行时依赖。完成后贴出测试输出。
```
