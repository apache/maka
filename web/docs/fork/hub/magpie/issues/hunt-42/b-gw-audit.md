# hunt42-B 车道审计记录（本地中文，绝不发帖）

轮次：hunt42 B 路（gateway 协议翻译与流车道）。实际审计 SHA：upstream/main `5380114d`（开工与收尾两次 fetch 一致，期间未动）。
worktree：/tmp/magpie-hunt42-b（分支 hunt42/b），本轮零代码改动，工作区干净。

## 一、候选单判定

### #2763（Gruu6y，0c，[feat]）——判定：维护者裁决区，不发 patch；跨链评论已发（更正前）
- 报告者表格逐行核验与当前代码一致：
  - `"none"` → chat.go:84 `effortOf("none")="low"` + chat.go:92 `ThinkOff=true`；rules.go:273 `!req.ThinkOff` 拦住咨询。
  - bare / `"auto"` → ir.go:729 `effortOf` 归一为 ""，hit.Effort=="" 且 Thinking=false → 不咨询。
- 裁决链：#2247 维护者 8ef14be3e 合入（10-14，基于我方复现交付）；锁定测试 `TestJevLeavesReasoningOff`（decide_test.go:437）；产品 help 文案 groups_cli.go:108 "only those the agent asked to reason, **never one it turned off (none)**"；10-17 sryimnoob123 复验 PASS（bare 行为"和旧一致"也在复验里确认）。
- 报告者提案（none/absent 视为"无偏好"并让 pick 覆盖）需同时改 rules.go:273 与 withEffort（decide.go:593-600 现拒改写 none/空档位）——等于推翻三天前裁决+产品文案。七问 #5 不过。
- **已执行写操作（协调者更正送达前）**：#2763 发评论 issuecomment-6242594379；首帖误带中文内部记录头，约 1 分钟内 PATCH edit 为纯英文并回读核验（grep 中文 0 命中）。GitHub 评论 edit 无公开历史，仅 edited 标记。事故与修法记录在 b-2763-classifier-none-comment.md 头部。
- 若主线程需要：该评论现在内容即 /tmp/hunt42b-2763-comment.md 同文。

### #2768（li1how，0c）——判定：跳过不接；备英文待发稿 b-2768-comment.md（未发）
- 四道闸：①未认领 ✓ ②范围小 ✗（URL+key+WSL distro discovery+profiles+sync+rotation 多面联动）③本机可验证 ✗（WSL2 NAT 端到端 macOS 无法复现；单测可做但价值有限）④知识交集 部分（#1485/91581fca WSL NAT MCP 中转同族）。
- 三层排雷：报告者明说 "Historical local-fix tests... The new tests failed when the original implementation was restored"——自带本地修复+回归测试（Stable/Insiders/profiles/sync/选型/轮换全覆盖），先让位；_expected behavior_ 是设计规格（该选哪个 endpoint、sharing 关闭时怎么办），维护者裁决面。
- 代码面核验：vscodeURL（vscode.go:405）=gatewayV1()+"/chat/completions"；vscodeGroupJSON（:410）写 entry url=:405、requestHeaders=k.token()（:429/:436）；报告者解读准确。
- 待授权动作：是否把 b-2768-comment.md 发上 #2763 之外的 #2768（短评，指向报告者自带 patch 是更快路径）。

## 二、车道审计面（全部排零）

### 面① emptyAssistant vs silentAssistant 分歧（chat.go:660 vs :680）
- silentAssistant 不认 reasoning_content（#2599 本意：DeepSeek 视其为非 content）；emptyAssistant 认。
- 消费顺序：buildChat 先 withoutSilentAssistants（:454）后 pairToolMessages（:455），reasoning-only 空轮在配对前已删，:612 的 emptyAssistant 分歧面只剩：refusal（:687 保）、audio（:684 保）、legacy function_call（:684 保）、prefix/partial（保）落到 612 且处于 pending 交换中间时的判定差异——refusal/audio/function_call 会在 612 被丢。
- 定性：emptyAssistant 来自 #554（2e1fcb8a，老代码），上述丢弃面 #2599 前后不变，触发形状病态（refusal/audio 轮恰好落在并行 tool_calls 与其结果之间），收益讲不清。排零。
- #2599 实际把 612 的 reasoning-only 轮行为改好了（旧：到达 612、emptyAssistant 判非空、闭合交换、tool 结果转 user；新：提前删掉）。

### 面② chat.go:351 vs :366 Resume 索引不一致——不可达潜伏陷阱
- 351 `!(r.Resume && i == len(r.Messages)-1)`，366 `r.Resume && i == len(turns)-1`，循环遍历 turns=joinSplitCalls(r.Messages)。有 join 时 len(turns)<len(r.Messages)，351 判"最后一轮"永久失准→Resume 末轮 think 会 inline 进 content。
- 不可达证明：inlineThink（:279）仅 minimax.io/minimaxi.com 后缀 host 为真；r.Resume 仅在 continuation.possible()（mode != ""）→ chatPrefill（continuation.go:222-246：deepseek/kimi，含本机/局域网 relay）非空时才可能置真（continuation.go:264,271-277,301）。两 host 集合不相交（minimax 后缀→chatPrefill 返回 ""）。死分支。
- 来历：两行均为 #2599 前老代码；ed0335f75 commit 自述的"its Resume check compared a joinSplitCalls turn index with len(r.Messages)-1"指 ggbdpq 原 patch（cb438ebb）的缺陷，重写的"修法"是不引入该处理，351/366 未动。若未来 MiniMax 获得 prefill mode，此处会变成活缺陷——记为潜伏陷阱。

### 面③ withoutSilentAssistants × compact seal 交互——排零 + 一个低值疑点
- 两规则协议层不相交：withoutSilentAssistants 只碰 Chat messages 数组（buildChat 产物 + Chat 直通 silentAssistantsOut@chattidy.go:432/gateway.go:4079）；seal 只活在 Responses input items（checkpointOf@native_compaction.go:206）。
- seal 在候选层前置过滤（serve@gateway.go:1973-1983 → checkpointReaders@native_compaction.go:289 只留 writer 的 who()），writer 必有 Responses base（CarriesCompaction@provider/native_compaction.go:16-21），翻译到 Chat 正常不可达。
- parseResponses 的 input 项 switch（responses.go:291-384）无 compaction 分支——未知类型静默丢弃；但 magpie 自家 summary 在进 serve 前已由 codexInputAs 恢复为 userMessage（gateway.go:1427-1433、codex_backend.go:1583-1593），到翻译层的只剩外来 seal。
- 上游拒绝外来 seal 的显式兜底在 gateway.go:2833-2840（withoutCompaction 重试，`checkpoint==nil && !compactsNatively` 才允许）。
- joinedUserContent（chat.go:764-794）：append 前 slices.Clip 防别名、caller maps.Clone，跨轮字节稳定（缓存友好）。无缺陷。
- **疑点（不发作，留档）**：多 API writer（Responses+Chat 双 URL 的 relay，NativeCompaction 开）在 Responses 端变 unfit/wrongEndpoint 后，重试翻译到自家 Chat API 时 compaction item 被静默丢弃（parse 无分支）——压缩摘要对该 try 无声消失。条件叠四层，"正确行为"本身可辩（拒 400 断会话 vs 静默降级上下文），七问 ②④⑤ 过不了，不发。#1099 的"never to another, to be refused, dropped or summarised"是否覆盖同账号另一 API，属维护者解释面。

### 支线：7ba1b498（plugin resets）与 2c72563d（callerKey 拆分）
- 7ba1b498：host.js 透传 resets.team/each，唯一消费方 plugin_usage.go:144-155（movedCards→ResetCredits），自带红测试。低产已审区（P4 插件页）。排零。
- 2c72563d：usage Requests key 过滤/拆分——usage GUI 区（公司机车道），不碰。

## 三、已执行写操作申报（更正前）
1. 2026-10-18，#2763 发评论（issuecomment-6242594379）：跨链说明 #2247 裁决链。约 1 分钟后发现误带中文内部头，PATCH edit 修正为纯英文，回读核验无中文残留。无其他任何 GitHub 写操作（无新 issue、无 push、无 PR、无 claim）。

## 四、没跑什么
- 本轮零代码改动：gofmt/vet/三平台 build 未跑（无可验改动；worktree 与 upstream/main 5380114d 逐字节一致，git status 干净）。
- #2763/#2768 均未构造全链路复现（判定不依赖：裁决链与代码引文均已逐行核到当前 tip）。
- 面③疑点未做全链路红测试（叠加条件无法在本机构造出真实失败）。
