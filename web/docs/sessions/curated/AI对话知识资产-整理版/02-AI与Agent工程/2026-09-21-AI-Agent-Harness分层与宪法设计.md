# AI Agent Harness 分层与全局宪法设计

> 由 1 份 AI 会话沉淀合并 · 工作日期 2026-09 中旬（文件无内证日期，2026-09-21 为归档时间估计；原文件名 URL 编码乱码）
> 来源：《AI20HarnessB8E5A8B1E9B99BE5AAB3E8BEAE%A1.md》（正文实为「AI Agent Harness 与全局项目宪法设计」）
> 执行记录见同目录《2026-09-08-Coding Agent宪法与个人Skills精简、执行边界及跨模型适配》。

## 一句话结论

把 ponytail 的可迁移核心压缩成一句话进两份全局宪法，完整 ponytail（约 1066 词）降级为按需触发的 Skill，形成「常驻原则 → 按需 Playbook → 项目层 AGENTS.md → 反馈层」的四层 Harness 分层，并以 `Harness ROI ≈ 行为改善 / 上下文成本` 作为增删规则的裁决公式。

## 三层文件现状（当时）

| 文件 | 角色 |
| --- | --- |
| `%USERPROFILE%\.codex\AGENTS.md` | Codex 宪法 |
| `%USERPROFILE%\.claude\CLAUDE.md` | Claude 宪法 |
| `%USERPROFILE%\AGENTS.md` | 仅 Home 工作区约定，不承担跨仓库全局规则 |

## 四层架构

1. **常驻原则**：ponytail 压缩为「理解根因、优先复用、最小必要改动、只简化实现不省略验证」进两份宪法的「实现与简化」节。
2. **按需 Playbook**：完整 ponytail 保留为条件触发 Skill（触发词如 "be lazy" / "yagni"）。
3. **项目层 AGENTS.md**：项目专有事实、命令、契约。
4. **反馈层**：backpass 证据驱动 ADD / REMOVE / REWRITE / EXTRACT → SKILL。

## 关键判断

- 优化目标不是省 token：`Harness ROI ≈ 行为改善 / 上下文成本`；「模型知道原则」≠「稳定优先执行」。
- 宪法应写可执行的目标、边界、验收和停止条件，不把「资深专家」「第一性原理」等标签当行为保证。
- 待验证（当时）：10~20 个真实任务 A/B 对照（A 仅宪法精简原则 vs B 宪法+完整 ponytail），观察返工率/复用率/测试通过率再决定 ponytail 去留；规则需要「只增不减」之外的衰减机制。
