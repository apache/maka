# magpie 文档

magpie 贡献工作区的文档总目录。主仓为 [magpie](../../../magpie-hub/magpie/README.md)，上游为 [yetone/magpie](https://github.com/yetone/magpie)。工作区根为 `/Users/ggbdpq/cc/code/fork/magpie-hub`（Windows 侧 `E:\cc\guahub\fork\magpie-hub`）。

## 分工：一个角色，一个目录

借鉴 yetone 的做法：每条线只盯一个信息源、只对一件事负责，做完要闭环（修完要发、发完要回、翻车要沉淀成规则）。这里不要求开多个 loop，同一个会话可以依次扮演多个角色；但**每个角色只写自己的目录**，别处只读。

| 角色 | 负责什么 | 开工先读 | 只写这里 |
| --- | --- | --- | --- |
| **哨兵** | 巡检上游 issue / PR / 发版增量，判断接不接、有没有被占坑 | [07 哨兵任务书](handbook/07-哨兵任务书.md)、[逐单台账索引](journal/README.md) | 编年当日分册的巡检记录 |
| **猎手** | 复现、修复、验证、写 issue 或 patch 草稿 | [05 狩猎经验](handbook/05-缺陷狩猎经验.md)、[06 开场提示词](handbook/06-会话开场提示词.md)、[08 Windows 规范](handbook/08-Windows工作区与沙盒规范.md)、[10 避坑清单](handbook/10-避坑清单与模式家族.md)、[04 修法方向](handbook/04-修法方向最佳实践.md)（定修法前） | [issues/](issues/README.md) 下本单目录 |
| **书记** | 交付后记账、跟进结局（合入 / 发版 / 关单）、统计成本 | [逐单台账索引](journal/README.md) | [journal/](journal/README.md) |
| **复盘** | 定期清理过期内容，把翻车提炼成规则，规则冲突时裁决 | 近几日的[编年](journal/编年/README.md)、上游 LESSONS | [handbook/](handbook/)，尤其 [10](handbook/10-避坑清单与模式家族.md) |
| **你（人）** | 拍板：对外口径、设计取舍、新规则是否晋升 | 待拍板项 | [design/](design/)、[03 AI 披露口径](handbook/03-AI披露口径决策.md) |

一张单的流转：哨兵发现 → 猎手在 `issues/<单>/` 产出证据并交付 → 书记在编年当日分册追加一笔、在索引改结局 → 复盘把教训晋升到 handbook/10 → 下一轮哨兵、猎手开工时读到新规则。

三条约定：

1. **一份事实只放一个地方。** 规则在 handbook，事实在 journal，原件在 issues，方案在 design。别处只放链接，不复制正文。
2. **没有“待分类”目录。** 新文档按上表归到一个角色的目录；归不进去，说明它还不是一份能用的文档，先留在当天的编年里。
3. **单个文件超过体积预算就拆**，阈值见 [fork/docs/handbook/10 §1](../../handbook/10-文档维护与结构.md)（规则类 30KB，其余 45KB）。编年按日拆，索引按子系统拆，规则按主题拆。

## 目录结构（2026-10-21 整理后）

```
docs/
├── README.md        本页：分工与入口
├── handbook/        规则：怎么做（复盘维护）
│   ├── 01 项目与工程说明      02 维护轮任务书        03 AI 披露口径决策     04 修法方向最佳实践
│   ├── 05 缺陷狩猎经验（05-沿革：历史段）              06 会话开场提示词      07 哨兵任务书
│   ├── 08 Windows 工作区与沙盒规范（历史）              09 路由专项记录        10 避坑清单与模式家族
│   └── 11 狩猎轮机制（狩猎编制与选单正典）
├── draft/           帖稿（discord/）与交接词（handoff/），template/ 可复用模板
├── journal/         事实：发生了什么（书记维护）
│   ├── README.md              逐单台账索引（唯一入口）
│   ├── 索引/                  按子系统的结局分表（入口见索引/README.md，01–05 中文分表）
│   ├── 编年/                  按日分册，只追加
│   ├── 账册/            接单登记·补丁对照·成本台账·采纳统计·候选池·总表（见账册/README）
├── issues/          原件：每单的 patch、草稿、日志（猎手产出）
└── design/          方案：多模型方案、UI 设计稿（人拍板；规则试算已实现，原件在 issues/rule-trial/）
```

## 阅读入口

| 需要了解什么 | 文档 |
| --- | --- |
| **接单前查单：做过没有、同构先例、避坑** | [逐单台账索引](journal/README.md) → [避坑清单与模式家族](handbook/10-避坑清单与模式家族.md) |
| 每单诊断、验证、采纳的全过程 | [编年总目](journal/编年/README.md)（按日分册，只追加） |
| 每单耗时、token、补几轮通过 | [成本逐单台账](journal/账册/成本逐单台账.md)、[采纳统计与快照](journal/账册/采纳统计与快照.md) |
| 哪些补丁写进了更新日志 | [补丁与更新日志对照](journal/账册/补丁与更新日志对照.md) |
| 从跨仓总台账迁入的接单明细 | [接单登记](journal/账册/接单登记.md) |
| 项目用途、目录、贡献通道和工程约定 | [01 项目与工程说明](handbook/01-项目与工程说明.md) |
| 狩猎方法、验证经验与派单提示词（**开场必读**） | [05 缺陷狩猎经验](handbook/05-缺陷狩猎经验.md) |
| 路由领域概念、贡献清单与家族打法 | [09 路由专项记录](handbook/09-路由专项记录.md) |
| 规则试算功能提案与双端验证（已实现待发帖，A1/A3/A4 待拍板） | [issues/rule-trial/](issues/hunt-92/rule-trial/提案-规则试算.md) |

## 迁移沿革

| 日期 | 事项 |
| --- | --- |
| 2026-10-10 | 从 fork/docs 迁入本目录 |
| 2026-10-14 | 台账重组：03-逐单台账拆为 journal/（索引 + 编年全录）；设计稿归 design/ |
| 2026-10-16 | `magpie-hunt-issues/` 迁入并改名为 `issues/`；七份编号手册收进 `handbook/`；archive/ 整体删除（两份 10-10 md 在 cc 仓有 git 历史可恢复）（校注 2026-11-07：cc 仓于 10-25（`22249b41`）与 11-07（`dbdf77a4`）两次重置，本行所指 10-16 前的 git 历史在当前 HEAD 上不可达；10-25 至 11-07 的历史仅在本地未推送分支 `backup-pre-root-20261107`，更早历史能否恢复未核实。） |
| 2026-10-18 | 04 增核对轮 §7；handbook 增设 09 路由专项；08 与 AI 披露澄清移入 `experience/` |
| 2026-10-23 | **design 收敛**：multi-model-plan 与 ui-switchboard 各删 v0.1（v0.2 为带增量说明的完全替代版）；rule-trial 整体迁入 issues/rule-trial/（功能已实现+双端验证，发帖待拍板）。全部内链已同步 | 
| 2026-10-21 | **按角色分工重整**：撤销 `experience/`（→ handbook/03、08）、`feature/`（→ design/rule-trial/，10-23 已迁 issues/rule-trial/）、`unsorted/`（→ issues/hunt43/2642-review-fix/root-cause-analysis.md）；handbook/02、04 是事实记录，移入 journal/；`编年全录.md`（395 KB）按日拆成 journal/编年/；journal/README（86 KB）拆出子系统分表 journal/索引/，避坑清单、模式家族、交付形态晋升为 handbook/10；issues/ 顶层 93 个散文件收进 issues/legacy/early-rounds/（legacy 已整体删除，git 历史 `05867a9f78` 前可溯）（校注 2026-11-07：本行所称 git 历史 SHA 在本机实测不可解析：cc 仓于 10-25（`22249b41`）与 11-07（`dbdf77a4`）两次重置；10-25 至 11-07 的历史仅在本地未推送分支 `backup-pre-root-20261107`。）；删除 .DS_Store 和 issues/legacy 下 29 份沙盒 HOME 里的 Go telemetry 缓存。全部内链已同步改写 |
| 2026-10-25 | ui/switchboard P0 工作状态快照（2026-10-13，原 guahub/docs/archive → fork/docs/archive 中转一日）迁入 [design/ui-switchboard-v0.2/](design/ui-switchboard-v0.2/2026-10-13-P0工作状态快照.md)；这是该分支门禁进度、三处修复与 Windows 测试陷阱的唯一状态记录 |

语言口径（2026-10-17 起）：本目录文档用中文；在 magpie（GitHub）上发布的 issue、评论、回复、commit message 一律用英文，见 [05 文首语言规则](handbook/05-缺陷狩猎经验.md)。

逐单记录的口径：编年中的历史事件只追加更正，不把旧状态改写成今天的状态；索引随事实更新。接单登记保留迁移时的全局单号和原始行；更新日志对照按 issue 去重。全局单号及跨项目预算由 [跨仓总台账](../../handbook/02-接单总台账/README.md) 分配。

## 无产物文件夹的历史单（2026-11-06 查漏补缺定版）

早期单未建产物目录的，状态标记不建文件夹，**新建议目录时直接带状态 emoji 后缀**（如 `3488✅/`）；既有 547 个产物目录已按 2026-11-06 终判加后缀（✅ 已合 main / ❌ 拒绝终局 / 🚧 在途等审）。判定口径：维护者末评 landed 形态（含无声收编 body 点名）→✅；not landing/驳回终局→❌；其余在途（等审/追平/等数据/等拍板）→🚧。
