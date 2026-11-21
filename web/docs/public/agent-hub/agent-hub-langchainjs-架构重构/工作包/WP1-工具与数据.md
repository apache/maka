# WP1 · 工具与数据（search_evidence / search_catalog / present_recommendation）

**目标**：实现三个工具和数据源。卡片只能引用本轮检索到的证据与商品，价格只来自目录。修复 A-P0-1（引用洗白）。

**依赖**：WP0。**分支**：`refactor/wp1-tools`。**参考实现**：`附录/代码骨架/tools.ts`、`data.ts`

## 归属文件

`apps/agent/src/data.ts`、`tools.ts`、`tools.test.ts`

## 步骤

1. 先写 `tools.test.ts` 的 6 个用例（04 §2 WP1），确认红。
   - 测试里直接 `tool.invoke(toolCall, { configurable, ... })` 不方便时，把校验逻辑抽成纯函数 `assertCausality(messages, input)` 单测。
   - 再写 1 个经 `createAgent + fakeModel` 的集成用例：fakeModel 先 `respondWithTools` 调 present_recommendation（不检索），再检索，再展示，断言出现 error ToolMessage 后成功。
2. `data.ts`：
   - `EVIDENCE` 从 `apps/api/app/evidence.py` 原样迁移（3 条，字段逐字一致）；
   - `CATALOG` 取旧剧本里的 6 个 SKU，并加 `scenes` 字段；
   - 类型从 `@agent-hub/shared` 导入。
3. `tools.ts`：按 02 §3 实现。
   - 检索类工具用 `responseFormat: 'content_and_artifact'`；
   - `present_recommendation` 用 `runtime.state.messages` 取"本轮"（最后一条 HumanMessage 之后），用 `runtime.writer` 输出 `CardEvent.parse(...)`，再输出 `EvidenceEvent.parse(...)` × n；
   - 本轮已有成功的 present_recommendation 时报错"每轮只能展示一次推荐卡片"（05 U10）。
4. 导出 `TOOLS = [searchEvidence, searchCatalog, presentRecommendation]`。

## 验收

- 新测试全绿；`tools.ts` 不 import 任何模型或 HTTP 代码。
- 卡片里的商品字段与 `CATALOG` 深度相等；证据 label 等于 `EVIDENCE[id].source`。

## 不要做

- 不写 agent 装配和翻译层；不改 Python 的 evidence.py（WP9 删）。

## Cursor 提示词

```text
仓库 agent-hub，分支 refactor/wp1-tools（从已合并 WP0 的 main 拉）。
目标：在 apps/agent 实现三个 langchain 工具与数据源，做证据/商品的因果校验。
先读：02-接口契约.md §3、01-目标架构.md §4.1–4.2、工作包/WP1；参考实现 附录/代码骨架/tools.ts、data.ts（可以直接借鉴，但要补测试）。
步骤：
1. 先写 apps/agent/src/tools.test.ts：(a) 本轮未检索就展示 → 抛错含"请先调用 search_evidence"；(b) 引用上一轮（上一条 HumanMessage 之前）检索到的证据 → 抛错；(c) 检索后展示 → writer 依次收到 card、evidence×n，均能 AgentStreamEvent.parse；(d) 卡片 priceFen 等于 CATALOG；(e) search_catalog({scene:'gift'}) 只返回 gift，artifact 不含 scenes；(f) status=error 的检索不算数；(g) 同一轮第二次 present_recommendation 报错；(h) createAgent + fakeModel（from 'langchain'）集成：先违规调用、后检索、再展示，断言中间出现 status=error 的 ToolMessage 且最终成功。先跑确认失败。
2. data.ts：EVIDENCE 从 apps/api/app/evidence.py 逐字迁移；CATALOG 用旧 agent.py 里的 6 个 SKU 并加 scenes。
3. tools.ts：search_evidence、search_catalog 用 responseFormat 'content_and_artifact'（content 给模型、artifact 给校验）；present_recommendation 入参 {scene,title(1-30),reason(1-80),skuIds 1-3,evidenceIds ≥1}，没有价格字段；从 runtime.state.messages 取本轮 artifact 校验，失败 throw（让 ToolNode 回灌），成功从 CATALOG 填商品、FlowerCardPayload.parse，再 runtime.writer 输出 card 与 evidence 事件。
硬约束：契约类型一律从 @agent-hub/shared 导入，不复制；只改归属文件；不加依赖；Node 24 strip-only 语法；pnpm test:agent 全绿。
完成后输出：改动文件、测试结果、本轮界定的实现方式说明。
```
