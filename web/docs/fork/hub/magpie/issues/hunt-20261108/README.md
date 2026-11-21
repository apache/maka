# hunt-20261108 狩猎轮（2026-11-08，用户令 5 车道 × 2 单 = 10 单）

- 正典：magpie-hub/AGENTS.md → handbook/11。开场上游 tip `7a2946caf`。
- **并行会话警示**：三场会话（11-07 深夜开场）同时在猎，已占 #5430/#5436/#5445/#5447/#5448/#5483/#5599/#5601/#5606/#5621/#5631；第三方猎手 Gaoshou101 已占 #5600/#5609。一切 take 前重查末评防撞。

## 排雷记录（主线程派工前，11-08）

- 亲单 15 支排除（#5643 #5641 #5628 #5625 #5623 #5616 #5613 #5608 #5607 #5605 #5597 #5594 #5589 #5587 #5635）；feature 7 支（#5633 #5632 #5619 #5595 #5596 #5603 #5604）；已落 #5634/#5639；上不了鱼 #5585/#5591/#5557/#5492。
- 竞争出列：#5600/#5609（Gaoshou101 自带 fix 分支）、#5601（三场 take）、#5592（报告者自带 fork 分支 pr-panel-aggregate）。
- #5622 附上鱼条件：先核 models.dev 数据源，缺数据=不硬凑。spare：#5640（未读正文）。

## 台账

| 车道 | 单号 | 一句话 | 族 | 状态 |
|---|---|---|---|---|
| A | #5612 | Claude 订阅缓存命中 92%，previous_message_not_found 深诊断 | gateway 缓存 | ✅ patch 帖 6711943297 回读 OK（head `aae1bc45b` on tip `2d5d1c1d2`，sha256 前16 `54155e4a75c25bbc` 主线程复算一致；**根因=客户端轮次间抽图→looseTurn 精确 hash 键失配→整段重渲染**，修=whole 密封+mediaLost 容错，文字改动不容忍有负例锁定；上游两笔 relay TTL 修已判未盖本面） |
| A | #5602 | Codex 更新后侧边栏项目索引为空 | agent 索引 | ⚠️出列判定帖 6711971158（magpie 侧无索引迁移代码可修——全仓零引用所述状态键；数据未丢在 inactive，跨账号保留=#5497 同报者 OPEN；翻案条件帖内留档） |
| B | #5642 | s3 同步 >2 机覆盖 Providers/Settings/Profiles | davsync 合并 | ✅ patch 帖 6711874302 回读 OK（head `446d35a1f` on tip `2d5d1c1d2`，sha256 前16 `3bb62abfd5aaf7c7` 主线程复算一致；first 同步空面不清本地面，非 first 空面传播=合法删除不动，#1714 同族先例） |
| B | #5620 | 切换 agent 模型/路由组需重启才生效 | rest/routing | ⚠️让位（生效链全查闭合无断点；running agent 不重读配置=Agent.Notice 文档语义；take 6711800861+结论帖已发，等报告者补 agent 名/步骤） |
| C | #5638 | MCP hub tools/list 对标准 SDK 客户端空 | MCP 协议 | ✅ patch 帖 6711947419 回读 OK（head `e2fa69516`，sha256 前16 `13fa1350f436943e` 主线程复算一致；**根因反转任务书假设=GET/SSE 405 benign 非 bug，真根因=backend.tools 单次 connect 不重试**，慢首启预算耗尽静默回空；修=start 标记 slow+tools 自身预算内重试，spec/SDK 源码引证在帖） |
| C | #5624 | dsh 劫持 ~/.ds-bot（插件禁用时） | agent 数据目录 | ✅ patch 帖 6712907548 回读 OK（head `f38df00cb`，sha256 前16 `d4a6389274ed42ff` 主线程复算一致；根因=DS Bot app 导出 DSH_HOME 注册表值被 dsh 三处无差别采纳；修=appdir.DsbotHome/DsbotOwns 下沉+三处回退 ~/.dsh，DSH_HOME 读取方全仓仅 3 处全覆盖） |
| D | #5627 | 「为你调优」只认 claude/codex+文案错 | 前端+Go 双层 | ✅ patch 帖 6713244406 回读 OK（head `1da52fff5` on tip `d32a7a70c`，sha256 前16 `e91860aa1de823a6` 主线程复算一致；**双层根因=白名单三处+sessions.CallSources 管线不含 qoder**（报告者只指了第一层），修=TuneAgents 单一来源+Others/Unread+空态三因分述 i18n 五语种；与上游 f78d6b0d9 隐藏面板双向合并；预算门 PASS） |
| D | #5622 | DeepSeek 4.1 flash 无价格 | catalog 价格 | ⚠️判定帖 6713245356（**按上鱼条件执行**：models.dev 母厂无裸拼写条目，价挂 canonical `-1017`；suffix-blind 计价违反 catalog「never take an id for another」边界不硬凑；现成出路 Same as→母厂价已实测命中，帖内给报告者） |
| E | nav-guard | #4470 扫荡守卫失守（当前 tip 重验 5/5 仍缺，无一被上游补） | test-only | ✅ 帖 6711463554（#4470 已 CLOSED 系 yetone 自修 ce8b67de3，帖以跟进扫荡失守行文；head `0a4788f1f`，sha256 前16 `47b98fdae251a017` 主线程复算一致；5 文件 147/147 GUI 实跑，agent-details-ready 8000ms 特例如实） |
| E | #5588 | library 移交 symlink skill 删共享条目留幽灵 | library 面 | ✅ patch 帖 6712001998 回读 OK（head `e7d47e1aa`，sha256 前16 `f4af3976b7548bab` 主线程复算一致；importSkill 清链环跳过共享目录 agent+handOver 预检共享条目；报告者分析证实） |

## 六要素复审（11-08，主线程独立复验，用户令逐要素确认）

7 支 patch 全过：①父提交=交付基线且全为 upstream/main 祖先 7/7（基线 2d5d1c1d2/30b7a1732/d32a7a70c/2b08ccc83 随上游推进各记）②父基线 git am 重放 7/7 OK+树 diff=IDENTICAL-EMPTY ③sha256 主线程复算=帖内 7/7 ④定向测试实名重跑@父+patch 全 GREEN（5612 四子例/5642/5588/5624/5627 双测/5638；nav-guard GUI cjs 未重跑，车道实跑 147/147+帖内证据在）⑤消融抽验 #5642 实跑回红（`a's providers after joining: []` 报单同签名）→还原绿，余 6 支消融证据在帖 ⑥兄弟面/实证文本证据 7/7 在帖+产物。复审脚本两处假信号（包路径写错/grep 锚点泄漏）均当场识破并用修正脚本复跑定案。3 支判定单（#5602/#5620/#5622）按判定标准核（无 patch 不适用六要素）。另：tip `d4a6e9315` (#5519) 经查非我方单（无分支），非遗漏。

## 门与铁律

六要素发布门、排雷五查、工程铁律、PATCH 帖格式：同交接词三场版（draft/handoff/handoff-20261107-3.md）与 handbook/11，不在此复制。
