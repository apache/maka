# AI识别客户方案评审中心：ReviewHarness 建造与演示

> 由 2 份 AI 会话沉淀合并 · 工作日期 2026-09-18 ~ 09-28（建造约 09-18 后~09-24，使用与演示 09-28）
> 来源：《AI音频识别客户方案评审中心ReviewHarness设计与实现.md》《AI识别客户方案评审中心访问入口与演示逐字稿.md》

## 一句话结论

在 ai-customer-recognition-node-btf 仓库从零构建「产品演示 / Trace / Lineage / Contract」四位一体的 Review Harness（29 文件 +4818 行，core 零改动，全门禁通过），并于 09-28 完成入口定位、全链路实测与跨职能演示逐字稿产出。

## 入口与开关（09-28 实测）

- 项目：`E:\Projects\backend\node\ai-customer-recognition-node-btf`（Fastify，端口 8089）。
- 页面入口：`http://127.0.0.1:8089/ai-customer-recognition/mock-pages/ai-customer-recognition-review/`（实测 200）。
- API：`/api/ai-customer-recognition/review-demo/*` 共 6 接口，实测全 `code:0`。
- **不对称坑（重要）**：静态页插件无条件注册，API 路由被 `AI_CUSTOMER_RECOGNITION_REVIEW_DEMO_ENABLED=true`（`.env:96`）门控默认关——「页面能开 ≠ 功能可用」。
- 演示模式语义：stable=全 mock 断网可演示；real=真 FFmpeg+ASR，失败如实展示（诚实失败）。Contract tab 的琥珀色 `Production Draft` 是未实现提案标记。

## Harness 设计与实现

- 交付：提交 `03756ce`（develop 分支，29 文件 +4818 行）；后端 8 文件 `capabilities/mock-lab/review-demo.*.ts`（单文件 ≤429 行），前端 14 文件 `mock/ai-customer-recognition-review/`；门禁 contracts 21/21、unit 116/116、self-test 30/30，core 零改动。
- 关键决策：Harness 自编排只复用叶子能力，真实依赖经 `module.ts` 组合根注入；服务端零延迟 + 前端按最小可视时长回放真实数据；`demoRunId` 格式 `review_demo_yyyymmdd_nnnn`（实测样例 `review_demo_20260924_0001`）；`chaos=asr_failure` 仅 stable 生效。
- 真值防线：expected 只在 evaluator 步骤读取；单测断言识别器入参序列化不含 `expected*` 等字段；Trace 统一脱敏（token/secret/key/password/credential → `***`）。
- 踩坑：Fastify 路由漏 prefix 静默落根路径（`printRoutes()` 探针定位）；use-case 740 行超 500 上限拆出 file-pipeline；`.env` 被仓库跟踪但按边界不提交。
- 可移除性：harness 可按删除清单整体移除，生产链路零改动。

## 演示逐字稿（09-28，约 555 字）

结构：开场 30s → 演示 1min → 分工 45s → 收尾 15s。演示段走 stable 模式注入 `chaos=asr_failure` 展示失败如实处理；后端架构段切换 `docs/图解/调用时序.html`。

## 遗留

- Real Mode 只验证了诚实失败路径（CLIP_FAILED），本机无 FFmpeg/COS。
- 换机 clone 需手动补 `.env` 开关。
