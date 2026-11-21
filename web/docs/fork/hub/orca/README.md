# orca 项目卡

> **梯队：半月巡检**（每月 1 日、16 日各一轮存量盘点；平时只看哨兵响铃）· 上游 `stablyai/orca` · fork `ggbdpq/orca` · PR base `main` · 形态：直接提 PR

> 记录范围：本文保留截至 2026-10-02 的原核验结果与历史快照；星数、通道数据、CI、环境和在途状态均可能变化，本轮未刷新远端或重新运行验证。Windows + Git Bash 环境节为历史适用范围，macOS 不据此推断已验证。

> 个人跟踪文档，不入库、不进任何 PR 提交。项目：stablyai/orca（TypeScript AI IDE，⭐80k）。
> 预算与跨仓索引见 [handbook/02 接单总台账](../../handbook/02-接单总台账/orca.md)；仓库调研快照见 [handbook/01 接单线程池](../../handbook/01-接单线程池.md)。

## 仓库身份

| 远端 | 地址 | 用途 |
| --- | --- | --- |
| upstream | stablyai/orca | 项目本体，PR 目标 |
| origin | ggbdpq/orca | 我的 fork，PR 分支推这里 |

- 默认分支 `main`，PR base 一律 `main`，分支从 `upstream/main` 切。
- 通道健康（近 40 closed PR 合并 26 个、外部作者 5 人）；**竞争快**：活跃贡献者 AmethystLiang 一天扫过 3 单，看准了当轮就动手。

## 入口

| 场景 | 文档 | 说明 |
| --- | --- | --- |
| 开工 | [handbook/04-维护任务书](handbook/04-维护任务书.md) | **会话入口（每仓唯一）**，猎手 / 维护子智能体从这里起步；旧开场提示词 [handbook/03](handbook/03-会话开场提示词.md) 已降级为参考差异卡 |
| 仓规 | [handbook/01-仓规与接单流程.md](handbook/01-仓规与接单流程.md) | 硬约定、CI / bot 特性、开场流程 |
| 环境 | [handbook/02-本机环境坑.md](handbook/02-本机环境坑.md) | 平台坑与验证限制 |
| 查单 | [journal/README.md](journal/README.md) | 逐单索引与分卷 |
| 在途 | [journal/在途快照.md](journal/在途快照.md) | 在途 PR 与盯审 issue 的最新状态（倒序） |
| 候选 | [journal/候选池.md](journal/候选池.md) | 待条件与让位观察单；狩猎先读，条件变化后重评 |
| 哨兵 | [sentinel/](sentinel/) | 定时只读巡检提示词与基线（.json 基线文件也放这里） |

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
| issues/ | 狩猎原件（诊断/patch/草稿） |
| journal/ | 事实：逐轮维护记录（只追加） |
| README.md | 本页：导航 |

## 政策

政策（可否接新单）、执行方式声明与参考规范只在 [handbook/12 通用纪律与执行声明](../../handbook/12-通用纪律与执行声明.md#政策总表2026-10-28-用户声明) 维护，本页不复制。
