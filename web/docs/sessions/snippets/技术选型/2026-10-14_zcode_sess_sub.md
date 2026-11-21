# 技术选型 — 侦察完成，全部为只读 API 调用(令牌仅存于单条命令变量，未输出、未发评论、未 take、未开 PR)。以…（截断）

- 标签：技术选型
- 日期：2026-10-14
- 来源：zcode 会话 sess_sub（E:\cc\guahub\fork\maka-hub）
- 置信度：机器初筛候选，采纳前请对照原会话

## 触发上下文（用户最后一问）

你在为 apache/maka 的贡献流水线做选题侦察(只读,不评论不修改)。用 GitHub API 认证读取,令牌经 `"/c/Program Files/GitHub CLI/gh.exe" auth token` 获取,只放进单条命令变量,绝不输出令牌本体。

背景:今天早间已做过一轮全池扫描(238 个 open issues),结论是池子接近枯竭,候选名单:#5500(storybook flake tracking,唯一全净但价值低)、#5572(WorkHub persistence_failed 不透明报错,领域最佳但评论区有"preparing the mini…（截断）

## 结论

侦察完成，全部为只读 API 调用(令牌仅存于单条命令变量，未输出、未发评论、未 take、未开 PR)。以下为报告。

# 增量扫描结果(created >= 2026-10-13,open,共 3 个)

## #6095 — feat(workhub): show provider icons consistently with regular conversations —— 唯一幸存新候选，四闸全过

- **闸① 未被认领：通过。** 0 评论、0 assignee、0 label,timeline 完全为空(无任何 cross-reference/claim 事件)；全库 open PR body 搜索引用 #6095 的结果为 0。issue 创建于 2026-10-14T03:26Z,极新鲜(先发优势窗口存在，但当前确净)。
- **闸② 范围 ≤200 行：通过(改动面极小)。** 已在本地 checkout `E:\cc\guahub\fork\maka-hub\maka` 实证:`renderProviderMark` 目前只在 `apps\desktop\src\renderer\app-shell.tsx:1403`(常规会话)和 `settings\general-settings-page.tsx` 提供，`features\workhub\ui\workhub-root.tsx` 中完全缺失(grep 零命中，与 issue 引用的 main@f61091963 行号 326 处 `<WorkHubComposer>` 一致)。关键发现:`workhub-composer.tsx:39` 的 `WorkHubComposerProps = Omit<ComposerProps, 'onSend' | 'draftKey'> & ...`,即该 prop 本就在接受类型里，大概率只需在 workhub-root.tsx 传一行 prop(若 WorkHubComposer 未透传则再加几行)。预估 <50 行含测试。
- **闸③ Windows 可验证：通过。** 纯 desktop renderer 的 prop 透传 + 视觉一致性，本地 vitest/Storybook smoke 即可验证；无 macOS-only、无 GPU/付费 API 依赖。
- **闸④ 领域交集：通过。** desktop renderer + WorkHub,与已知知识直接复用(app-shell、workhub-root、#5500 的 WorkHub Storybook smoke、#5572 的 WorkHub 表面)。
- **风险：** 低。issue 自述 Codex 协助起草(作者署名清晰)；明确排除替换 #5444 的 compact wheel,范围收敛在 docked/expanded WorkHub 的共享 Composer。

## #6086 — Goal evaluator cannot see tool results or human card answers —— 闸①淘汰

- 已被认领：assignee = **Totoro-qaq**,评论原文即一个词 **"take"**(2026-10-13T07:12:51Z);且 open PR **#6087** "fix(runtime-host): include tool and human evidence in Goal context"(同作者，body 引用 #6086)——标准 Fixes 占坑形态。淘汰。

## #6082 — bug(tui): fullscreen multiline drafts clip status on short terminals —— 闸①淘汰

- 作者即认领者 **Dante-dan**:assignee 已设为自己，两条评论(计划书 + **"take"**,2026-10-13T04:25:16Z),open PR **#6085** "fix(cli): preserve fullscreen editor and status on short terminals" 已挂出。自产自销，淘汰。

# 三个旧候选复检

## #5500(storybook flake tracking)—— 状态不变：全净但价值进一步走低

- 0 评论、0 assignee、无 open PR 引用(search total 0)。唯一交叉引用 PR **#5502**("fix(ci): retry a failed storybook render once, alone",Joob1n)**已于 2026-09-19 合并**(merge 815caaf8)。
- 含义：症状缓解(retry-once)已上线，剩下的只是 issue 正文里“是否 quarantine”的 CI-owner 决策，可提交的贡献空间比昨天评估的更小。维持原判：唯一全净、但价值低。

## #5572(persistence_failed 不透明报错)—— 重大变化：软占坑已兑现为已合并 PR,剩余价值大幅缩水

- 评论面无变化(3 条，均为 MoonOld 2026-09-21;issue updated_at 仍停在 2026-09-21T13:13:15Z),无 assignee,当前无 open PR 引用它。
- **但：MoonOld 的"ready to submit"确实兑现了** —— PR **#5573** "fix(runtime-host): log why a transcript page read failed"(MoonOld,2026-09-21T13:14:59Z 创建，即“ready to submit”评论后 96 秒)**已于 2026-09-27 合并**(merge 22c2a813);同分钟还合并了 jackeyfaker77 的 **#5600**(bootstrap 路径日志)与 **#5601**(projection 诊断)。
- 含义：issue 修复方向 1(真实错误落日志，page + bootstrap 两条路径)**已全部合并**。剩余的是方向 2–4:deterministic/retryable 分类、给 Renderer 的 typed error、Turn 粒度降级——其中 MoonOld 第二条长评已论证方向 2 "risky/underspecified"、方向 3 "wrong layer",并给出自认的方案(Turn 粒度合成 `system_note` 占位)。剩余部分要么超出 200 行预算，要么设计已被充分论证、后入者只能照抄其方案(且方案作者随时可回来提交)。**建议从候选名单降级/除名。**

## #4495(side conversation 独立模型)—— 状态基本不变：仍卡设计对齐，且新增 stale 风险

- 评论仍 2 条：Astro…（截断）
