# cc-switch 项目卡

> **梯队：存量维护（2026-10-27 起停止接新单）** · 上游 `farion1231/cc-switch` · fork `ggbdpq/cc-switch` · PR base `main` · 形态：直接提 PR（不再新增）

> **停接决策（2026-10-27 用户定版）**：上游 `CONTRIBUTING.md` 新规（[df511e82](https://github.com/farion1231/cc-switch/commit/df511e82) 起，L223/L482）要求 PR 模板「Human Note / 本人说明」必须本人手写、AI 代写可能不经 review 直接关单——与 AI 辅助贡献工作流冲突，本人目前没有脱离 AI 熟悉项目的能力，故不再开新 PR。**存量 open PR 维护到终态**（合并/关闭）：2026-11-08 实测 8 个；**#8111 已于 11-02 合并=本阶段首个终态**（farion1231 squash `686ba51ef`，author=ggbdpq 署名无损，「小七」系 squash 显示名规范化）。等待面=farion1231 合并三 LGTM 单（#7821/#7829/#7817）+ 复审 #7814。维护口径见 [handbook/04-在途维护提示词.md](handbook/04-在途维护提示词.md)。原「主力梯队、11 月解禁接单」条目作废。

> 记录范围：本文保留截至 2026-10-02 的原核验结果与历史快照；星数、通道数据、CI、环境和在途状态均可能变化，本轮未刷新远端或重新运行验证。Windows + Git Bash 环境节为历史适用范围，macOS 不据此推断已验证。

> 个人跟踪文档，不入库、不进任何 PR 提交。项目：farion1231/cc-switch（Rust+TS 供应商切换工具，⭐138k）。
> 预算与跨仓索引见 [handbook/02 接单总台账](../../handbook/02-接单总台账/cc-switch.md)；仓库调研快照见 [handbook/01 接单线程池](../../handbook/01-接单线程池.md)。

## 仓库身份

| 远端 | 地址 | 用途 |
| --- | --- | --- |
| upstream | farion1231/cc-switch | 项目本体，PR 目标 |
| origin | ggbdpq/cc-switch | 我的 fork，PR 分支推这里 |

- 默认分支 `main`，PR base 一律 `main`。**竞争极快**（当天甚至当上午被抢；#7760 实测撞车窗口 2 分钟）——抢坑者常不评论直接开 PR，排雷必须翻 open PR 列表标题。

## 入口

| 场景 | 文档 | 说明 |
| --- | --- | --- |
| 开工 | [handbook/04-在途维护提示词](handbook/04-在途维护提示词.md) | **会话入口（每仓唯一）**，猎手 / 维护子智能体从这里起步；旧开场提示词 [handbook/03](handbook/03-会话开场提示词.md) 已降级为参考差异卡（**接单功能已停用**，仅存量维护参考） |
| 在途维护 | [handbook/04-在途维护提示词.md](handbook/04-在途维护提示词.md) | 存量 open PR 维护到终态的唯一口径（2026-10-27 迁入，原维护提示词.md 第 1 块） |
| 仓规 | [handbook/01-仓规与接单流程.md](handbook/01-仓规与接单流程.md) | 硬约定、CI / bot 特性、开场流程 |
| 环境 | [handbook/02-本机环境坑.md](handbook/02-本机环境坑.md) | 平台坑与验证限制 |
| 查单 | [journal/README.md](journal/README.md) | 逐单索引与分卷 |
| 在途 | [journal/在途快照.md](journal/在途快照.md) | 在途 PR 与盯审 issue 的最新状态（倒序） |
| 哨兵 | [sentinel/](sentinel/) | 定时只读巡检提示词与基线（.json 基线文件也放这里）；2026-11-07 核：现仅存 [archive/](sentinel/archive/README.md) 两份退役模板，路径已失效 |

## 本仓分工

分工与并行上限见 [handbook/07 分工与并行](../../handbook/07-分工与并行.md)；本仓发布权按 [07 §4](../../handbook/07-分工与并行.md#4-只有主会话做的事)（主会话复核后推送、开 PR、对外评论；子智能体自行发布只限 magpie / maka）。本仓政策见 [handbook/12 政策总表](../../handbook/12-通用纪律与执行声明.md#政策总表2026-10-28-用户声明)。

| 角色 | 本仓写哪里 |
| --- | --- |
| 哨兵 | `sentinel/` 基线文件（只读巡检，唯一可写） |
| 猎手 / 维护 | worktree 里的分支；交回主会话的报告 |
| 书记 | `journal/` 最后一卷、`journal/在途快照.md` |
| 复盘 | `handbook/`（本仓规则）；跨仓规则上交 [handbook/05](../../handbook/05-失败模式对照.md) |
