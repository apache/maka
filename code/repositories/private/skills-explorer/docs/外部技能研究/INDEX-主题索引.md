# 主题索引 — 天才 skill 跨仓库能力聚合

> 主入口。按能力域聚合 7 仓库 182 个 skill，跨仓库对照。
> 链接直达 GitHub；本地浅克隆已于 2026-09-01 移除，深啃时按链接重新克隆。
> 图例：★ 强推（改写入库首选）　○ 可选（按需取）　✗ 水分（留存阅读）　[DUP] categories 已有

---

## 1. 多 Agent 编排与并行 ★最独特增量

- ★ [subagent-driven-development](https://github.com/obra/superpowers/tree/main/skills/subagent-driven-development) — 子 agent 驱动执行独立任务（superpowers）
- ★ [review-work](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/review-work) — 5 并行子 agent 评审（Oracle/质量/安全）（oh-my-openagent）
- ★ [hyperplan](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/.agents/skills/hyperplan) — 对抗式 5 hostile agent 规划（oh-my-openagent）
- ○ [dispatching-parallel-agents](https://github.com/obra/superpowers/tree/main/skills/dispatching-parallel-agents) [DUP] — 2+ 独立任务并行派发（superpowers）
- ○ [teammode](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-codex/plugin/components/teammode/skills/teammode) — Codex 团队多线程协作（Codex 绑定）
- ○ [security-research](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/.agents/skills/security-research) — 3 猎手 + 2 PoC 工程师（oh-my-openagent）
- ✗ [pre-publish-review](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/.agents/skills/pre-publish-review) — 16-agent 发布门（omo 自家运维）
- ○ [dag-library](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-senpi/skills/dag-library) — DAG 定义存库一两行复用运行，周期审计/夜间流水线（senpi 绑定，2026-08-19 新增）

## 2. 代码评审与质量门

- ★ [code-review](https://github.com/mattpocock/skills/tree/main/skills/engineering/code-review) — 双轴评审固定点以来的变更（mattpocock）
- ★ [requesting-code-review](https://github.com/obra/superpowers/tree/main/skills/requesting-code-review) — 任务完成/合并前请求评审（superpowers）
- ★ [receiving-code-review](https://github.com/obra/superpowers/tree/main/skills/receiving-code-review) — 接收反馈决定采纳与否（superpowers）
- ★ [ce-code-review](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-code-review) — 结构化评审 bug/回归/测试/标准（compound）
- ★ [autoplan](https://github.com/garrytan/gstack/tree/main/autoplan) — 自动跑全套评审 pipeline（gstack）
- ★ [plan-ceo-review](https://github.com/garrytan/gstack/tree/main/plan-ceo-review) / [plan-design-review](https://github.com/garrytan/gstack/tree/main/plan-design-review) / [plan-eng-review](https://github.com/garrytan/gstack/tree/main/plan-eng-review) / [plan-devex-review](https://github.com/garrytan/gstack/tree/main/plan-devex-review) — 四角色 plan 评审（gstack）
- ○ [ce-resolve-pr-feedback](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-resolve-pr-feedback) — 解决 PR 评审反馈（compound）
- ○ [ce-doc-review](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-doc-review) — 角色视角评审需求/计划（compound）
- ○ [design-review](https://github.com/garrytan/gstack/tree/main/design-review) / [devex-review](https://github.com/garrytan/gstack/tree/main/devex-review) / [review](https://github.com/garrytan/gstack/tree/main/review) — 实现/PR 评审（gstack）
- ○ [plan-tune](https://github.com/garrytan/gstack/tree/main/plan-tune) — 自调问题敏感度 v1（gstack）

## 3. 规划、规格与决策

- ★ [spec](https://github.com/garrytan/gstack/tree/main/spec) — 五阶段把模糊意图变精确可执行规格（gstack）
- ★ [wayfinder](https://github.com/mattpocock/skills/tree/main/skills/in-progress/wayfinder) — 超大任务规划为投资地图（mattpocock）
- ★ [ce-plan](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-plan) / [ce-work](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-work) — 结构化计划 / 端到端执行（compound）
- ★ [ce-strategy](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-strategy) — 创建/更新 STRATEGY.md（compound）
- ★ [ulw-plan](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-codex/plugin/components/ultrawork/skills/ulw-plan) / [ulw-loop](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-codex/plugin/components/ulw-loop/skills/ulw-loop) — ultrawork 规划 + goal 循环（oh-my-openagent）
- ★ [office-hours](https://github.com/garrytan/gstack/tree/main/office-hours) — YC Office Hours 风格评估（gstack）
- ★ [ce-pov](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-pov) — 对外部输入给决断（compound）
- ○ [writing-plans](https://github.com/obra/superpowers/tree/main/skills/writing-plans) [DUP]（superpowers）
- ○ [to-prd](https://github.com/mattpocock/skills/tree/main/skills/engineering/to-prd) / [to-issues](https://github.com/mattpocock/skills/tree/main/skills/engineering/to-issues) / [prototype](https://github.com/mattpocock/skills/tree/main/skills/engineering/prototype) [DUP]（mattpocock）
- ○ [loop-me](https://github.com/mattpocock/skills/tree/main/skills/in-progress/loop-me) — 规格考问（实验）

## 4. 调试、根因与技术债

- ★ [investigate](https://github.com/garrytan/gstack/tree/main/investigate) — 系统性调试 + 根因（gstack）
- ★ [debugging](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/debugging) — 跨任意语言/二进制运行时调试（oh-my-openagent）
- ★ [tech-debt-audit](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/.agents/skills/tech-debt-audit) — 9 维 AST-grep 技术债审计（oh-my-openagent）
- ○ [systematic-debugging](https://github.com/obra/superpowers/tree/main/skills/systematic-debugging) [DUP]（superpowers）
- ○ [diagnosing-bugs](https://github.com/mattpocock/skills/tree/main/skills/engineering/diagnosing-bugs) [DUP]（mattpocock）
- ○ [ce-debug](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-debug) — bug 诊断循环（compound）

## 5. 执行、验证与 QA

- ★ [implement](https://github.com/mattpocock/skills/tree/main/skills/engineering/implement) — 基于 PRD/issues 实现（mattpocock）
- ★ [ce-dogfood](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-dogfood) — diff 范围浏览器自测 QA（compound）
- ★ [visual-qa](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/visual-qa) — UI 改动后视觉验证（oh-my-openagent）
- ★ [no-mistakes](https://github.com/kunchenguid/no-mistakes/tree/main/skills/no-mistakes) — 代码变更验证 pipeline review/test/lint（no-mistakes）
- ○ [verification-before-completion](https://github.com/obra/superpowers/tree/main/skills/verification-before-completion) [DUP] / [executing-plans](https://github.com/obra/superpowers/tree/main/skills/executing-plans) [DUP]（superpowers）
- ○ [ce-test-browser](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-test-browser) — 分支影响页面浏览器测试（compound）
- ○ [qa](https://github.com/mattpocock/skills/tree/main/skills/deprecated/qa) / [qa-only](https://github.com/garrytan/gstack/tree/main/qa-only) / [health](https://github.com/garrytan/gstack/tree/main/health)

## 6. 重构、简化与代码洁净

- ★ [remove-ai-slops](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/remove-ai-slops) — 去 AI 生成代码坏味（oh-my-openagent）
- ★ [ce-simplify-code](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-simplify-code) — 简化近期改动（compound）
- ★ [ast-grep](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/ast-grep) — 25 语言 AST 搜索/重写（oh-my-openagent）
- ★ [programming](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/programming) — 严格类型编程哲学 py/rs/ts/go（oh-my-openagent）
- ○ [refactor](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/refactor) — 智能重构（oh-my-openagent）
- ○ [remove-deadcode](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/.agents/skills/remove-deadcode) — LSP 验证安全删死码（oh-my-openagent）
- ○ [lsp](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-codex/plugin/components/lsp/skills/lsp) / [lsp-setup](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/lsp-setup)（oh-my-openagent）
- ○ [migrate-to-shoehorn](https://github.com/mattpocock/skills/tree/main/skills/misc/migrate-to-shoehorn) — as 断言迁移（mattpocock，特定库）

## 7. Git、分支与发布

- ★ [using-git-worktrees](https://github.com/obra/superpowers/tree/main/skills/using-git-worktrees) — worktree 隔离特性工作（superpowers）
- ★ [finishing-a-development-branch](https://github.com/obra/superpowers/tree/main/skills/finishing-a-development-branch) — 实现完成后整合决策（superpowers）
- ★ [resolving-merge-conflicts](https://github.com/mattpocock/skills/tree/main/skills/engineering/resolving-merge-conflicts) — 合并/rebase 冲突解决（mattpocock）
- ★ [git-guardrails-claude-code](https://github.com/mattpocock/skills/tree/main/skills/misc/git-guardrails-claude-code) — hooks 拦截危险 git 命令（mattpocock）
- ○ [git-master](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-opencode/src/features/builtin-skills/git-master) — 原子提交/rebase/历史搜索（oh-my-openagent）
- ○ [ce-worktree](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-worktree) / [ce-commit](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-commit) / [ce-commit-push-pr](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-commit-push-pr)（compound）
- ○ [ship](https://github.com/garrytan/gstack/tree/main/ship) / [land-and-deploy](https://github.com/garrytan/gstack/tree/main/land-and-deploy)（gstack）
- ○ [careful](https://github.com/garrytan/gstack/tree/main/careful) / [guard](https://github.com/garrytan/gstack/tree/main/guard) / [freeze](https://github.com/garrytan/gstack/tree/main/freeze) / [unfreeze](https://github.com/garrytan/gstack/tree/main/unfreeze) — 破坏命令护栏/目录冻结（gstack）
- ○ [setup-pre-commit](https://github.com/mattpocock/skills/tree/main/skills/misc/setup-pre-commit) — Husky + lint-staged（mattpocock）

## 8. 研究、探索与饱和式调研

- ★ [research](https://github.com/mattpocock/skills/tree/main/skills/engineering/research) — 高信任源研究 + Markdown 沉淀（mattpocock）
- ★ [ulw-research](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/ulw-research) / [ultraresearch](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/ultraresearch) — 饱和式并行调研（oh-my-openagent）
- ★ [ce-ideate](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-ideate) — 接地想法生成与评估（compound）
- ★ [ce-explain](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-explain) — 概念/diff 变密集可视化解释（compound）
- ○ [brainstorming](https://github.com/obra/superpowers/tree/main/skills/brainstorming) [DUP] / [ce-brainstorm](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-brainstorm)
- ○ [ultimate-browsing](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/ultimate-browsing) — 难访问网页升级浏览（oh-my-openagent）
- ○ [coding-agent-sessions](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/coding-agent-sessions) — 编码 agent 会话检索/导出（oh-my-openagent）

## 9. 知识沉淀与 Skill 元方法

- ★ [ce-compound](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-compound) / [ce-compound-refresh](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-compound-refresh) — 沉淀已解问题到 docs/solutions（compound）
- ★ [using-superpowers](https://github.com/obra/superpowers/tree/main/skills/using-superpowers) — skill 发现/使用元方法（superpowers）
- ○ [writing-great-skills](https://github.com/mattpocock/skills/tree/main/skills/productivity/writing-great-skills) [DUP] / [writing-skills](https://github.com/obra/superpowers/tree/main/skills/writing-skills) [DUP]
- ○ [init-deep](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-codex/plugin/skills/init-deep) — 层级 AGENTS.md 知识库（oh-my-openagent）
- ○ [learn](https://github.com/garrytan/gstack/tree/main/learn) — 项目学习管理（gstack）
- ○ [github-triage](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/.agents/skills/github-triage) — 只读 issue/PR 三元分类（oh-my-openagent）

## 10. 写作、文档与内容

- ★ [writing-beats](https://github.com/mattpocock/skills/tree/main/skills/in-progress/writing-beats) / [writing-fragments](https://github.com/mattpocock/skills/tree/main/skills/in-progress/writing-fragments) / [writing-shape](https://github.com/mattpocock/skills/tree/main/skills/in-progress/writing-shape) — 写作三段式：采掘→结构→成文（mattpocock）
- ○ [edit-article](https://github.com/mattpocock/skills/tree/main/skills/personal/edit-article)（mattpocock）
- ○ [ce-polish](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-polish) / [ce-promote](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-promote)（compound）
- ○ [document-generate](https://github.com/garrytan/gstack/tree/main/document-generate) / [document-release](https://github.com/garrytan/gstack/tree/main/document-release)（gstack）
- ○ [make-pdf](https://github.com/garrytan/gstack/tree/main/make-pdf) — markdown→出版级 PDF（gstack）
- ○ [diagram](https://github.com/garrytan/gstack/tree/main/diagram) — 英文/mermaid→图表三元组（gstack）
- ○ [obsidian-vault](https://github.com/mattpocock/skills/tree/main/skills/personal/obsidian-vault)（mattpocock）

## 11. 设计与前端（增量弱，categories 已有强项）

- ○ [design-consultation](https://github.com/garrytan/gstack/tree/main/design-consultation) / [design-html](https://github.com/garrytan/gstack/tree/main/design-html) / [design-shotgun](https://github.com/garrytan/gstack/tree/main/design-shotgun) — 设计咨询/HTML/多变种（gstack）
- ○ [frontend](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-opencode/src/features/builtin-skills/frontend) — 前端 UI/UX（oh-my-openagent，omo 绑定）
- ○ [design-an-interface](https://github.com/mattpocock/skills/tree/main/skills/deprecated/design-an-interface) [deprecated] — 并行多 agent 多版界面（mattpocock）

## 12. 安全模式

- ○ [cso](https://github.com/garrytan/gstack/tree/main/cso) — Chief Security Officer 模式（gstack）
- ○ [security-research](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/.agents/skills/security-research) — 见主题 1（oh-my-openagent）
- ○ [careful / guard / freeze](https://github.com/garrytan/gstack/tree/main/careful) — 见主题 7（gstack）

## 13. ✗ iOS 专用（除非做 iOS）

- ✗ [ios-clean](https://github.com/garrytan/gstack/tree/main/ios-clean) / [ios-design-review](https://github.com/garrytan/gstack/tree/main/ios-design-review) / [ios-fix](https://github.com/garrytan/gstack/tree/main/ios-fix) / [ios-qa](https://github.com/garrytan/gstack/tree/main/ios-qa) / [ios-sync](https://github.com/garrytan/gstack/tree/main/ios-sync)（gstack）
- ✗ [ce-test-xcode](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-test-xcode)（compound）

## 14. ✗ 产品自运维 / 平台绑定（通用性≈0）

**omo 自家运维**：[codex-qa](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/.agents/skills/codex-qa) / [opencode-qa](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/.agents/skills/opencode-qa) / [omomomo](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/.agents/skills/omomomo) / [publish](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/.agents/skills/publish) / [get-unpublished-changes](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/.agents/skills/get-unpublished-changes) / [lcx-contribute-bug-fix](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/lcx-contribute-bug-fix) / [lcx-doctor](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/lcx-doctor) / [lcx-report-bug](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/lcx-report-bug) / [comment-checker](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-codex/plugin/components/comment-checker/skills/comment-checker) / [rules](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-codex/plugin/components/rules/skills/rules) / [pi-goal](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/pi-goal)

**gstack 基础设施**：[gstack-upgrade](https://github.com/garrytan/gstack/tree/main/gstack-upgrade) / [setup-gbrain](https://github.com/garrytan/gstack/tree/main/setup-gbrain) / [sync-gbrain](https://github.com/garrytan/gstack/tree/main/sync-gbrain) / [open-gstack-browser](https://github.com/garrytan/gstack/tree/main/open-gstack-browser) / [setup-browser-cookies](https://github.com/garrytan/gstack/tree/main/setup-browser-cookies) / [pair-agent](https://github.com/garrytan/gstack/tree/main/pair-agent) / [benchmark](https://github.com/garrytan/gstack/tree/main/benchmark) / [benchmark-models](https://github.com/garrytan/gstack/tree/main/benchmark-models) / [canary](https://github.com/garrytan/gstack/tree/main/canary) / [browse](https://github.com/garrytan/gstack/tree/main/browse) / [codex](https://github.com/garrytan/gstack/tree/main/codex) / [skillify](https://github.com/garrytan/gstack/tree/main/skillify) / [landing-report](https://github.com/garrytan/gstack/tree/main/landing-report) / [setup-deploy](https://github.com/garrytan/gstack/tree/main/setup-deploy) / [scrape](https://github.com/garrytan/gstack/tree/main/scrape) / [hackernews-frontpage](https://github.com/garrytan/gstack/tree/main/browser-skills/hackernews-frontpage)

**compound 产品绑定**：[ce-proof](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-proof)(Proof) / [ce-riffrec-feedback-analysis](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-riffrec-feedback-analysis)(Riffrec) / [ce-product-pulse](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-product-pulse) / [ce-sweep](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-sweep) / [ce-setup](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/ce-setup) / [lfg](https://github.com/EveryInc/compound-engineering-plugin/tree/main/skills/lfg)

**harness 绑定**：[start-work](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/shared-skills/skills/start-work)(Prometheus) / [work-with-pr](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/.agents/skills/work-with-pr)(worktree) / [ultrawork](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-codex/plugin/components/ultrawork/skills/ultrawork) / [dev-browser](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-opencode/src/features/builtin-skills/dev-browser) / [agent-browser](https://github.com/code-yeongyu/oh-my-openagent/tree/dev/packages/omo-opencode/src/features/builtin-skills/agent-browser) [DUP]

**实验/已弃用/特定**：[wizard](https://github.com/mattpocock/skills/tree/main/skills/in-progress/wizard) / [scaffold-exercises](https://github.com/mattpocock/skills/tree/main/skills/misc/scaffold-exercises) / [ubiquitous-language](https://github.com/mattpocock/skills/tree/main/skills/deprecated/ubiquitous-language) / [request-refactor-plan](https://github.com/mattpocock/skills/tree/main/skills/deprecated/request-refactor-plan) / [gstack](https://github.com/garrytan/gstack/tree/main/SKILL.md)(router) / [gstack-openclaw-*](https://github.com/garrytan/gstack/tree/main/openclaw/skills/gstack-openclaw-ceo-review)

---

## 深啃优先级建议

| 优先级  | 仓库                                | 理由                                                                     |
| ------- | ----------------------------------- | ------------------------------------------------------------------------ |
| P0 最先 | **superpowers**                     | 1.7MB 纯方法论，6 个新货全是工程闭环精品，与你现有 skill 同源            |
| P0      | **mattpocock/skills**               | 676K 纯 skill，写作三段式 + research + git-guardrails 独特               |
| P1      | **compound**                        | ce-compound/ce-explain/ce-strategy 是知识沉淀独特方法论                  |
| P1      | **gstack**                          | 四角色评审 + office-hours + retro，但 56MB 含大量 iOS/平台水分需筛       |
| P2      | **oh-my-openagent**（含 lazycodex） | ast-grep/debugging/remove-ai-slops 通用，但深度绑 omo 状态机，改写成本高 |
| P3      | **no-mistakes**                     | 主体是 Go CLI，skill 部分参考用                                          |
