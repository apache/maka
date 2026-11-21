# litellm 项目卡

> **梯队：半月巡检**（每月 1 日、16 日各一轮存量盘点；平时只看哨兵响铃）· 上游 `BerriAI/litellm` · fork `ggbdpq/litellm` · PR base `main` · 形态：直接提 PR

项目：BerriAI/litellm，Python ≥3.10（uv 锁；SDK+proxy 双形态）。**CLA 必签**（[cla-assistant.io/BerriAI/litellm](https://cla-assistant.io/BerriAI/litellm)）——合并前法律要求，PR 可开、签前不合并。proxy PR ≥1 测试硬要求；验证矩阵=`make lint` + 定向 `uv run pytest tests/unit/<file>.py`（CI 跑全量）。根带 AGENTS.md（禁 AI slop 注释、测试要有牙）。

跨仓预算与索引见 [handbook/02 接单总台账](../../handbook/02-接单总台账/litellm.md)。

## 入口

| 场景 | 文档 | 说明 |
| --- | --- | --- |
| 开工 | [handbook/04-维护任务书](handbook/04-维护任务书.md) | **会话入口（每仓唯一）**，猎手 / 维护子智能体从这里起步；旧开场提示词 [handbook/03](handbook/03-会话开场提示词.md) 已降级为参考差异卡 |
| 查单 | [journal/README.md](journal/README.md) | 逐单索引与分卷 |
| 在途 | [journal/在途快照.md](journal/在途快照.md) | 在途 PR 与盯审 issue 的最新状态（倒序） |

## 本仓分工

分工与并行上限见 [handbook/07 分工与并行](../../handbook/07-分工与并行.md)；本仓发布权按 [07 §4](../../handbook/07-分工与并行.md#4-只有主会话做的事)（主会话复核后推送、开 PR、对外评论；子智能体自行发布只限 magpie / maka）。

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

见 [handbook/12 政策总表](../../handbook/12-通用纪律与执行声明.md#政策总表2026-10-28-用户声明)（唯一事实来源；执行方式声明与参考规范在同页）。
