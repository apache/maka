# 审计轨台账

> #3522 文档审计切片：逐组核对文档与代码，修正漂移、补 last_verified。零漂移组按先例只留核对记录。

### PR-001 ｜ #4345 docs(architecture): audit bot onboarding runtime
- 日期 / 链接：2026-08-31 提交 / https://github.com/apache/maka/pull/4345
- 轨道与来源：审计轨，#3522 的 Bots 组（`docs/architecture/bot-onboarding-runtime.zh-CN.md`）
- 动机：Bots 文档与当前 Desktop 引导流程和 `@maka/runtime/bots` 实现漂移
- 改动：QQ 扫码引导纳入覆盖；补上 connected-but-unhealthy 的 `warning` 快照字段；删除已不存在的 Playwright journey 描述
- 验证：对照 `packages/core/src/bot-onboarding.ts`、`apps/desktop/src/main/bot-onboarding-main.ts`、`qq-bot-scan-login.ts`、`packages/runtime/src/bots/bot-registry.ts`、Feishu/WeCom 关闭路径和 `settings-bots-onboarding` E2E fixture（基于 upstream/main，提交前确认无新提交）
- 提交后果：**open（截至 2026-09-01），未合并**，无 review 无评论。参照：同系列 #3523 当天 1.5h 合并、#3555 当天 19min 合并
- 经验一条：审计轨 PR 模板里「声明→命令→结果」验证表是标配，#4345 的 Verification 已用此格式；下次从提交当天就记进本文档，不等事后补

### PR-009 ｜ #4518 docs(architecture): audit Recovery and resume group
- 日期 / 链接：2026-09-02 / https://github.com/apache/maka/pull/4518
- 轨道与来源：#3522 审计轨 A1 组（Recovery and resume，7 份），先评论声明 slice 再动工
- 动机：该组文档被 #3741/#4173/#4174/#3506 等大重构碰过，且 #4286（08-31）刚把 `PROVIDER_REPLAY_PROJECTION_VERSION` 从 1 升到 2
- 改动：ADR 3 处（`tool_recovery_decided` → 实际是 `actions.toolRecovery` 的 `maka.tool.recovery_decision` envelope 走原子 recovery-bundle 事务；`reconcile_required` → 实际是 `indeterminate`+`requiresReconciliation`/terminal `parked`；journal 状态补 `recovery_completed|recovery_parked`）；账本与 phase3/4 设计各 1 处（投影版本 1→2）；架构对中英各 2 处（`redo_disabled_pending_cas` → durable 的 `reconcile_matches_prior_state`）+ 双语 `last_verified: 2026-09-02`
- 验证：所有被引用符号/路径逐个 grep 落实（含"确认不存在"的 3 个名字）；追踪 issue 的 5 个漂移 grep 配方 0 命中；双语章节结构 1:1；format/asf 过
- 提交后果：open
- 经验一条：审计"无改动"文档也要留证据链（哪个文件哪一行核对了什么），PR 表格里的每个 ✓ 都要能指到 grep；文档自称"冻结"的常量要先查 git -S 再判漂移——#4286 就是两天前刚升的

<!-- 新记录追加在这里 -->

### PR-014 ｜ #4794 docs: audit Model access group（审计轨 A5）
- 日期 / 链接：2026-09-04 / https://github.com/apache/maka/pull/4794 （分支 docs/audit-model-access，自当日 upstream/main ece69ab3e 切出）
- 动机：#3522 审计轨 A5 组（2 份文档）无人认领、体量最小；原槽 03 的 A3 已被 moneycat957 认走，顺位提上来填槽 02
- 改动：两份文档补标准 frontmatter（last_verified 2026-09-04）；`model-metadata-firstscreen-optimization.md` 三处实改——Problem 段加"已落地"状态注（EN+ZH，方案实测已实现，原文现在是时态漂移）、引用文件名 `chat-model-selection.ts` 改为实际存在的 `shell-chat-model-selection.ts`（EN+ZH）；`openai-responses-incremental-transport.md` 零漂移只加 frontmatter
- 验证：全部符号 grep 落到行号（promptCacheKey/turn 级 lane/endLane/5 分钟冷却/sdk.response.messages；onboarding:getSnapshot/hasSecret: false/无元数据启动链追到 shell-chat-model-selection 零运行时 import）；六个漂移 grep 配方两文档零命中；format:check 1942 文件过；check:asf-headers 仅报本地未跟踪 .gitkeep（已在 PR 里如实写明）
- 提交后果：open，等审核
- 经验一条：**审计"设计/提案"文档先判断方案落地没有**——落地了的文档 Problem 段会整体变成时态漂移，加一条带核验日期的状态注比重写正文便宜且诚实；引用的文件名要 `ls` 实证（chat-model-selection 实际叫 shell-chat-model-selection），frontmatter 惯例跟 #4345（无则加）和 #4518（有则更新）对齐

### PR-016 ｜ #4798 docs: audit Provenance records group（审计轨 A11）
- 日期 / 链接：2026-09-04 / https://github.com/apache/maka/pull/4798 （分支 docs/audit-provenance-a11）
- 动机：剩余审计组里最小的（1 份），先易后难清轨
- 改动：code-origin-audit.md 只补 frontmatter（零漂移）。历史 provenance 报告的时点内容不改写，只核现状主张：锚点提交存在、LICENSE 六类条目在位、§4(b)/opencode 头注释在位、"已从 main 消失"抽查属实、生成物 untracked 属实、漂移 grep 零命中
- 验证：上表全部落命令；format 1942 过
- 提交后果：open，等审核
- 经验一条：**开新单先 `git checkout -b`，别在上一单分支上顺手改**——这次把 A11 提交误落在 #4797 分支上，靠 `reset --soft HEAD~1 + restore --staged + checkout -b from upstream/main` 收拾（工作区脏改动跨基点干净的 checkout 会自动带过去，正好可用）；把"分支名 = 单子"变成肌肉记忆

### PR-017 ｜ #4799 docs: audit Tools and capabilities group（审计轨 A4）
- 日期 / 链接：2026-09-04 / https://github.com/apache/maka/pull/4799 （分支 docs/audit-tools-a4）
- 动机：审计轨继续，3 份中量组
- 改动：MCP 文档零漂移（超时矩阵/命名规则/env allowlist/network_send 全部逐字命中）；skill-catalog 零漂移（预算常量 18000/4000/8000/0.02 逐字命中）；**web-search 抓到真漂移**——Execution surfaces 表还把已退役的 Headless Harbor 和 `MAKA_WEB_SEARCH_ENABLED` 当现行（该变量 #2152 引入、#2605 于 08-11 随 Headless→Eval 内核改造移除，全仓库只剩文档自己在提），改为记录退役事实；三份全补 frontmatter
- 验证：符号 15+ 个全落文件行号；`git log -S` 钉死变量生死时间线；drift grep 零意外命中；format 过
- 提交后果：open，等审核
- 经验一条：**"文档-only 命中"是漂移的强信号**——一个标识符全仓库 grep 只剩文档自己在说，几乎必然是表面/机制已退役（本单 Harbor、上单 chat-model-selection 同型）；`git log -S <标识符>` 两条命令就能钉死生死时间线

### PR-018 ｜ #4800 docs: audit Sandbox and privacy group（审计轨 A6）
- 日期 / 链接：2026-09-04 / https://github.com/apache/maka/pull/4800 （分支 docs/audit-sandbox-privacy-a6）
- 动机：审计轨继续，4 份含一对双语 RFC
- 改动：**workspace-privacy-context.md 真漂移**——Authority 段还在说 main.ts 的 `getWorkspacePrivacyContext()`/`defaultWorkspacePrivacyContext()`，两函数已不存在、main.ts 零隐私逻辑；新链路=Runtime Host runtime policy（runtime-policy.ts:151 readonly/:255 默认 false + policy-codec 校验补丁）→ desktop 经 queryRuntimePolicy 投影 → core 边界用不变的 validateWorkspacePrivacyContext；消费清单句的 main.ts 也一并改。RFC 双语对零漂移（12 节+5 小节 1:1，#2961 08-17 合并、AppContainer 实现在位）；permission-onboarding-plan 零漂移（Stage 1 文件在、#4328 open）；四份补 frontmatter
- 验证：全链路符号落行号；PR API 核 #2961；双语标题 diff；format 过
- 提交后果：open，等审核
- 经验一条：**双语文档行数差≠漂移**（中文更紧凑，结构对齐就同步）；真正的漂移信号是"文档说的函数 grep 不到"——这类小契约文档（50 行）最易烂，权威路径迁移后没人回头改，审计收益最高的恰是这种

### PR-019 ｜ #4801 docs: audit CLI and distribution group（审计轨 A8）
- 日期 / 链接：2026-09-04 / https://github.com/apache/maka/pull/4801 （分支 docs/audit-cli-dist-a8）
- 动机：审计轨 5 份组
- 改动：五份全零漂移，只补 frontmatter（npm-release 双语对 synced）
- 验证：51 个路径型引用批量核存在性；workflow 文件名全在 .github/workflows/；exe 命名逐字命中 desktop-release-targets.mjs:52；**windows-test-inventory 直接跑仓库自带的 `npm run windows:inventory --check` 过（76 条声明现行）**；#2142 open
- 提交后果：open，等审核
- 经验一条：**审计前先找仓库自带的校验器**——windows-test-inventory 这类文档有配套 `--check` 脚本，一条命令顶半小时人肉比对；有生成器的文档以生成器为准

### PR-020 ｜ 审计轨 5 单提交标题补 scope（#4794/#4798/#4799/#4800/#4801）
- 日期 / 链接：2026-09-05 / https://github.com/apache/maka/pull/4801 等 5 个
- 动机：用户复查发现 5 个 audit PR 的标题和 commit 都是裸 `docs:` 无括号 scope，而 CONTRIBUTING.md:85 明确要求标题为 `<type>(<scope>): <summary>`，且仓库 squash 合并后标题就是 main 上的提交名；同轨已合并的 #4518/#4345/#4046 全是 `docs(architecture): audit ...` 带括号
- 改动：零内容改动，仅 amend 提交首行 `docs: audit` → `docs(architecture): audit`（正文、Refs #3522、Generated-by 尾注原样保留），5 个分支在 make-ggbdpq/maka 独立克隆里 `checkout -B + commit --amend -F + push --force-with-lease` 强推，再 API PATCH 5 个 PR 标题
- 验证：API 回读 5 个 PR：标题与分支 commit 首行一致且带 scope、head SHA 与推送输出逐个吻合、均单 commit、Refs/尾注在位；主工作区（第 8 单分支）全程未动
- 后果：open，等审核；强推会重触发 CI，之前绿的可能要重跑
- 经验一条：**动手前先读 CONTRIBUTING 的提交规范段**——本系列已合并单的 `docs(architecture):` 就是现成答案，当初照抄了标题句式却漏了 scope；改历史提交标题别在工作区挤着，独立克隆里单 commit 分支 amend + force-with-lease 是零风险动作（内容零变化，只改 message）

### PR-022 ｜ #4816 docs: audit Desktop and frontend group（审计轨 A9）
- 日期 / 链接：2026-09-04 / https://github.com/apache/maka/pull/4816 （分支 docs/audit-desktop-frontend-a9）
- 动机：审计轨最大剩余组之一（7 份，issue 提示 astryx review 系列可能整体过时）
- 改动：css-governance 双语对零漂移（7 节 1:1，路径全在）；surface-file-inventory 用仓库自带 `astryx:surface-inventory` 校验通过（249 files ok）；alignment-inventory 自带 superseded 注；两份带日期评审记录按历史保留；08-09 主评审加状态注（workbar 已迁 features/workbar/、patch 0.3.0→0.5.2），其余引用 basename 全树复核；7 份补 frontmatter
- 验证：51+ 路径型引用脚本化批量核验 + basename 复核；清单校验器过；format 过
- 提交后果：open，等审核
- 经验一条：**inventory 型文档先找生成器**——有 check 脚本的文档一条命令定生死；带日期+HEAD 戳的评审记录引用即历史锚，状态注一行带过，不大改

## 2026-09-04 十单日总结

12 单触达，10 单交付：PR #4797（runtime 修复）/ #4798（A11）/ #4799（A4）/ #4800（A6）/ #4801（A8）/ #4802（blog）/ #4814（#4776 flaky）/ #4815（#4804 准入）/ #4816（A9）9 个 PR + #4360 定性评论 1 单；放弃 2 单（#4783 无资源、#4775 作者自修）。审计轨 #3522 剩余仅 A10 Computer use（9 份）未动。

### PR-026 ｜ #5172 docs: audit the Computer Use documentation group（审计轨 A10，认领 #3522，09-11）

- **动机**：A10 Computer use 组（9 份，约 1550 行）是审计轨最后一个无人认领的大组；issue 池当日新单已被 testikun 全部 take（#5140/#5138/#5141），转向审计槽。
- **改动**：+113/-2 九文件。**唯一漂移**：foundation-contract 第 3 层验证仍引用 `accessibility-coverage.spec.ts`，该 spec 已随 #4803（09-06，retire broad route inventories）删除——改写为覆盖由 ax-tree-audit 规则（层 2）与 Storybook smoke（层 4）在各自 owning boundary 承担。其余 8 份核验干净：命令/环境变量/场景名（evidence-classes）、outcome 类型与确定性 harness（host-events）、maka_computer 动作面与 fail-closed 坐标策略（model-loop）、10 个引用路径 + bundled-tools 的 distributionReady:false（provenance）、report 类与 sanitizer 脚本（provider-evidence）、story manifest 锚点（ui-coverage）；cursor-provenance 与 codex-pip 为外部溯源历史记录，无仓库内锚点。9 份全部补标准 frontmatter（last_verified 2026-09-11；foundation-contract 为 zh-CN original）。
- **验证**：路径核验逐条跑；biome 对触及集横幅 0（docs markdown 不进 formatter 范围）。CI 待跑。
- **提交后果**：PR [#5172](https://github.com/apache/maka/pull/5172) 开（base main），等 review。A10 交付后**审计轨 10 组全部清零**（A1-A11 中除他人认领的 A2/A3/A7/Index 外全部由本账号完成）。
- **经验一条**：审计组内文档分两类——"描述当前代码"（可 rg 核验，漂移要改）与"历史溯源记录"（外部事实，无从核验也不需核验，只补 frontmatter 标注核验日期）；分开处理能砍掉大半工作量。testikun 这类扫单号的出现意味着新 issue 的黄金窗口只有几小时，接单循环要么快、要么转向审计轨这类不依赖 issue 池的槽位。

### PR-042 ｜ #5258 审计轨重启：WorkHub domain language 组零漂移
- 日期 / 链接：2026-09-13 / [#5258](https://github.com/apache/maka/pull/5258) · [#3522 认领评论](https://github.com/apache/maka/issues/3522#issuecomment-5653109038)
- 动机：issue 池再筛尽（18 条 open：15 已指派、#5231 被 #5233 占坑 Fixes、#5238/#5235 harness 功能超出范围小闸门且有依赖链）→ 转审计轨。#3522 仍 open；9 月 docs 改动聚合里 WorkHub 区最热（domain-language.md 被 7 个 feature PR 零敲碎打，最新 #5198 09-13），而 #3522 全部 12 条评论零提及、无 audit workhub 的 PR、在途 WorkHub PR（#5252/#5214/#5195）不碰文档——三重排雷后认领
- 改动：仅给 workhub-domain-language.md 补标准 frontmatter（last_verified 2026-09-13，#4345/#5172 先例）；ADR 无 frontmatter 先例保持不动
- 验证：15 组声明逐条对码零漂移——9/9 实现映射路径、四组枚举（disposition/linked-op/stop/resume）、tasks.select_and_delegate 工具名、十分钟过期（coordinator.ts:659 `10 * 60_000`，首次 grep 被数字分隔符骗出假阴性）、opaque 绑定、可选路由模型未接线、呈现门控/delegate_replacement_aborted/空 dock Retry；ADR 标识符全落实、默认路由未动的裁决与 #5152 现状一致
- 提交后果：**已合并（09-15）**——评审一轮（Astro-Han 指出 Resolver 段落无实现支撑），另一会话推送 ce66c5c0f1（补时效注、撤回零漂移表述）后过审合入
- 经验两条：(a) **grep 假阴性不是漂移证据**——`10 * 60_000` 的数字分隔符让三轮搜索全部扑空，差点把"查无此常量"写成漂移；换词根、搜 #5198 diff、再读实现，三步才钉死"文档准确"；(b) **跨 fork 开 PR 的 head 要 `ggbdpq:分支名` 前缀**，裸分支名 422

### PR-043 ｜ #6052 docs: verify the compaction projection docs against main（审计轨 #3522 复验；10-12 review 回退修复）
- 日期 / 链接：2026-10-10 开单（并行会话）· 2026-10-12 本会话修复 / [#6052](https://github.com/apache/maka/pull/6052)（分支 docs/verify-compaction-3522）
- 动机：#3522 的 Context-and-compaction 切片第二次复核（首轮 #4046），重查 #5893/#5931/#5792/#5362/#5980 五个 compaction 区改动后的双语对
- 本会话修复：Astro-Han 10-10 17:15 review 指出最新增量（23102e66c）回退了两处已被认可的修正——①两文档 line 160 指名退回不存在的 `AiSdkBackend.buildPriorMessages()`（正确为 `AiSdkTurn`，实现在 ai-sdk-turn.ts:2716、调用 1163，类声明 613）；②frontmatter `last_verified` 与正文时态句退回 8 月边界，与 PR 描述承诺的 2026-10-10 刷新矛盾。head `06deb5de6` 精确恢复 6 行（2 文件 × 3 处），已在 PR 评论回复
- 验证：`git diff d69f4ec1`（上一被审 head）剩余差异逐行核对 = 该增量有意保留的五点事实修正（connectionId 绑定、overflow shaping 重置、8,000 上限仅限文本 summarizer、中文版 durable prune transitions、7,500 UTF-8 字节阈值），即 review 原文点名的五点；`git diff --check` 干净；文档-only 无测试面
- 后果：open，等复审
- 经验一条：**review 修复后 diff 上一被审 head，别只看自己的 diff**——本单的两处回退与五点修正混在同一增量提交里，只看增量 diff 会以为全对；对上一被审版本做全量 diff 才能把"有意修正"和"意外回退"分开
