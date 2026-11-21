# hunt62 Lane C：#1418 第三方补丁（Aliceonly c6dbabe2）评估

日期：2026-10-22 · worktree：/tmp/magpie-r62-c（分支 hunt62-c-1418-aliceonly-eval，基线 87d703c5，已还原干净）· 未 push 未发帖

## 判定

**(a) 确认/对照（修正版）——发第三方独立复核帖，无让位、无冲突。**

- 我方在 #1418 **没有 patch 交付**：ggbdpq 在 issue 里只有 2026-10-09 两条分析评论（candidates 循环条件枚举、Codex 客户端自渲染文案溯源），维护者据此修掉了**早期面**。「#1418 双触达」教训是并行会话各发一条分析评论的事故，不是 patch 记录——**简报前提「我方 patch 形态见 issue 内 ggbdpq 评论」与 issue 实况不符**，本单按实况改判。
- Aliceonly 的补丁（c6dbabe2，2026-10-18 推送供 review）针对的是**至今未修的最新面**（hosted web_search_call 放行 → mid-stream overload 成 late failure），是唯一涉及该面的补丁。
- 故 a/b/c 三选中：无冲突对象（我方 hunk 数为 0），无让位对象（无我方 patch），正确动作 = 以第三方身份对 Aliceonly 补丁做独立复核确认帖：确认面在当前 main 仍在、独立重放红绿、指出两个 review 问题。这在功能上等价于「互补」——补丁与我方已交付的分析、维护者已落的修复互不重叠且组合成立。

## issue 面拆解与对照矩阵

| 面 | 内容 | main tip 87d703c5 | Aliceonly 补丁 | 我方交付 | 判定 |
| --- | --- | --- | --- | --- | --- |
| A. 错误词表分类（10-09 初始：at capacity 不入词表；real-jacket 补的「上限」误入 usedUpWords 同族） | failure() 词表分类 | **已修**（e9ae31858 等四连修） | 不触碰 | 10-09 两条分析（词表枚举/条件枚举/文案溯源）诊断此面 | 无 hunk 相交；分析与补丁不同物 |
| B. 纯协议帧提前放行（10-12：未知帧算正文 → 提前 pass） | holdWriter scan/streamEvent | **已修**（301e25c1 #248 谱系引入 said()/replyEvent；a68d2ac94） | 保持其行为（未说事件仍 eventLead 持住，`TestResponsesProtocolFramesStillFailOver` 守护） | — | 一致，无冲突 |
| C. **hosted web_search_call 放行（10-15：搜索项算 said → pass → 后续 overload 成 late failure，候选不再被问）** | 同上 | **未修**：`streamPart.said()` 对含 "call" 的 item 类型返回 true（fallback.go ~2733-2741），`replyEvent` 匹配 `output_item.` 前缀与 `_call` 进度 → eventContent → scan() default → flow()。tip 的 streamEvent 尾注引用 "(Aliceonly on #1418)" 是 B 面修复，C 面仍在 | **正是此面**：新增 eventSearch 分类；搜索事件持住；`limitSearchHold` 以既有上限（holdLead=4min / holdMost=1MB / alive.tooQuiet）本地取消（failHeldLimit，不 rest、不 replan、不 release） | 无 | **补丁独占此面**；与 main 无语义冲突 |
| D. 真实内容已交付后的 mid-stream overload（正文/reasoning 已 pass 后断流） | 候选循环边界 | 未修（issue 因此仍开） | 明示不覆盖（commit message："does not recover already-committed content"） | — | 双方一致视为开放边界 |

**10-15 真实 trace 覆盖核验**：trace 形状是 reasoning → web_search_call(completed) → reasoning → response.failed。`hw.thinkingShown = !refusesAfterThinking(model) || last`（gateway.go:2428），GPT/Claude/Gemini 家族模型 `refusesAfterThinking` 为真 → 非末位候选 thinkingShown=false → reasoning 持住不下；补丁再把搜索持住 → response.failed 到达时无物已发 → 走既有下一候选/Patience replan。**真实事故形状在覆盖内**。末位候选（thinkingShown=true）reasoning 直通后的 late failure 属 D 面，非本补丁范围。

## 文件/hunk 相交矩阵（补丁 vs main tip）

补丁 8 文件（+91/−17 fallback.go；+20/−3 gateway.go；+3 routing.go；±2 overload_test.go；新增 search_fallback_test.go 482 行、search_hold_test.go 338 行；+10/−1 client.js；+16 i18n.js；+92/−10 routing-went-on.test.cjs）。基座 d783df46 落后 tip 272 提交。

| 文件 | 三方合并结果 | 冲突内容 |
| --- | --- | --- |
| internal/gateway/gateway.go | 干净合并 | serve() 循环 modelRetired/tooLong/canceled 三处加 `heldLimit` 豁免 + 新增 heldLimit 分支（不 rest、skip 下一候选或 failTo） |
| internal/gateway/routing.go | 干净合并 | 新增 `failHeldLimit = "held_limit"` 常量 |
| internal/gateway/overload_test.go | 干净合并 | 2 处期望 eventContent→eventSearch |
| internal/gui/tests/routing-went-on.test.cjs | 干净合并 | held_limit try 的 Routing 叙事测试 |
| internal/gateway/fallback.go | **1 处冲突，机械** | holdWriter 结构体：HEAD 加了 `thoughtThrough`，补丁同位加 `searchHeld`/`heldLimit`——并排保留；合并后 scan() 即补丁形状且保留 tip 的 thoughtThrough 赋值，语义连贯 |
| internal/gui/assets/plugins/routing/client.js | **1 处冲突，机械** | FAIL 表：HEAD 加 `room:`，补丁加 `held_limit:`——并排保留 |
| internal/gui/assets/plugins/routing/i18n.js | **4 处冲突，机械** | 四语言词典：HEAD 与补丁各加相邻词条——并排保留 |

我方与该补丁的 hunk 相交面：**零**（我方在 #1418 无 hunk）。

## 验证记录（tip+补丁三方合并树，冲突按并集解决）

| 检查 | 结果 |
| --- | --- |
| `go build -tags nogui ./internal/gateway/` | OK |
| `go vet -tags nogui ./internal/gateway/` | OK |
| `gofmt -l internal/gateway/` | 空 |
| 补丁新测试全量（TestResponsesHostedSearch* 6 函数、TestResponsesProtocolFramesStillFailOver、TestResponsesSearchAPIFollowupFailsOver、TestHeldSearch* 8 函数，约 30 子测试） | **全绿**（5.2s） |
| **消融**（streamEvent 分类 eventSearch→eventContent，= tip 现行为，测试保留） | `TestResponsesHostedSearchFailsOver` 9/9 子测试红 + `TestHeldSearchLimitsDoNotRelease` 红——**修前会挂实锤**，与 Aliceonly 声明一致 |
| 既有 #1418 家族（TestGroupWaitsOutEveryMemberOverloaded、TestCodexStreamWaitsOutOverloadedGroup、TestFramesThenOverloadedGoesToTheNext、TestPatienceIsUsedUp、TestAgentGoneInTheRetryPause、TestSafetyBufferedStreamHeldLonger） | 全绿（12.7s）——与已落机制组合成立 |
| 未跑 | 全量 gateway 套件（~320s）、-race、GUI cjs 测试、真实过载上游、五语言 GUI 截图 |

## 两个 review 问题（评论草稿核心增量）

1. **范围**：只收窄 `web_search_call`。`said()` 对 `server_tool_use`、`mcp_tool_use` 等一切含 "call"/"tool"/`mcp_` 前缀的 item 仍返回 true → 同样的 late failure 在那些 hosted 工具后依然存在。Aliceonly 自述 scope-limited，值得维护者确认是否为有意分期。
2. **等待上限**：`limitSearchHold` 复用 `holdLead`，tip 上 `holdLead = holdThinking = 4 分钟`。补丁前搜索事件一到就放行（>4 分钟的真实搜索能完成）；补丁后持住到 4 分钟即本地 504+换候选（单成员时 agent 直接吃错误）。罕见但是唯一的回归类；值得问 completed 之后是否放宽上限、仅在搜索进行中保持紧上限。

其余设计点（held_limit 不 rest/replan/release 与 #1421 本地上限方向一致；成功回复的搜索输出原样延后交付；400 后不 failover；五语言文案）均核过，成立。

## 评论草稿

见同目录 `1418-comment.body.md`（英文、零中文、确认类无尾部无 Attribution）。要点：面在 tip 仍活的代码定位 → 与 10-15 trace 形状吻合（thinkingShown 核验）→ 重放面（3 文件机械冲突）→ 独立红绿验证表 → 两个 review 问题 → 未验证清单。

## 不确定项

- Aliceonly 未在 issue 给出分支名（只给了 commit 链接），评论草稿只引 commit。
- 维护者 10-13 后未再回应 10-15 报告与 10-18 补丁帖（issue 最后一条评论即补丁帖）；草稿假设维护者尚未读过补丁，若已私下沟通，帖子的「独立复核」定位不变。
- 草稿未验证 GUI cjs 测试与 -race（本机未跑），评论里如实列为 not run； Aliceonly 自述 race×3 与五语言 20/20 已过，不代其背书。
- 简报所述「我方 patch」在 #1418 不存在，若主线程另有所指（如其它单的 #1418 机制后续 patch，如 #2455 streamless），与本补丁亦无 hunk 相交，判定不变。
