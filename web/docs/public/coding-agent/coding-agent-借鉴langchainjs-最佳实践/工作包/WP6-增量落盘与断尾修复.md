# WP6 · 增量落盘 + 加载时断尾修复

**目标**：修 C5 后半。进程崩溃或被杀时，本轮已产生的消息不丢；重载的会话总是合法的消息序列。

**langchain 对标**：LangGraph checkpointer（每一步后持久化状态）。只借"每步落盘"的时机，不借 checkpointer 抽象和线程 id。

**归属文件**：`src/core/turn.ts`（落盘与断尾修复）、`src/core/session.ts`（`load` 后修复）。

**接口依赖**：WP0（`TurnDeps.onMessage`）。

## 现状

- `turn.ts:24` `appendSince()` 把 `app.messages.slice(mark)` 一次性写盘，只在 `:86`（出错）和 `:90`（正常结束）调用。进程被杀 → 整轮丢失。
- `turn.ts:73-85` 的断尾修复只在本进程的 catch 分支里跑；`session.ts:113` 的 `load()` 读到断尾文件时不修。
- `session.ts:93` 已有 `checkpoint()`，`load()` 以最后一个 `context_checkpoint` 为起点（保留）。

## 步骤

1. 把 `turn.ts:73-85` 提取为纯函数 `repairDanglingToolCalls(messages, from = 0): ChatMessage[]`（返回补上的占位消息），放 `core/session.ts` 或新 `core/repair.ts`，文案不变：`（本轮中断，未取得执行结果；请先检查实际状态）`。
2. 用户消息 push 后立刻 `store.append`；`runTurn` 通过 `deps.onMessage` 每 push 一条 assistant/tool 消息就 `store.append`。
3. 删除 `appendSince`；catch 分支里补的占位消息也逐条 append。
4. `load()` 返回前调用 `repairDanglingToolCalls(messages)`；补出来的占位**只在内存**，下一次 append 时自然落盘。
5. 写失败沿用现有"忽略"策略，不中断对话。

## Cursor 提示词

```text
仓库 coding-agent，impls/typescript，分支 feat/wp6-incremental-persist（从已合并 WP0 的 develop 拉）。
目标：会话消息逐条落盘；加载会话时修复悬空的 tool_calls。
参考：附带的 01-目标架构.md 不变式 I2、05-风险与不确定点.md R6/R7/R8/R13、工作包/WP6。
1. 先写测试（新建 test/persist.test.ts）：
   a. 工具执行时抛错：会话文件里已有用户消息、assistant(tool_calls) 和占位 tool 消息；
   b. 正常一轮结束：文件中每条消息只出现一次（不重复写）；
   c. 手工构造一个以 assistant(tool_calls) 结尾、没有 tool 回应的 .jsonl，load() 后序列末尾有占位 tool 消息；
   d. 写入一个 context_checkpoint 后再追加消息，load() 结果 = checkpoint + 后续消息。
   先跑确认失败。
2. 把 core/turn.ts 73-85 行的断尾修复提取为纯函数 repairDanglingToolCalls(messages, from)，占位文案保持不变。
3. 用户消息 push 后立即 app.store.append；给 runTurn 传 onMessage 回调，每产生一条消息就 append；删除 appendSince 及其两处调用。
4. core/session.ts 的 load() 返回前调用 repairDanglingToolCalls。
5. specs/session-turn.md 更新落盘时机；在 docs 同步清单登记其他四版待同步。
硬约束：会话文件格式不变（type:'message' / 'context_checkpoint'）；写失败不抛；零新增依赖；npm test、npm run check 全绿。
如果 agentloop.ts 还没有调用 deps.onMessage，只在 agentloop 每个 messages.push 后加一行 deps.onMessage?.(m)，不改其他逻辑（WP1 在并行重构）。
完成后输出：改动文件、测试结果。
