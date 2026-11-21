# maka 项目卡

> **梯队：主力**（每个工作日至少一轮；哨兵定时只读巡检）· 上游 `apache/maka` · fork `ggbdpq/maka` · PR base `main` · 形态：直接提 PR

项目：apache/maka（TypeScript agent runtime）。台账按轨道分：11 审计轨 / 12 认领轨 / 13 评审维护 / 14 复盘定性 / 15 残页 / 16 三支柱复核；手册 handbook/ 00-12 覆盖哨兵任务书（历史）、环境、机制与棘轮、CI 排障、review 处理、全流程、命令、案例和维护任务书（现行入口 [handbook/12](handbook/12-维护任务书.md)）。

## 入口

| 场景 | 文档 | 说明 |
| --- | --- | --- |
| 手册 | [handbook/README.md](handbook/README.md) | 本仓全部规则文档 |
| 查单 | [journal/README.md](journal/README.md) | 逐单索引与分卷 |
| 候选 | [design/cursor-kimi导入贡献单.md](design/cursor-kimi导入贡献单.md) | 候选单（状态以文首校注为准） |
| 哨兵 | [sentinel/](sentinel/) | 定时只读巡检提示词（旧提示词提到的 `sentinel/02-基线状态.json` 等 .json 基线文件本目录现已不存在，以 GitHub 实测为准）；**03=狩猎+维护双线新会话提示词·验证三支柱强化版（2026-10-28 现行版；02 为 10-25 版仅存档，01 历史存档）** |

## 本仓分工

主会话兼任哨兵、书记、复盘，认领和分配全局单号仍归主会话；推送与发帖按 [fork/AGENTS.md §3](../../../AGENTS.md)（2026-10-24 定版）：子智能体自检 → 推 fork → 发帖 → GET 回读，主线程只做事后复核。并行 clone 为 `maka-pr1..3`（每路独占一个）。2026-10-30 起只维护老单、不接新单，猎手线停用。通用分工见 [handbook/07 分工与并行](../../handbook/07-分工与并行.md)。

| 角色 | 本仓写哪里 |
| --- | --- |
| 哨兵 | `sentinel/` 基线文件（只读巡检，唯一可写） |
| 维护（猎手线 2026-10-30 起停用） | `maka-pr1..3` 或临时 worktree 里的分支；推 fork、发帖后把报告交主会话复核 |
| 书记 | `journal/` 各轨活卷；maka 不设在途快照，在途状态来源见 [handbook/12-维护任务书](handbook/12-维护任务书.md) 与 [总台账 maka.md](../../handbook/02-接单总台账/maka.md) |
| 复盘 | `handbook/`（本仓规则）；跨仓规则上交 [handbook/05](../../handbook/05-失败模式对照.md) |

## docs 结构（2026-10-28 对齐 magpie 式重组）

| 目录 | 记什么 |
| --- | --- |
| handbook/ | 规则：仓规/环境坑/开场提示词/**维护任务书** |
| journal/ | 事实：逐轮维护记录（只追加） |
| README.md | 本页：导航 |

## 政策

仅维护老单（rebase+解冲突、处置评论，直到合并/关闭），不接新单（2026-10-30 声明；唯一事实来源见 [handbook/12 政策总表](../../handbook/12-通用纪律与执行声明.md)）。
执行全靠大模型，每单必走完整测试验证程序；参考规范：cc-switch CONTRIBUTING 与 magpie docs/contributors.md。
