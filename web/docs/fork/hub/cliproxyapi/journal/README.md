# CLIProxyAPI 逐单台账 · 索引（唯一入口）

接单前先到这里：查做过没有、同构先例、本仓特有纪律。逐单全过程按时间线记在编年全录的[分卷](#分卷)（只追加，永不回写）；本索引随事实更新，冲突以全录更晚条目为准。仓库规则与环境坑在 [handbook/](../handbook/)，项目入口见 [hub README](../README.md)。

> 2026-10-21：编年全录（173 KB）切成下方分卷；模式家族、避坑清单移到 [handbook/10](../handbook/10-避坑与模式家族.md)；在途面板移到 [在途快照](在途快照.md)。

## 分卷

> 2026-11-07：卷04（原 85 KB，实含 37 节、写到 2026-10-30）按条目标题边界逐字切为卷04/卷05/卷06；条目数按 `### ` 节标题实数。

| 卷 | 时间范围 | 条目数 |
| --- | --- | --- |
| [卷01](卷01.md) | 2026-09-03 ~ 2026-09-30 | 25 |
| [卷02](卷02.md) | 2026-09-30 ~ 2026-10-03 | 20 |
| [卷03](卷03.md) | 2026-10-03 ~ 2026-10-06 | 22 |
| [卷04](卷04.md) | 2026-10-06 ~ 2026-10-13 | 20 |
| [卷05](卷05.md) | 2026-10-20 ~ 2026-10-26 | 8 |
| [卷06](卷06.md) | 2026-10-27 ~ 2026-10-30 | 9（含 4 节「总台账状态列旧文留存」） |

## 本仓硬结论（先读这个）

- **PR 形态已被数据证伪**（2026-10-07 定型）：上游维护者单人吞吐量 > issue 进货速度，4 个 PR 零合并、2 个形状被采纳（#6370/#6359/#6378/#6422）。**交付形态期望价值排序：方案评论/答疑定性（兑现以小时计）> 高质量 issue 报告 > PR**。PR 仅限：维护者点名欢迎、大功能 design-first 已获表态、竞态类维护者自认难修。
- **translator 禁手**：`internal/translator/**` 改动被 path-guard 机械拦截（push:False 无写权限）——这类单**只评论方案不开 PR**；禁手 ≠ 零贡献，方案评论是 translator 域唯一交付物（#6361 方案评论数小时被落地 16d98881，#5432 提案最终被合并 bcd13ca9）。
- **当日消化模式**：维护者 Luis Pater 常把修复直落 dev（commit message 带 `Closes: #N`），不通知 PR/issue 参与者。**候选动手前必查**：`git log upstream/dev --since="<上次核对>" --format='%h %s' | grep -iE "<关键词>"`。同窗实录：#6378 差 6 分钟、#6311 同窗、#6414 分钟级、#6283 5.5 小时。
- **triage 子代理的"可接"必须过主线禁手终审**（病灶文件路径前缀检查一行命令）；编码子代理开工前的"fetch+病灶实读+Closes 搜索"是撞车止损第一刀。

## PR 总索引

| PR | issue | 一句话 | 结局 | 全录检索键 |
| --- | --- | --- | --- | --- |
| [#5430](https://github.com/router-for-me/CLIProxyAPI/pull/5430) | #5419 | per-chunk usage 提前断流丢工具参数 | ✅ 维护者 cherry-pick `14ee0c84` 保留署名 | PR-001/收尾 09-08 |
| [#5432](https://github.com/router-for-me/CLIProxyAPI/pull/5432) | #5429 | tool_result 内层 cache_control 400 | ✅ 合并 `bcd13ca9`（挂 guard 红叉的提案首次走到合并） | PR-002/PR-011 |
| [#5433](https://github.com/router-for-me/CLIProxyAPI/pull/5433) | #5170 | Home 计费错误映射 402/429 | ↺ 上游取代 `f416175f` | PR-003 |
| [#5511](https://github.com/router-for-me/CLIProxyAPI/pull/5511) | #5499 | assumed levels 下 xhigh 原样透传 | ⏳ 等审 | PR-004 |
| [#5512](https://github.com/router-for-me/CLIProxyAPI/pull/5512) | #5481 | AI Studio thinkingLevel 大写枚举 | ↺ 上游取代 `9dfddd61`（白名单式更保守） | PR-005 |
| [#5514](https://github.com/router-for-me/CLIProxyAPI/pull/5514) | #5476 | 裸 404 冷却 12h→10min 分层 | ⏳ 等审（legacy 多轮解冲突，见在途面板） | PR-006 |
| [#5519](https://github.com/router-for-me/CLIProxyAPI/pull/5519) | #5501 | 冷却只延长不缩短+投影对齐 | ↺ 上游取代 `1c22598d` | PR-007 |
| [#5520](https://github.com/router-for-me/CLIProxyAPI/pull/5520) | #5392 | wsrelay 断连/重连双竞态 | ⏳ 等审 | PR-008 |
| [#5745](https://github.com/router-for-me/CLIProxyAPI/pull/5745) | #5738 | Claude unmanaged betas 透传 | ⏳ 等审 | PR-009 |
| [#5747](https://github.com/router-for-me/CLIProxyAPI/pull/5747) | #5736 | codex 热替换回归锁（tests-only） | ⏳ 等审 | PR-010 |
| [#6167](https://github.com/router-for-me/CLIProxyAPI/pull/6167) | #5874 | 凭据级 disable-image-generation | ⏳ 等审 | PR-011 |
| [#6198](https://github.com/router-for-me/CLIProxyAPI/pull/6198) | #6193 | Sonnet 5.5 工具变更 beta | ↺ 上游专属测试 `a0cc065d` 取代，已关 | PR-012/r15 |
| [#6200](https://github.com/router-for-me/CLIProxyAPI/pull/6200) | #6197 | persist 失败 Warnf | ↺ 上游严格超集 `02548d67`，关单 | PR-013 |
| [#6245](https://github.com/router-for-me/CLIProxyAPI/pull/6245) | #6180 | cooldown-status-code 可配置 | ⏳ 等审 | PR-014 |
| [#6252](https://github.com/router-for-me/CLIProxyAPI/pull/6252) | #6249 | xai grok client pin 1.0.44 | ✅ 合并 `fd48ea68`（含第三方独立验证） | PR-015/Ⅹ |
| [#6262](https://github.com/router-for-me/CLIProxyAPI/pull/6262) | #6259 | antigravity pool 测试 deflake | ↺ 上游等价 `30aa1f12`，关单 | PR-016/018 |
| [#6270](https://github.com/router-for-me/CLIProxyAPI/pull/6270) | #6266 | v8 stream bootstrap 全局键 | ↺ 被结构性取代 `52d5507d`（重归类共享），关单 | PR-017/ⅩⅦ |
| [#6283](https://github.com/router-for-me/CLIProxyAPI/pull/6283) | #6282 | cloak 日期锚定会话 | ↺ 5.5h 被吸收 `6d57ac90`（实现形状逐字节采纳），关单 | PR-019/020 |
| [#6320](https://github.com/router-for-me/CLIProxyAPI/pull/6320) | #6296 | api-call $COOKIE$ 占位符 | ✗ 被拒（generality 不足，产品边界裁决） | PR-021/ⅩⅩⅩ |
| [#6359](https://github.com/router-for-me/CLIProxyAPI/pull/6359) | #6357 | antigravity 流内错误浮出 | ↺ 2 天被取代 `4e4dede4`（形状采纳），关单 | PR-022/ⅩⅩⅥ |
| [#6370](https://github.com/router-for-me/CLIProxyAPI/pull/6370) | #6354 | ws 死连接 fail-fast | ↺ 2 天被取代 `d31b61cb`（内聚更优），关单 | PR-023/ⅩⅩⅥ |
| [#6378](https://github.com/router-for-me/CLIProxyAPI/pull/6378) | #6376 | 断连后 usage 按成功结算 | ↺ 6 分钟趋同 `a4acc9f7`，关单 | PR-024/ⅩⅩⅦ |
| [#6422](https://github.com/router-for-me/CLIProxyAPI/pull/6422) | #6421 | vertex 同款 usage 结算 | ↺ 不足 1 天被取代 `dbc4aad9`（变量名同构），关单 | PR-025/ⅩⅩⅦ |
| [#6497](https://github.com/router-for-me/CLIProxyAPI/pull/6497) | #6469 | Codex SSE metadata 诊断 | ⏳ 等首评（bot 六轮意见全修） | r10-r15/MC-11 |

分析/答疑/方案评论（无 PR）择要：#5504 证伪、#5466 设计对齐、#6099 v8 已实现答疑、#6178 环境病定性、#6261 诊断、#6255 设计输入、#6284 混池答疑、#6286 apply_patch 答疑、#6311 撞车收尾、#6312 禁手剔除、#6349 插件端口指路、**#6361 url_citation 方案评论→数小时被落地**、#6362 C2 提案（closed not_planned，design-first 止损两例）、#6395 代理设计定性（closed not_planned）、#6469→#6497、#6501/#4953 互指。

## 维护

新条目追加到最后一卷（现为 [卷06](卷06.md)）文末，按时间线；最后一卷超过约 45 KB 时新开下一卷并在上面分卷表加一行；再回本索引更新 PR 行，在途状态写 [在途快照](在途快照.md)，模式家族写 [handbook/10](../handbook/10-避坑与模式家族.md)。（原文指向「编年全录（README.md）`<!-- 新记录追加在这里 -->` 锚点」，该锚点随 2026-10-21 分卷已不存在。）
