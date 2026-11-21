# ADR-0004：A2UI 卡片改为工具调用，并做证据与商品的因果校验

- 状态：草案
- 推翻：05 评审 A-P2-3 中"保留 Markdown 围栏、不做工具即 UI"的 YAGNI 判断

## 背景

现状里，模型输出 ```` ```flower-card ```` 围栏 JSON，由 `_StreamStateMachine` 扣留解析。证据 `evidenceRefs` 被服务端丢弃，再按场景静态注入（`llm.py:160`）。结果有两个：

- 卡片上展示的"推荐依据"与模型的推理无关（引用洗白）；
- 价格、商品名由模型生成，可能是幻觉。

当时判断 YAGNI 的前提是"没有智能体循环"：围栏解析失败只能丢弃，做成工具也得不到额外好处。ADR-0003 之后前提变了——校验失败可以回灌给模型，让它自我修正。

## 决定

1. 卡片 = 工具 `present_recommendation({scene,title,reason,skuIds,evidenceIds})`。
2. 证据 = 工具 `search_evidence`，商品 = 工具 `search_catalog`，两者都用 `content_and_artifact`：
   - content 给模型看；
   - artifact 给服务端校验。
3. 因果校验：`evidenceIds` 必须 ⊆ 本轮 `search_evidence` 结果，`skuIds` 必须 ⊆ 本轮 `search_catalog` 结果。不满足就抛错，由 ToolNode 回灌。
4. 商品字段（名称、价格、类型、emoji）只从目录填充；schema 里没有价格字段。
5. 工具通过 `runtime.writer` 输出 card、evidence 事件。事件契约不变，前端零改动。

## 后果

- 删除围栏状态机和 `SCENE_EVIDENCE`。
- 卡片在工具执行完成后一次性出现（旧模式也是整块出现，05 U8）。
- 每轮至少 4 次模型调用（检索证据 → 查目录 → 展示 → 作答）。真实模型可以在一次调用里并行发出两个检索，降到 3 次。
- 成本和延迟会上升，用 `modelCallLimitMiddleware(runLimit:8)` 封顶。
