# pr — maka 贡献流程与台账入口

> 接单全流程、命令、案例、逐单台账都在这个文件夹。外部入口：仓库文档地图见 [../README.md](../README.md)。

| 文件 | 内容 |
| --- | --- |
| (../../pr/workflow.md) | 从零到熟练的完整接单流程教程（L0-L6）+ 单课沉淀 |
| (../../pr/commands.md) | PR 全流程命令手册（开工同步/认领/查询/验证/提交/开 PR） |
| (../../pr/cases.md) | 关键转折的深度复盘 |
| (../../pr/journal/) | 逐单台账，按轨道拆分（见下表） |

## 台账索引（65 条）

| 单号 | 标题 | 台账 |
| --- | --- | --- |
| PR-001 | #4345 docs(architecture): audit bot onboarding runtime | (../../pr/journal/audit.md) |
| PR-009 | #4518 docs(architecture): audit Recovery and resume group | (../../pr/journal/audit.md) |
| PR-014 | #4794 docs: audit Model access group（审计轨 A5） | (../../pr/journal/audit.md) |
| PR-016 | #4798 docs: audit Provenance records group（审计轨 A11） | (../../pr/journal/audit.md) |
| PR-017 | #4799 docs: audit Tools and capabilities group（审计轨 A4） | (../../pr/journal/audit.md) |
| PR-018 | #4800 docs: audit Sandbox and privacy group（审计轨 A6） | (../../pr/journal/audit.md) |
| PR-019 | #4801 docs: audit CLI and distribution group（审计轨 A8） | (../../pr/journal/audit.md) |
| PR-020 | 审计轨 5 单提交标题补 scope（#4794/#4798/#4799/#4800/#4801） | (../../pr/journal/audit.md) |
| PR-022 | #4816 docs: audit Desktop and frontend group（审计轨 A9） | (../../pr/journal/audit.md) |
| PR-026 | #5172 docs: audit the Computer Use documentation group（审计轨 A10，认领 #3522，09-11） | (../../pr/journal/audit.md) |
| PR-042 | #5258 审计轨重启：WorkHub domain language 组零漂移 | (../../pr/journal/audit.md) |
| PR-002 | #4481 fix(cli): abbreviate home-relative Windows paths in the status line | (../../pr/journal/claims.md) |
| PR-003 | #4485 fix(desktop): show platform-correct shortcut labels on Windows and Linux | (../../pr/journal/claims.md) |
| PR-004 | #4488 test(eval): bound fragmented-handshake recv by the handshake deadline | (../../pr/journal/claims.md) |
| PR-010 | #4566 test(runtime-host): bound test wait helpers by wall-clock deadlines | (../../pr/journal/claims.md) |
| PR-005 | #4506 fix(cli): exit 1 when a denied sandbox boundary is never retried | (../../pr/journal/claims.md) |
| PR-006 | #4513 fix(i18n): make resume-park and connection-error copy locale-aware | (../../pr/journal/claims.md) |
| PR-007 | #4514 fix(desktop): keep the Agent Graph panel visibly alive | (../../pr/journal/claims.md) |
| PR-008 | #4517 fix(desktop): load desktop stories on Windows with a config-relative glob | (../../pr/journal/claims.md) |
| PR-015 | #4797 fix(runtime): history-compact 指令改为末尾 user 消息（认领 issue #4634） | (../../pr/journal/claims.md) |
| PR-R020 | #4802 docs(blog)：rehydrate 中文翻译修正（认领 issue #4767） | (../../pr/journal/claims.md) |
| PR-024 | #5116 fix(runtime): DingTalk 1:1 回复路由（认领 issue #5111，09-10） | (../../pr/journal/claims.md) |
| PR-025 | #5118 fix(desktop,cli): edit-and-resend 保留 quotes（认领 issue #5109，09-10） | (../../pr/journal/claims.md) |
| PR-025b | #5125 feat(storage): OpenCode 会话扫描（认领 issue #5053，09-10） | (../../pr/journal/claims.md) |
| PR-026 | #5265 fix(cli): TUI rewind 恢复 quotes 进替换提交（#5109 续，09-13，09-28 进展补记） | (../../pr/journal/claims.md) |
| PR-027 | #5274 fix(desktop,ui): 选中消息 quotes/attachments 重上（#5109 续，09-14，09-28 进展补记） | (../../pr/journal/claims.md) |
| PR-028 | #5709 feat(usage): filter usage queries by model call kind（认领 issue #5691，09-24） | (../../pr/journal/claims.md) |
| PR-029 | #5744 chore: refresh the install-scripts allowlist against the lockfile（自主维护单，09-27） | (../../pr/journal/claims.md) |
| PR-010a | #4514 review 修复（第二轮） | (../../pr/journal/reviews.md) |
| PR-011 | #4514 / #4506 第二轮 review 修复（home 侧收尾） | (../../pr/journal/reviews.md) |
| PR-012 | 三连 CI 红叉排查日 | (../../pr/journal/reviews.md) |
| PR-013 | #4514 e2e 连红的真正根因：分支基点老 | (../../pr/journal/reviews.md) |
| PR-021 | CI 红叉排查两单（#4801 生成文档误加 frontmatter / #4506 audit 端点抽风） | (../../pr/journal/reviews.md) |
| PR-R021 | #4815 fix(runtime-host)：结构化消息准入与重放可见性（认领 issue #4804） | (../../pr/journal/reviews.md) |
| PR-R022 | #4816 audit Desktop and frontend 组 CI 红叉（同 #4801 病第二次发生） | (../../pr/journal/reviews.md) |
| PR-R014 | 五条在途 PR 的新评论批量消化（09-07/09-08） | (../../pr/journal/reviews.md) |
| PR-R015 | #4815 P1 深修第一刀：durable 准入 + 验收测试 | (../../pr/journal/reviews.md) |
| PR-R023 | #4566 冲突解算 + #4800/#4815 审核回复 + main 同步（维护日） | (../../pr/journal/reviews.md) |
| PR-R024 | 四单 findings 逐个清偿（#4815/#4816/#4814/#4801） | (../../pr/journal/reviews.md) |
| PR-R025 | Astro-Han 追加复核三连修（#4799/#4800/#4794） | (../../pr/journal/reviews.md) |
| PR-R026 | GPT-6 Astra 复核意见逐条清偿（#4816/#4814/#4801） | (../../pr/journal/reviews.md) |
| PR-R027 | Astra 第二轮复核清偿（#4801/#4814/#4815） | (../../pr/journal/reviews.md) |
| PR-R028 | 三 open PR 维护日（同步+并 main+CI 确认+评论扫描） | (../../pr/journal/reviews.md) |
| PR-R029 | Astro-Han 第三轮复核清偿（#4815/#4814/#4801 全清） | (../../pr/journal/reviews.md) |
| PR-R029b 复核附注（独立核验，另一会话交付） | PR-R029b 复核附注（独立核验，另一会话交付） | (../../pr/journal/reviews.md) |
| PR-R030 | #4815 冲突解算 + 新 P2 清偿（#4814/#4801 已 Approved 不动） | (../../pr/journal/reviews.md) |
| PR-R031 | #4815 CI 红修复（renderer-architecture 门）+ #4814/#4801 上游合并 | (../../pr/journal/reviews.md) |
| PR-016b | #4815 review 批量收尾：三 P2 + 两 P3 一轮清空（09-10） | (../../pr/journal/reviews.md) |
| CI format 红三连（#5118/#4815/#5125）复盘 | CI format 红三连（#5118/#4815/#5125）复盘 | (../../pr/journal/reviews.md) |
| #5118 缩窄复盘 + #4815 rail flaky（09-10 深夜） | #5118 缩窄复盘 + #4815 rail flaky（09-10 深夜） | (../../pr/journal/reviews.md) |
| epoch 第八撞（09-11 晨） | epoch 第八撞（09-11 晨） | (../../pr/journal/reviews.md) |
| #4815 rail 失败终局：flake 判定（09-11 深夜） | #4815 rail 失败终局：flake 判定（09-11 深夜） | (../../pr/journal/reviews.md) |
| (3) round-trip 测试落地（09-11 深夜，520beb81d） | (3) round-trip 测试落地（09-11 深夜，520beb81d） | (../../pr/journal/reviews.md) |
| PR-032 | #4815 二次撞号快速解（135）+ 雷哥 merge 协同 | (../../pr/journal/reviews.md) |
| PR-033 | #4815 三度撞号（136）+ stopShown 语义并集 | (../../pr/journal/reviews.md) |
| PR-034 | #4815 CI 四连红排查（5 子代理并行）+ 并 #5114 加固解锁 | (../../pr/journal/reviews.md) |
| PR-035 | #4815 六度撞号（137）+ 雷哥 merge 协同文案 | (../../pr/journal/reviews.md) |
| 五 PR review 修复冲刺（09-11 晨，Astro-Han/me2seeks 四连 review 的回应） | 五 PR review 修复冲刺（09-11 晨，Astro-Han/me2seeks 四连 review 的回应） | (../../pr/journal/reviews.md) |
| PR-036 | 五单复核日（4 子代理核验"addressed"声称）+ 逐单清偿 | (../../pr/journal/reviews.md) |
| PR-037 | #5118 冻结区注释 token 修正 + #4815 七度撞号（147）合并跑步机 | (../../pr/journal/reviews.md) |
| PR-038 | #4815 CI 红根因修复（base64 载体契约）+ 组合层验收测试落地 | (../../pr/journal/reviews.md) |
| PR-039 | #5116 被 #5112 取代关单 + #5172 合并 + #4815 新 P2（directory-only 压缩丢失） | (../../pr/journal/reviews.md) |
| PR-040 | #4815 九度撞号（148/149→150，side-chat 大并）+ #5125 新 P2（UTF-8 字节预算） | (../../pr/journal/reviews.md) |
| PR-041 | #5125 Astro-Han 复审 P1：synthetic user parts 进 digest | (../../pr/journal/reviews.md) |
| 单2 | #4360 context compression 不自动触发 —— 定性为过期 issue，无 PR | (../../pr/journal/retrospective.md) |
| 单8 中途 | #4783 Terminal-Bench 4.0 —— 放弃（资源门槛） | (../../pr/journal/retrospective.md) |
| 单8 | #4776 flaky Host 生命周期测试（进行中，已 take） | (../../pr/journal/retrospective.md) |
| 复盘核对补记 | 2026-09-08（本session收尾时） | (../../pr/journal/retrospective.md) |
| 9月实际交付盘点（2026-09-08 核对 pulls API） | 9月实际交付盘点（2026-09-08 核对 pulls API） | (../../pr/journal/retrospective.md) |

## 新单模板

```markdown
### PR-XX ｜ <编号> <type>(<scope>): <摘要>
- 日期 / 链接：
- 动机：
- 改动：
- 验证：
- 提交后果：
- 经验一条：
```
