# coding-agent × langchain.js：架构最佳实践评审与并行开发包

> 评审对象：`ggbdpq/coding-agent` **develop @ `bbac303`**（TypeScript 参考实现 `impls/typescript/`）
> 参照系：`langchain-ai/langchainjs`（langchain 1.5.x / @langchain/core 1.2.x）`libs/langchain/src/agents/**`、`libs/langchain-core/src/messages/**`、`internal/standard-tests/**`
> 用途：交给 Cursor / ZCode 等编码代理**并行开发**。每个工作包都写明了归属文件、接口、验收和可直接粘贴的提示词。

## 一页结论

1. **借语义，不引依赖。** coding-agent 的卖点是"核心零依赖手写、五语言同构"。引入 `langchain` 会同时毁掉这两点。所以只借 langchain.js 1.x 的**四个设计决定**，用约 400 行 TS 自己实现：
   - **每次模型调用前都有控制点**：中间件钩子 `beforeModel / afterModel / wrapToolCall`；
   - **错误是一等公民**：`invalid_tool_call`、`finish_reason`，不再静默吞掉；
   - **人工审批有粒度**：HITL 的 `interruptOn` 按工具配置，不是一键全开；
   - **逐步检查点**：checkpointer 每一步落盘，不是一轮结束才落盘。
2. **develop 上 5 个问题仍然成立**（下表）。它们有一个共同根因：**所有横切逻辑都只挂在"轮"这一层，而一轮里最多有 41 次模型调用。**
3. **保留并写进规范的长板**：
   - 只在第一个字节到达前重试（比 langchain 的 `modelRetryMiddleware` 更严谨）；
   - 中断后的断尾修复；
   - specs → conformance → 五版的裁决链；
   - Plan Mode 拒绝写操作；
   - 写目录白名单。

| # | 问题 | develop 证据 | 对标 langchain.js | 工作包 |
|---|---|---|---|---|
| C1 | 上下文治理只在轮开始前跑一次，轮内可冲破上限 | `core/turn.ts:32` 只在 runUserTurn 开头判断；`agentloop.ts:30` 循环内没有任何治理 | `summarizationMiddleware` / `contextEditingMiddleware` 挂在 `beforeModel` | WP1 + WP2 |
| C2 | compact 生成摘要时丢掉了工具参数和工具结果 | `core/compact.ts:41` 只写成 `(tool_calls: N 个)` | summarization 保留 AI/Tool 消息配对 | WP2 |
| C3 | 非法 JSON 参数静默变成 `{}`；输出被截断（finish_reason=length）时不识别 | `agentloop.ts:45-51`、spec R4；`providers/openai.ts:80` 声明了 finish_reason 字段但从未使用 | `invalid_tool_call` 内容块；`toolErrorMiddleware` | WP3 |
| C4 | 审批只有"允许一次"和"本会话全部允许"两档；想少点几次只能整体放开（含 bash）。这是 permission R3 锁定的有意设计，不是 bug，WP4 只做增量 | `core/permission.ts:25` `yoloRef.value = true` | `humanInTheLoopMiddleware({ interruptOn: { tool: … } })` | WP4 |
| C5 | 40 轮熔断无事件，强制总结那次调用也绕过治理；会话只在轮末落盘，进程崩溃会丢掉整轮 | `agentloop.ts:101-107`；`turn.ts:86,90` `appendSince()` | `modelCallLimitMiddleware` / `toolCallLimitMiddleware` 的 `exitBehavior`；checkpointer | WP5 + WP6 |

## 文档目录

| 文档 | 内容 |
|---|---|
| [00-评审：借鉴什么、不借什么](00-评审-借鉴什么不借什么.md) | 对照表、长板、明确不做的 |
| [01-目标架构](01-目标架构.md) | 分层落点、中间件管线、消息完整性不变式、ADR-003 草案 |
| [02-接口契约（WP0）](02-接口契约.md) | **所有工作包共用的类型**，必须最先合并 |
| [03-并行开发计划](03-并行开发计划.md) | 依赖图、文件归属矩阵、合并顺序、分支命名 |
| [04-测试与验收](04-测试与验收.md) | 每个包先写红灯测试、conformance 新场景、五语言同步策略 |
| [05-风险与不确定点](05-风险与不确定点.md) | 置信度、待验证假设 |
| 工作包/WP0–WP7 | 每包一份：目标、文件、步骤、验收、**Cursor 提示词** |
| [附录/复现脚本](附录/README.md) | 离线复现脚本、基线输出和合并后预期 |

## 怎么用

1. **先合并 WP0**（只有类型、ADR 和规范草案，约半天）。
2. **第一批并行**：WP1、WP3、WP4、WP6、WP7 由不同代理同时开发。这几个包的归属文件基本不重叠，交叉处只允许约定的一行接线（见 03）。
3. **第二批**：WP2、WP5 基于 WP1 的中间件接口开发。
4. 每个包的合并门槛：
   - `npm test` 全绿；
   - 包内新增测试全绿；
   - `node conformance/run.mjs <新场景>` 在 TS 版 PASS（其余四版先登记为"允许偏差"）。
