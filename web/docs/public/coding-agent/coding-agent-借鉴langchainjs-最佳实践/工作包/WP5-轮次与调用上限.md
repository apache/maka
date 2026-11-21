# WP5 · 轮次/调用上限可配置 + 事件

**目标**：修 C5 前半。40 轮熔断可配置、有事件；强制总结那次调用也经过治理。

**langchain 对标**：`agents/middleware/modelCallLimit.ts`、`toolCallLimit.ts` 的 `runLimit` 与 `exitBehavior: 'error' | 'end'`。借"超限时显式事件 + 两种退出方式"，不借线程级计数（我们没有 thread 概念）。

**归属文件**：`src/core/limits.ts`（新）、`src/kernel/config.ts`（加 `maxToolRounds`）；`src/core/agentloop.ts` 只改 `:11` 常量引用；`repl.ts`/`web.html` 各加一个 `limit` 渲染。

**接口依赖**：WP0、WP1（强制总结调用前的 `beforeModel`）。

## 行为

| 项 | 规则 |
|---|---|
| 配置 | `maxToolRounds`，缺省 40，必须是正整数，非法值报错（不静默用默认，沿用 permission 偏离清单的精神） |
| 触发 | 第 N 轮工具执行完后，第 N+1 次仍要求工具 → 先发 `limit{kind:'model_calls', limit:N, behavior:'summarize'}` |
| 强制总结 | 不带 tools 的那次调用前执行 `beforeModel`（WP2 的治理会生效），计入 `modelCalls` |
| 可选工具上限 | `limits.ts` 导出 `toolCallLimitMiddleware({ max, behavior })`，默认不注册 |
| 显示 | repl 一行黄字；web 一行灰字："已达工具轮次上限（40），正在总结" |

## Cursor 提示词

```text
仓库 coding-agent，impls/typescript，分支 feat/wp5-limits（从已合并 WP1 的 develop 拉）。
目标：工具轮次上限可配置，触发时发 limit 事件，强制总结调用也经过 beforeModel。
参考：附带的 02-接口契约.md、工作包/WP5。
1. 先写测试 test/loop.test.ts：
   a. maxRounds=3，假 provider 一直要求工具：第 3 轮后 emit limit{kind:'model_calls',limit:3,behavior:'summarize'}，最后一次请求不带 tools；
   b. 强制总结调用前 beforeModel 被调用（用一个记录型中间件验证）；
   c. kernel/config.ts 读取 maxToolRounds，缺省 40，0/负数/非整数报错。
   先跑确认失败。
2. core/agentloop.ts：MAX_TOOL_ROUNDS 改为 deps.maxRounds ?? MAX_TOOL_ROUNDS；超限分支先 emit limit，再走 beforeModel，再做不带工具的总结调用。
3. 新建 core/limits.ts：toolCallLimitMiddleware({ max, behavior: 'summarize' | 'end' })，默认不注册。
4. kernel/config.ts 增加 maxToolRounds；turn.ts 把它传给 runTurn。
5. repl.ts、web.html renderLog 各加 limit 的一行渲染（只用已有 CSS 类）。
6. specs/agent-loop.md R2 改为可配置并写明事件。
硬约束：缺省行为（40 轮）不变；零新增依赖；npm test、npm run check 全绿。
完成后输出：改动文件、测试结果。
