# fork 贡献文档

> **会话唯一入口（2026-10-28 起）**：狩猎接单 / 维护老单，都从本页开始——在下方「跨仓项目」表按项目名定位，然后：①共享纪律读 [handbook/12 通用纪律与执行声明](handbook/12-通用纪律与执行声明.md)（政策总表/通用纪律/AI+严格验证声明/参考规范）；②仓专属读 `hub/<项目>/handbook/`（维护任务书+仓规+环境坑）与 `hub/<项目>/journal/`（在途快照与逐轮记录）。公共部分只放这里，各仓子文件夹只放独属于自己的内容，不再复制粘贴大段重复文字。
>
> 贡献工作规范（接单/TDD/消融回红/兄弟面检查）见 [../../../AGENTS.md](../../../AGENTS.md)。代码仍在 `code/fork/`。

直接提 PR 的 fork 项目的文档目录：[handbook/](handbook/README.md) 收跨仓通用规则（章节见下方地图），[hub/](#跨仓项目) 收每个项目的项目卡、handbook、journal 与哨兵基线。magpie 走 patch 附 issue 的形式，文档在 `hub/magpie/`；其余 fork 项目走个人 PR，文档都在本目录。

## 从需要出发

| 现在要做什么 | 入口 | 接着读 |
| --- | --- | --- |
| 了解有哪些项目、按用途分类、查路径与工具链 | [handbook/01 接单线程池](handbook/01-接单线程池.md) | 对应项目 hub 的 README |
| 接手跨仓工作单、查预算与全局单号 | [handbook/02 接单总台账](handbook/02-接单总台账/README.md) | 对应项目 hub 的 journal/在途快照 |
| 查已结单、让坑或出池单的历史账 | [handbook/02 接单总台账](handbook/02-接单总台账/README.md)（各仓文件「终态归档」节） | 对应项目 hub 的 journal 索引 |
| 回顾代表性改动与交付价值 | [handbook/04 交付总览](handbook/04-交付总览.md) | 原始 PR 链接与项目事件 |
| 交付/推荐/维护发布前查验证链怎么走 | Skill `gua-pr-patch`（`references/workflow.md`、`delivery.md`）；判例见 [handbook/13](handbook/13-测试验收闭环.md) | 对应项目 hub 的 handbook（仓专属差异） |
| 排查测试、CI、同步或评审失败 | [handbook/05 失败模式对照](handbook/05-失败模式对照.md) | 相关项目 hub 的 handbook/ |
| 第一次给某仓贡献，查通用流程 | Skill `gua-pr-patch`（`SKILL.md` 的任务分流与六阶段流程） | 项目 hub 的 handbook/01 仓规 |
| 确定角色分工、并行上限、worktree 规范 | [handbook/07 分工与并行](handbook/07-分工与并行.md) | 项目 hub 的 handbook/ |
| 安排巡检、确认项目梯队与升降级 | [handbook/08 巡检节奏与分层](handbook/08-巡检节奏与分层.md) | 项目 hub 的 journal/在途快照 |
| 新开一个项目会话或哨兵任务 | [handbook/09 提示词](handbook/09-提示词.md) | 项目 hub 的 handbook/03 与 sentinel/ |
| 决定新文档放哪、何时分卷归档 | [handbook/10 文档维护与结构](handbook/10-文档维护与结构.md) | 项目 hub 的 journal/README |
| 复盘家目录仓数据事故与防护 | [handbook/11 事故复盘](handbook/11-事故复盘.md) | §2 的运维手册与残余风险 |

## handbook 章节地图

| 章 | 内容 | 适合谁读 |
| --- | --- | --- |
| [01 接单线程池](handbook/01-接单线程池.md) | 项目身份、用途分类、路径、工具链来源 | 找项目、开新会话前 |
| [02 接单总台账](handbook/02-接单总台账/README.md) | 当期预算与在途工作单活表（新行只追加在锚点处） | 接单、派单前 |
| 03 接单总台账-归档 | 2026-10-24 起已并入 [02](handbook/02-接单总台账/README.md) 各仓文件的「终态归档」节，不再单独成册 | 查历史账 |
| [04 交付总览](handbook/04-交付总览.md) | 按时间回顾代表性贡献 | 盘点、写战报 |
| [05 失败模式对照](handbook/05-失败模式对照.md) | M1–M13 跨仓反复出现的失败模式 | 开工前扫目录，疑似失败先定性 |
| 06 PR生命周期 | 2026-11-14 起规则迁入 Skill `gua-pr-patch`（接手、选题、验证、维护见 `references/workflow.md`，交付与收编见 `references/delivery.md`），本章已删除 | 第一次贡献、查流程 |
| [07 分工与并行](handbook/07-分工与并行.md) | 角色表、每项目最多 2 个子智能体（magpie、maka 例外见 07 §3）、worktree 规范、与 magpie 的差别 | 派单、开子代理前 |
| [08 巡检节奏与分层](handbook/08-巡检节奏与分层.md) | 主力 4 仓 / 半月巡检 4 仓、巡检日历、升降级 | 值班排期 |
| [09 提示词](handbook/09-提示词.md) | 会话开场 / 哨兵母版 / 轮班任务书 / 成本与采纳记账四节 | 新开会话、注册定时任务、逐单记账 |
| [10 文档维护与结构](handbook/10-文档维护与结构.md) | 内容归属、hub 标准结构、记账口径、归档触发 | 新建文档、收账归档 |
| [11 事故复盘](handbook/11-事故复盘.md) | 家目录仓两次摘帽事故与三层防护；2026-11-07 cc 仓重置的可恢复性影响 | 涉家目录 git 操作前必读 |
| [12 通用纪律与执行声明](handbook/12-通用纪律与执行声明.md) | 政策总表（可接新单/仅维护）、通用纪律、AI+严格验证声明、参考规范 | **每仓每会话必读** |
| [13 测试验收闭环](handbook/13-测试验收闭环.md) | 验收历史判例（规则已迁入 Skill `gua-pr-patch`） | 交付/推荐/维护发布前 |

## 跨仓项目

| 项目 | 上游 | 节奏 | 会话入口（每仓唯一） |
| --- | --- | --- | --- |
| [cc-switch](hub/cc-switch/README.md) | farion1231/cc-switch | 每个工作日 | [handbook/04-在途维护提示词](hub/cc-switch/handbook/04-在途维护提示词.md) |
| [cherry-studio](hub/cherry-studio/README.md) | CherryHQ/cherry-studio | 每个工作日 | [handbook/04-维护任务书](hub/cherry-studio/handbook/04-维护任务书.md) |
| [CLIProxyAPI](hub/cliproxyapi/README.md) | router-for-me/CLIProxyAPI（base `dev`） | 每个工作日 | [handbook/11-维护任务书](hub/cliproxyapi/handbook/11-维护任务书.md) |
| [maka](hub/maka/README.md) | apache/maka | 每个工作日 | [handbook/12-维护任务书](hub/maka/handbook/12-维护任务书.md) |
| [cockpit-tools](hub/cockpit-tools/README.md) | jlcodes99/cockpit-tools | 每月 1 日 / 16 日 | [handbook/04-维护任务书](hub/cockpit-tools/handbook/04-维护任务书.md) |
| [litellm](hub/litellm/README.md) | BerriAI/litellm | 每月 1 日 / 16 日 | [handbook/04-维护任务书](hub/litellm/handbook/04-维护任务书.md) |
| [multica](hub/multica/README.md) | multica-ai/multica | 每月 1 日 / 16 日 | [handbook/05-维护任务书](hub/multica/handbook/05-维护任务书.md) |
| [orca](hub/orca/README.md) | stablyai/orca | 每月 1 日 / 16 日 | [handbook/04-维护任务书](hub/orca/handbook/04-维护任务书.md) |
| [magpie](hub/magpie/README.md) | yetone/magpie | 按 hunt 轮次 | [handbook/06-会话开场提示词](hub/magpie/handbook/06-会话开场提示词.md)（patch 形式） |
| [cumora](hub/cumora/README.md) | yetone/cumora | 未定（无在途单） | [handbook/01-维护任务书](hub/cumora/handbook/01-维护任务书.md) |
| [open-claude-ui](hub/open-claude-ui/README.md) | Caho1/open-claude-ui | 未定（无在途单） | [handbook/01-维护任务书](hub/open-claude-ui/handbook/01-维护任务书.md) |

> **政策（可否接新单）只在 [handbook/12 政策总表](handbook/12-通用纪律与执行声明.md#政策总表2026-10-28-用户声明)维护**，本表不再复制；节奏与梯队以 [handbook/08 §1](handbook/08-巡检节奏与分层.md) 为准。各仓 `handbook/03-会话开场提示词.md` 已于 2026-10-28 降级为参考差异卡，不作会话入口。

每个项目 hub 的标准结构（项目卡 + handbook/ + journal/ + issues/ + sentinel/）与升降级规则见 [handbook/10 §5](handbook/10-文档维护与结构.md) 和 [handbook/08](handbook/08-巡检节奏与分层.md)。
