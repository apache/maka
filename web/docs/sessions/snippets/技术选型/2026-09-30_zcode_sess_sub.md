# 技术选型 — # 七个 SKILL.md 拆分测绘报告

基路径:`C:\Users\802165\.ai\categor…（截断）

- 标签：技术选型
- 日期：2026-09-30
- 来源：zcode 会话 sess_sub（C:\Users\802165\.ai\categories\03-设计体验与前端应用）
- 置信度：机器初筛候选，采纳前请对照原会话

## 触发上下文（用户最后一问）

你在 Windows(Git Bash)做只读测绘。基础:C:\Users\802165\.ai\categories\03-设计体验与前端应用\

任务:为 7 个大型 SKILL.md 制定"决策入口 + 渐进披露路由"拆分方案。原则:SKILL.md 常驻仅限【触发/边界/工作流骨架/关键决策/禁止项/reference 加载规则/验收】;API 全表、配方代码、案例、模板移入 references/(原文章节原样搬运)。不强拆强相关核心流程;原文不适合拆的如实说"不建议拆"。

逐个(读全文,给精确行号):
1. 07-状态数据与表单/tanstack-query-setu…（截断）

## 结论

# 七个 SKILL.md 拆分测绘报告

基路径:`C:\Users\802165\.ai\categories\03-设计体验与前端应用\`。7 个文件结构一致(frontmatter/工作流/配方章节/Best Practices/Checklist),无冗余过期内容，**无 DELETE,全部建议拆**。行号为实读值(与任务给的差 1,系文末换行)。共通原则：Best Practices=关键决策、Checklist=验收、代码块=配方，前两者 KEEP,后者 MOVE。

## 1. tanstack-query-setup(672 行)
地图：1-8 触发 K | 10-17 工作流 K | 19-23 安装 K | 25-74 Provider M | 76-183 基础查询 M | 185-296 Mutations M | 298-401 乐观更新 M | 403-498 无限查询 M | 500-540 Query Factories M | 542-585 Prefetch+SSR M | 587-617 依赖查询 M | 619-645 并行查询 M | 647-656 Best Practices K | 658-671 Checklist K

refs:`setup-provider.md`(25-74)、`queries-mutations.md`(76-296)、`optimistic-updates.md`(298-401)、`advanced-patterns.md`(403-645;Factories 被 542-585 引用，必须同文件)

骨架：留 1-23、647-671,新增 6 行模式路由表(列表拉取→queries;写操作→mutations;即时反馈→optimistic;分页/SSR/依赖并行→advanced)。加载规则：按场景词定向载入单个 ref。
预计拆后约 70 行。风险：原文无“何时用哪种模式”决策文字，路由表需新写；乐观更新须留 1 行禁止项“onMutate 必须带 snapshot 回滚”。

## 2. zustand-state-builder(650 行)
地图：1-8 K | 10-17 K | 19-26 安装 K | 28-134 基础 Store M | 136-283 Middleware M | 285-413 Slices M | 415-501 Selectors M(与已有 state-selection.md 对账去重，重复则并入/删) | 503-527 React 外访问 M | 529-577 服务端状态集成 M | 579-624 Testing M | 626-635 K | 637-650 K

refs:`stores-and-middleware.md`(28-283)、`slices-pattern.md`(285-413)、`server-state-and-testing.md`(529-624);415-527(Selectors+外部访问)优先并入已有 `state-selection.md`。

骨架：留 1-26、626-650 + 路由表(单域小 store→middleware;大型多域→slices;重渲染治理→state-selection;服务端数据→server-state)。
预计拆后约 70 行。风险：state-selection.md 内容未对账，合并前须去重防同一 selector 知识两处漂移；Slices 是工作流第 5 步载体，entry 需留“何时拆 slice”判断句。

## 3. page-layout-builder(631 行)
地图：1-8 K | 10-18 K | 20-94 Dashboard 模板 M | 96-208 Auth 模板 M | 210-304 Settings 模板 M | 306-357 CRUD 模板 M | 359-453 Sidebar/Header M | 455-488 路由目录树 K(蓝图非代码) | 490-540 状态模式 M | 542-577 骨架屏 M | 579-604 移动端导航 M | 606-615 K | 617-631 K

refs:`template-dashboard.md`、`template-auth.md`、`template-settings.md`、`template-crud.md`(各对应区间)、`navigation-shell.md`(359-453)、`state-loading-responsive.md`(490-604)。

骨架：留 1-18、455-488、606-631 + 4 行模板路由表(点名哪类页面载哪个模板；搭壳→navigation;接数据/骨架屏→state-loading)。
预计拆后约 95 行。风险：description 触发词即四模板名，外移后无路由表会“命中无货”；Dashboard 模板 import Sidebar/Header,navigation 须随 Dashboard 提示加载。

## 4. storybook-setup(617 行)
地图：1-8 K | 10-17 K | 19-29 安装 K | 31-84 main.ts M | 86-166 preview.ts M | 168-301 CSF3 Stories M | 303-354 play 交互 M | 356-437 MDX M | 439-500 测试集成 M | 502-544 Design Tokens M | 546-588 发布 M | 590-599 K | 601-617 K

refs:`configuration.md`(31-166)、`writing-stories.md`(168-354,play 与测试强相关故与 CSF3 同文件)、`mdx-docs.md`(356-437)、`testing-and-publishing.md`(439-500+546-588)、`design-tokens.md`(502-544)。

骨架：留 1-29、590-617 + 路由表(首装→configuration;写 story→writing-stories;文档页→mdx;视觉回归/a11y→testing;部署→publishing)。
预计拆后约 65 行。风险：main.ts 是必经第一步，entry 留 addons 清单一行摘要；play 函数归属只写一处，勿两文件重复。

## 5. hot-reload-optimizer(612 行)
地图：1-8 K | 10-17 K | 19-128 Vite 配置 M | 130-225 Next.js 配置 M | 227-369 Webpack 配置 M | 371-407 ErrorBoundary 示例 M | 409-428 Fast Refresh 导出规则 K(禁止项) | 430-472 CSS HMR M |…（截断）
