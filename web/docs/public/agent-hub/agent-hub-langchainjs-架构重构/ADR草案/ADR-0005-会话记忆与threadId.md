# ADR-0005：会话记忆（threadId + checkpointer + 摘要）

- 状态：草案

## 背景

现状每次请求只发 `[system, user]`，追问"预算再低一点"时模型不知道上文（A-P1-2）。

## 决定

1. `ChatRequest` 进入 `packages/shared/contracts.ts`，新增可选 `threadId`（8–64 字符）。`schemas.py` 同步，fixture 追加样例。
2. 前端 chat store 首次发送时生成 `threadId = crypto.randomUUID()`，`reset()`（"清空"按钮）时清空。不持久化到 localStorage：刷新等于新对话，与当前 UI 的消息列表行为一致。
3. 服务端 `createAgent({ checkpointer: new MemorySaver() })`，`configurable.thread_id = threadId`。不带 threadId 时使用一次性 id（等价单轮）。
4. 摘要：配置了 `AGENT_SUMMARY_MODEL` 时挂 `summarizationMiddleware({ model: 独立模型, trigger:{tokens:6000}, keep:{messages:12} })`。离线模式不启用。
5. 证据因果校验以"本轮"为界（ADR-0004），记忆不放宽这一规则。

## 已接受的限制

- 重启丢失全部记忆（MemorySaver 在进程内）。
- threadId 未鉴权，只适合演示；上线前改为服务端签发并绑定用户。
- 内存随 thread 数增长；WP5 加 LRU 上限（默认 1000 个 thread）。

## 备选

- 前端每次回传完整历史：协议变重，且模型能看到的工具消息无法由前端还原，不选。
- SqliteSaver：需要新依赖和文件管理，留给后续 ADR。
