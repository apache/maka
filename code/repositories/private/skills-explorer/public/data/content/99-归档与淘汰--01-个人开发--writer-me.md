---
name: writer-me
description: 个人技术写作跃迁。Use when translating or polishing technical Markdown, writing README, docs index, development log, bug retrospective, handoff guide, change explanation, rollback note, deployment notes, testing report, audit note, developer-facing code logic notes, business-facing feature docs, vision planning, architecture blueprint, roadmap, capability map, first-principles technical planning, adversarial risk analysis, or when the user wants clear Chinese documentation with paths, commands, fields, rules, boundaries, and verification; also when the user asks to rewrite text to sound more human, remove AI flavor, keep meaning, 帮我重写这段文字, 保留原意, 写得更像真人, 去 AI 味.
---

# 个人技术写作跃迁

把个人项目中的事实、判断和开发经验沉淀为可核验、可交接、可复用的技术资产。先判模式，再收事实，再写。

## 写作模式

| 模式             | 何时启用                                                                       | 怎么写                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 技术文档模式     | 翻译、终稿、README、交接、复盘、工程留痕、代码逻辑、业务说明、愿景规划         | 事实准；表格优先；路径、命令、字段、接口可核验。禁止填充语、机械三分法、「综上所述」、营销腔。                                                   |
| 去 AI 味改写模式 | 用户说「帮我重写这段文字，保留原意，但写得更像真人」或明确要求去 AI 味、更口语 | 减少过度工整句式和机械分段，允许少量口语化和不规则表达，长短句自然交替，删空话套话和重复总结。技术事实仍要准。不要把工程文档改成营销或自媒体腔。 |

## 写作前先收事实

当前 README、`package.json` 和源码优先，历史文档只能作为经验来源。交接类先读源码入口、README、接口与测试；复盘类凑齐表现、触发、排查、根因、修复、验证七要素；变更类先列改动文件、影响范围和回滚方式；事实拿不全就标注，不编。

## 读者模式选择

| 模式         | 读者                   | 可保留                                               | 必须避免                             |
| ------------ | ---------------------- | ---------------------------------------------------- | ------------------------------------ |
| 代码逻辑梳理 | 开发者、接手模块的人   | 文件路径、字段名、接口、按钮条件、关键判断、跳转参数 | 大段代码、props 罗列、无意义实现细节 |
| 业务说明     | 业务、新人、产品、运营 | 页面能做什么、操作流程、业务规则、校验原因、常见问题 | 代码块、函数名、接口结构、技术栈堆砌 |

## 个人写法细则

- 按页面和逻辑分章，先整体后细节；列表字段按界面顺序写。
- 按钮先写是否展示，再写点击后发生什么；弹窗写标题、关键文案、字段、动态文案来源和提交结果。
- 字段保留页面文案、接口字段名和中文含义；service 以接口为纲，写清 method、url、入参、出参和业务含义。
- 允许写少量关键条件（如 `status == 1`），不贴大段代码。
- 业务说明全用中文业务语言，不出现代码块、函数名、接口结构和文件路径；先说解决什么问题，再说怎么用；错误、边界、校验只用业务语言描述。

各类文档章节骨架（Bug 复盘、开发记录、交接、代码逻辑梳理、业务说明、愿景规划、工程留痕等）见 [structure-templates.md](references/structure-templates.md)，与通用骨架不同时才回来改本节。

## 总结沉淀（项目总结/复盘/组件说明）

把一次开发、重构、排查或交付沉淀成可复用文档，推荐结构：

1. 一句话结论。 2. 当前事实和文件范围。 3. 做了什么改动。 4. 为什么这样设计。 5. 哪些可以复用。 6. 哪些不能泛化。 7. 验证了什么。 8. 后续接入和风险。

组件说明重点：先写业务组件，不写内部视觉碎片；标清哪些组件适合跨模块复用；标清数据边界（DTO、mapper、ViewModel、normalize、constants）与设计原则（业务红框、组合优先、少布尔 props、静态数据上移）。

## 翻译硬约束

- 代码块内容逐字不变，只翻译纯注释行。
- 占位符、变量、标签、锚点、URL、文件路径保持一致。
- YAML frontmatter 只翻 value，不翻 key，不改顺序。
- HTML 标签数量和配对关系保持不变。
- 不为文风改写事实边界或章节结构。

## 终稿流程

1. 先判模式（技术文档 vs 去 AI 味），再判翻译、终稿、工程留痕或交接。
2. 收结构：删重复标题和空洞过渡，补事实路径、命令上下文和预期结果。
3. 字典、状态、字段映射优先表格化；未覆盖风险写明原因。
4. 去 AI 腔、营销感、武断断言和元叙述；输出可直接保存为 Markdown。

## 文风标准

- 先给结论，再给证据和步骤；每段都有信息增量。
- 少用口号和抽象词，多写路径、文件、命令、接口、状态；不写无法核验的断言。

## 输出要求

按用户需要使用：

1. 结论摘要
2. 修改文件清单
3. 改动目的
4. 可执行步骤
5. 验收方式
6. 未改事项

需要更细规则时再读取：

- `references/self-check-list.md`
- `references/error-fix-table.md`
- `references/structure-templates.md`
- `references/anti-patterns.md`
- `references/formatting-rules.md`
- `references/quality-checklist.md`
- `references/ai-ide-handbook-authoring.md`（写工具手册/配置文档时：one guide per tool、analyze-first、官方源验证、写后四项验证含 token 泄漏扫描）
