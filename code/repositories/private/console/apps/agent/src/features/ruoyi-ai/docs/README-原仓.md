# ruoyi-ai-web — 带向量库与向量模型的知识库后台

按群聊截图里的 RuoYi AI Admin 复刻的 RAG 后台：文档 → 解析 → 分片 → 向量 → 索引 → 检索 → 回答，全链路在浏览器里真实跑通，不连后端、不需要 API Key。

![知识库详情](docs/screenshots/knowledge-detail.png)

## 跑起来

```bash
corepack pnpm install   # packageManager 锁 pnpm@12.14.0
corepack pnpm dev       # http://localhost:5173
corepack pnpm test      # 30 个领域层测试
corepack pnpm build     # tsc -b + vite build
```

首次打开会自动种一份「RuoYi AI 知识库」和截图里那份 `启动命令.txt`（哈希模型，离线秒开）。

## 技术栈

React 19.3 · TypeScript 7.0 · Vite 8.3 · React Router 8.4 · Zustand 5 · 原生 Fetch · Zod 4.6 · Tailwind 4.3 · shadcn CLI 4（base-nova / Base UI）· pnpm 12.14。

## 它到底做了什么

| 层 | 实现 | 位置 |
| --- | --- | --- |
| 分片 | 按标点/换行切，超长硬切，重叠兜底 | `src/lib/domain/chunk.ts` |
| 向量模型 | `Embedder` 接口：bge-small-zh-v1.5（512 维，真语义，transformers.js）/ 本地哈希（256 维，离线兜底） | `src/lib/domain/embed.ts` |
| 向量索引 | 暴力余弦 + topK，按 kbId 隔离，删除/重建幂等 | `src/lib/domain/index.ts` |
| 解析状态机 | 待解析 → 解析中 → 已解析/失败，失败不抛异常、可重试 | `src/lib/domain/ingest.ts` |
| 检索 | 空白查询短路、topK 夹取、维度校验 | `src/lib/domain/retrieve.ts` |
| 回答 | 无 LLM：只把命中分片拼成带引用的答案，没命中就明说没有 | `src/lib/domain/answer.ts` |
| 持久化 | IndexedDB 单库键值存 KB/附件/分片/会话，隐私模式降级为内存 | `src/lib/db.ts` |

**为什么没有 LLM**：需求是「向量库 + 向量模型」。接 LLM 要 API Key，接不上就无法验证；现在的回答是可验证的接地结果，且「没有命中」这一消融对照能直接看到。

## 页面

| 路由 | 内容 |
| --- | --- |
| `/` | 概览：库/附件/分片/维度 + 最近附件 |
| `/knowledge` | 知识库列表、新建、删除 |
| `/knowledge/:id` | 文件管理（上传/重新解析/查看源文件/删除）、检索测试、知识库配置 |
| `/knowledge/:id/chunks/:assetId` | 分片原文，检索命中的就是这里 |
| `/chat` | 会话列表、消息、引用卡片、知识库选择 |

![检索测试](docs/screenshots/retrieval-test.png)
![聊天](docs/screenshots/chat.png)

## 验证记录（2026-10-17，本机）

- `pnpm test`：6 个文件 30 个用例通过，覆盖分片边界、归一化、跨库隔离、维度不一致、重复解析、模型抛错回滚、无命中消融。
- `pnpm build`：TS 7 `tsc -b` + Vite 8 构建通过。
- 无头 Chrome（1440×900）逐页截图核对，图片在 `docs/screenshots/`。
- 切到 bge 模型后重新解析成功；`怎么启动` 类查询 352ms 命中，`前端怎么起服务` 这种没有词面重合的问法也能召回（相似度 0.302）。

## 已知上限（不是 bug，是刻意的）

- **暴力余弦**：≤1 万条 512 维分片毫秒级；再大要换 HNSW 或服务端索引，接口不变。
- **bge 首次 24MB**：从 HuggingFace 拉取，加载期间解析状态会停在「解析中」；失败会落成「失败」并保留原因。
- **构建产物含 26MB wasm**：transformers.js 的 onnxruntime wasm 是懒加载资源，不进首屏，但会进 `dist/`。
- **Embedding 在主线程**：大文件解析会短暂卡顿；要消除就挪 Worker。
- 没做：多租户 / RBAC / MCP / 工作流 / 厂商管理 / 标签页栏（截图有，但与本次目标无关）。
