# RuoYi AI 风格 RAG 后台（React 19）需求澄清

> 2026-10-17 · 第 2 轮（已确认）· 基线：群聊截图 4 张（RuoYi AI Admin `:5666` / RuoYi-AI `:5180`，截于 2026/10/16）
> 实施结果见 [code/agents/ruoyi-ai-web](../../code/agents/ruoyi-ai-web/README.md)

## 一、已定口径

| # | 问题 | 结论 | 依据 |
| --- | --- | --- | --- |
| 1 | 技术栈 | React 19.3.1 · TypeScript 7.0.2 · pnpm 12.14.0 · Vite 8.3.4 · React Router 8.4.0 · Zustand 5.0.15 · 原生 Fetch · Zod 4.6.7 · Tailwind 4.3.3 · shadcn CLI 4.22.0 | 用户拍板；版本已在 registry 核实 |
| 2 | 产品形态 | 知识库 RAG 后台：概览 + 知识库列表/详情（文件管理 / 检索测试 / 知识库配置）+ 分片页 + 聊天 | 截图 |
| 3 | 核心链路 | 文档 → 解析 → 分片 → 向量 → 索引 → 检索 → 回答 | 需求「带向量库、向量模型」 |
| 4 | 数据模型 | KnowledgeBase → Asset（附件）→ Chunk（分片，向量为派生字段） | 截图表格字段 |
| 5 | 解析状态机 | 待解析 → 解析中 → 已解析 / 失败；支持「重新解析」「全部重新解析」 | 截图按钮与状态列 |
| 6 | 视觉 | 暗色、左侧双栏导航、高密度表格 | 截图 |
| 7 | 交付边界 | 知识库三屏 + 聊天 + 概览；侧栏其余模块禁用占位 | 用户拍板（Q1=A） |
| 8 | 向量模型 | bge-small-zh-v1.5（512 维，真语义）为主，本地哈希（256 维）兜底，同一 `Embedder` 接口 | 用户拍板（Q2=D） |
| 9 | 后端与持久化 | 纯前端 + IndexedDB；不引入 `/api` 中间件 | 用户拍板（Q3=A） |
| 10 | 测试 seam | Vitest 只测领域层：`chunkText` / `embed` / `VectorIndex.search` / `ingest` / `retrieve` / `composeAnswer`；不写页面测试 | 用户拍板（Q4=A） |
| 11 | 落地路径 | `code/agents/ruoyi-ai-web`，复用 `interview/code/liliya/web` 的同栈骨架 | 用户拍板（Q5=A） |
| 12 | 回答生成 | 无 LLM：命中分片拼装 + 引用；无命中显式说明。检索测试页提供「关闭检索」消融对照 | 用户拍板（Q2 的必然结果，避免空 API Key 阻塞） |

## 二、待拍板

无。第 2 轮已收敛。

## 三、明确不做（已转正）

| 排除项 | 原因 |
| --- | --- |
| 多租户 / RBAC / 登录体系 | 截图有入口，与「向量库 + 向量模型」目标无关 |
| MCP / 工作流 / 厂商管理 / 智能体编排 | 同上；导航保留禁用占位 |
| 真 Qdrant / Milvus / pgvector | 浏览器内暴力余弦在 ≤1 万分片足够；索引接口已隔离，可替换 |
| 移动端 / 多主题 / i18n | 后台桌面端演示 |
| 页面级组件测试（RTL/jsdom） | 手点 + 无头截图核对，成本更低 |
| 代码分割 / 虚拟滚动 / 性能调优 | 数据量上限内无收益；wasm 已天然懒加载 |
| 标签页栏（tagsView） | 截图有，但纯 chrome，不承载业务状态 |

## 四、开发影响面与验证

- 新项目 `code/agents/ruoyi-ai-web`：6 条路由、2 个 store、6 个领域模块（各带测试）、复用 liliya 的 `vite.config.ts` / `tsconfig*` / `components.json` / 10 个 UI 原子件。
- 验证等级 L2 已执行：`pnpm test`（6 文件 / 30 用例全绿）、`pnpm build`（`tsc -b` + `vite build` 通过）、无头 Chrome 1440×900 逐页截图。
- 真实模型验证：切换 bge-small-zh-v1.5 后重新解析成功，`前端怎么起服务` 这种无词面重合的查询命中（0.302，352ms）。
