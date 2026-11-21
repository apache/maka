# WP2 · 轮内上下文治理（第二批）

**目标**：修 C1、C2。治理从"只在轮开始前"改为"每次模型调用前"，并让压缩摘要保留工具信息。

**langchain 对标**：`agents/middleware/contextEditing.ts`（清理旧工具输出，`trigger`/`keep` 参数）、`agents/middleware/summarization.ts`（摘要时保持 AI/Tool 配对）。

**归属文件**：`src/core/governance.ts`（新）、`src/core/compact.ts`；`src/core/turn.ts` 删掉 `:32` 起的轮前治理分支，改为注册 `governanceMiddleware`。

**接口依赖**：WP0、WP1（`beforeModel`、`replaceMessages`、`callModel`）。

## 策略（`beforeModel` 里按顺序执行，任一步后降到 80% 以下就停）

| 步骤 | 做法 | 事件 |
|---|---|---|
| 1 清理旧工具输出 | 除最近 3 条外，`tool` 消息正文替换为 `[已清理：<工具名> 输出 N 字符，需要时重新读取]`；**保留** assistant 的工具名和参数 | `context_edit{strategy:'clear_tool_outputs', cleared, savedTokens, at}` |
| 2 压缩 | 调用改造后的 `compact`；同一轮最多 2 次 | `compact{savedTokens, at}` |
| 3 裁剪 | 现有 `trimContext`，兜底 | `trimmed{count, at}` |

- 阈值：`estimateTokens(messages) > 0.8 * contextLimit`（与 `turn.ts:32` 一致）。
- 轮开始前那次也由同一个中间件完成（`at:'turn_start'`），轮内为 `at:'model_call'`。
- 所有改写都通过 `state.replaceMessages()`，它负责不变式和 checkpoint。

## compact.ts 改造（C2）

`compact.ts:41` 现在把工具调用写成 `(tool_calls: N 个)`。改为：

```text
[assistant 调用] read {"file_path":"src/a.ts"}        ← 参数截断到 200 字符
[tool 结果 read] export function a() { … }（共 5321 字符） ← 结果开头截断到 300 字符
```

保留：system 消息、本轮用户消息（I4）、最近若干组完整的 assistant+tool 配对（I2）。

## 测试

见 04 §2 WP2 行。关键用例：复现 A 的剧本下，每次 `provider.chat` 收到的消息估算都 ≤ `contextLimit`。

## Cursor 提示词

```text
仓库 coding-agent，impls/typescript，分支 feat/wp2-midturn-governance（从已合并 WP1 的 develop 拉）。
目标：上下文治理在每次模型调用前执行，压缩摘要保留工具信息。
参考：附带的 01、02、04 文档和 工作包/WP2。
1. 先写测试（test/context.test.ts、test/compact.test.ts）：
   a. 假 provider 连续 8 次要求 read 一个返回 60000 字符的工具，contextLimit=100000：每次 provider.chat 收到的 estimateTokens 都 ≤ 100000；
   b. 只清理旧工具输出就降到 80% 以下时，不调用摘要模型；
   c. 压缩摘要的输入包含工具名和参数片段；
   d. 发出 context_edit / compact 事件，at 为 'model_call'；
   e. 轮内压缩后从会话文件重新加载，消息序列与内存一致。
   先跑确认失败。
2. 新建 core/governance.ts 导出 governanceMiddleware(config)，beforeModel 中按顺序：清理最近 3 条之外的 tool 输出（正文换成"[已清理：<工具名> 输出 N 字符，需要时重新读取]"，保留调用参数）→ 压缩（同轮最多 2 次）→ trimContext 兜底。每步之后若 ≤ 80% 就停。所有改写走 state.replaceMessages。
3. 改 core/compact.ts:41 附近：摘要输入写入工具名、参数（截断 200 字符）、结果开头（截断 300 字符）；保留 system、本轮用户消息、最近完整的 assistant+tool 配对。
4. core/turn.ts：删除轮前治理分支，改为注册 governanceMiddleware（轮前那次 at='turn_start'）。
5. repl.ts 和 web.html renderLog 各加一个 context_edit 的渲染（一行灰字，只用已有 CSS 类）。
6. 更新 specs/context.md 的触发点和摘要输入规则。
硬约束：零新增依赖；不改 estimateTokens；不变式 I1–I4 由 replaceMessages 保证，不要绕过；npm test、npm run check 全绿。
完成后输出：改动文件、测试结果、复现脚本 A 项的新输出。
