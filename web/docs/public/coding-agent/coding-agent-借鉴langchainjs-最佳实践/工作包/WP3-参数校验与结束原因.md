# WP3 · 工具参数校验 + finishReason

**目标**：修 C3。非法或被截断的工具参数不再静默变成 `{}` 去执行工具。

**langchain 对标**：`libs/langchain-core/src/messages/tool.ts` 与 `messages/content/tools.ts` 的 `invalid_tool_calls`；`agents/middleware/toolError.ts`（把错误回灌模型而不是抛出）。

**归属文件**：`src/core/toolargs.ts`（新）、`src/providers/openai.ts`、`src/providers/anthropic.ts`；`src/core/agentloop.ts` 只替换 `:45-51` 那段 `JSON.parse`。

**接口依赖**：WP0。

## 结束原因映射（写进 `specs/provider.md`）

| 来源 | 原值 | FinishReason |
|---|---|---|
| openai `finish_reason` | `stop` | `stop` |
| | `tool_calls` / `function_call` | `tool_calls` |
| | `length` | `length` |
| | `content_filter` | `content_filter` |
| anthropic `stop_reason` | `end_turn` / `stop_sequence` | `stop` |
| | `tool_use` | `tool_calls` |
| | `max_tokens` | `length` |
| | `refusal` | `content_filter` |
| 其他 / 缺失 | — | `unknown` |

`providers/openai.ts:80` 已声明 `finish_reason` 字段，只需在流结束时取最后一个非空值。

## 参数判定

| 情况 | 结果 |
|---|---|
| `finishReason === 'length'` 且有工具调用（不论 JSON 是否合法） | `truncated_args` |
| `JSON.parse` 失败 | `invalid_args` |
| 顶层不是对象 | `invalid_args` |
| 缺 `schema.required` 字段或顶层 primitive 类型不符 | `schema_mismatch` |
| 工具名不存在 | `unknown_tool`（沿用现有出口，补发事件） |

失败时：**不执行工具**；写入 tool 消息 `toolArgsErrorText(...)`（含工具名、原始参数前 200 字符、必需字段列表、"请重新生成完整参数"）；发 `tool_error` 事件。

## Cursor 提示词

```text
仓库 coding-agent，impls/typescript，分支 feat/wp3-toolargs（从已合并 WP0 的 develop 拉）。
目标：非法/截断的工具参数不再静默变成 {} 去执行。
参考：附带的 02-接口契约.md §3 和 工作包/WP3。
1. 先写测试 test/toolargs.test.ts 和 test/loop.test.ts 新用例：
   a. arguments 为 '{"file_path":"src/a.ts","content":"export const'：工具不被调用，tool 消息包含工具名和"参数"字样，发出 tool_error{kind:'invalid_args'}；
   b. finishReason='length' 且参数是合法 JSON：kind='truncated_args'，工具不执行；
   c. 缺 required 字段：kind='schema_mismatch'；
   d. openai 和 anthropic provider 的结束原因映射（按 WP3 映射表）。
   先跑确认失败。
2. 新建 core/toolargs.ts：parseToolArgs(raw, schema, finishReason) 与 toolArgsErrorText(...)，零依赖，只校验 JSON、顶层对象、required、顶层 primitive 类型。
3. providers/openai.ts：流结束时取最后一个非空 finish_reason，映射后放进 CompletionResult.finishReason；providers/anthropic.ts 同理映射 stop_reason。
4. core/agentloop.ts：只把 45-51 行附近的 JSON.parse 降级逻辑替换为 parseToolArgs 调用；失败时写 tool 消息、emit tool_error、跳过执行。不要动循环其他部分（WP1 在并行重构）。
5. repl.ts 和 web.html renderLog 各加一个 tool_error 渲染（一行，只用已有 CSS 类）。
6. specs/agent-loop.md：废止 R4"静默降级为空参数"，在 R3 增加第六出口"参数非法"；specs/provider.md 增加映射表。
硬约束：零新增依赖（不要引入 ajv/zod）；不改已有事件和字段；npm test、npm run check 全绿。
完成后输出：改动文件、测试结果、复现脚本 B 项的新输出。
