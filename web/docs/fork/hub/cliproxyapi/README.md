# CLIProxyAPI 项目卡

> **梯队：主力**（每个工作日至少一轮；哨兵定时只读巡检）· 上游 `router-for-me/CLIProxyAPI` · fork `ggbdpq/CLIProxyAPI` · PR base `dev` · 形态：直接提 PR

项目：router-for-me/CLIProxyAPI，Go 代理服务器。本目录保存逐单经历与历史快照，只追加事实；可复用规则与环境经验从 [贡献手册](handbook/README.md) 进入。本轮未刷新远端状态。

跨仓预算与索引见 [handbook/02 接单总台账](../../handbook/02-接单总台账/cliproxyapi.md)，项目调研快照见 [handbook/01 接单线程池](../../handbook/01-接单线程池.md)，维护方式见 [handbook/10 文档维护与结构](../../handbook/10-文档维护与结构.md)。

## 入口

| 场景 | 文档 | 说明 |
| --- | --- | --- |
| 开工 | [handbook/11-维护任务书](handbook/11-维护任务书.md) | **会话入口（每仓唯一）**，猎手 / 维护子智能体从这里起步；旧开场提示词 [handbook/03](handbook/03-会话开场提示词.md) 已降级为参考差异卡 |
| 历史 | [handbook/AGENTS.md](handbook/AGENTS.md) | 贡献任务简报（代理读）。AGENTS.md 为 2026-10-02 旧简报（历史），现行入口见 [11-维护任务书](handbook/11-维护任务书.md) |
| 仓规 | [handbook/01-仓规与接单流程.md](handbook/01-仓规与接单流程.md) | 硬约定、CI / bot 特性、开场流程 |
| 环境 | [handbook/02-本机环境坑.md](handbook/02-本机环境坑.md) | 平台坑与验证限制 |
| 避坑 | [handbook/10-避坑与模式家族.md](handbook/10-避坑与模式家族.md) | 本仓特有的模式家族与避坑清单 |
| 手册 | [handbook/README.md](handbook/README.md) | 本仓全部规则文档 |
| 查单 | [journal/README.md](journal/README.md) | 逐单索引与分卷 |
| 在途 | [journal/在途快照.md](journal/在途快照.md) | 在途 PR 与盯审 issue 的最新状态（倒序） |

## 本仓分工

角色分工、并行上限与只有主会话做的事见 [handbook/07 分工与并行](../../handbook/07-分工与并行.md)；下表只列本仓各角色写哪里。

| 角色 | 本仓写哪里 |
| --- | --- |
| 哨兵 | `sentinel/` 基线文件（只读巡检，唯一可写） |
| 猎手 / 维护 | worktree 里的分支；交回主会话的报告 |
| 书记 | `journal/` 最后一卷、`journal/在途快照.md` |
| 复盘 | `handbook/`（本仓规则）；跨仓规则上交 [handbook/05](../../handbook/05-失败模式对照.md) |

## docs 结构（2026-10-28 对齐 magpie 式重组）

| 目录 | 记什么 |
| --- | --- |
| handbook/ | 规则：仓规/环境坑/开场提示词/**维护任务书** |
| journal/ | 事实：逐轮维护记录（只追加） |
| README.md | 本页：导航 |

## 政策

政策（可否接新单）、执行方式声明与参考规范只在 [handbook/12 通用纪律与执行声明](../../handbook/12-通用纪律与执行声明.md#政策总表2026-10-28-用户声明) 维护，本页不复制。
