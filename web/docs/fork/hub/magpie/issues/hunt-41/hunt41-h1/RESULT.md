# hunt41 H1（兄弟面车道）· #2741 内置 Command Code 回放缺 reasoning_content

日期：2026-10-18（本地时间凌晨）。基线：upstream/main `b14784c03fd9e410f34e6aa8ff1ae357dfe6078b`（开工时 fetch，收工前复 fetch 无漂移）。worktree：/tmp/magpie-h1（detached HEAD，基线后本地提交 `72133c0e925268c57ce227c97c1faf32c2a121e7`）。沙盒：HOME=/tmp/magpie-h1-home + XDG_* 重定向，GOPATH/GOMODCACHE/GOCACHE 取自本机 go env，GOTOOLCHAIN=auto，不触网（fake 全部 httptest 本地）。

## 一、候选清单与放弃原因（车道：他人新报告 issue 的兄弟面核对）

筛入口径：作者非 ggbdpq/yetone、创建于 48h 内（全部为 10-17）、评论 ≤2。共 27 条 open（#2726–#2765），非 yetone/ggbdpq 作者候选逐一过：

| Issue | 一句话 | 判定 |
| --- | --- | --- |
| #2763 | effort=none/缺省时组分类器被跳过 | 弃：与我方在途 #2247（effort=auto 分类器，fork fix/issue-2247 等采纳）同区域，撞自家在途 |
| #2764/#2757/#2754/#2742/#2738/#2731 | 蚂蚁接入/打码/Parallel 搜索/自定义计价单位/腾讯 ima/TinyFish | 弃：feature/接入类，非缺陷兄弟面 |
| #2759 | 导入来源下拉显示不全 | 弃：纯 UI 截断，收益边界讲不清，无代码级线索 |
| #2756 | Windows 排除段覆盖网关端口，Settings 误报占用 | 弃：维护者 yetone 17:02Z 已确认并排期（claimed） |
| #2755 | 日消耗柱状图 tooltip 不随万/亿设置 | 弃：日图 tooltip（value/tip）正是我方在途 #2591 patch（fix/2591-sessions-cache @1020b7b4）触碰点，撞自家在途 |
| #2753 | Nahimic 注入致 WebView 黑屏 | 弃：环境/第三方注入问题，非 magpie 代码 |
| #2752 | 最小二乘周期拟合不该用于 deepseek 余额 | 弃：维护者已回复采纳并排期（claimed） |
| #2750 | Claude Desktop 3p 网关组上下文顶棚 | 弃：现场信息不足，无法本机定位 |
| #2747 | OpenCode 会话 ID 映射不持久化 | 弃：报告者已给出深度源码分析，主修复面=持久化设计（存储选型/隐私），属维护者裁决区；报告者已自行点出 LRU 淘汰兄弟面，无未报兄弟面可挖 |
| #2746 | 模型选择器把组的 listed=no 归咎 provider 且点名错组 | 备选未启用（时间让位 #2741）；如后续接手需读 gui note 形成链 |
| #2745 | Sub2API quota_limited 不分 key 额度与钱包余额 | 弃：需真实 Sub2API 实例，本机不可验证 |
| #2744 | 单模型额度用尽冻结整供应商 | 弃：与我方在途 #2167（单模型 429 沉整个 remote，等采纳）同族同根因面，撞自家在途 |
| #2741 | **内置 Command Code stealth/reflection 回放缺 reasoning_content 被 400** | **选定** |
| #2739 | ChatGPT 轮被 8 MiB zstd 窗口重压缩 vs Codex 自有压缩 | 未深挖：compaction 区是我方 #2725/#2727 高密度在途区，且 1 评论未读是否认领；风险大于收益 |
| #2736 | Codex 额度卡「使用积分」不生效 | 弃：无版本、无扣费过程证据，需真实账号验证语义 |
| #2735 | Windows+mise 装的 CLI 探测不到 | 弃：UserBinDirs 六目录正是我方 #2685 fnm 半边在途 patch（hunt38-c）触碰文件，撞自家在途 |
| #2730 | 模式匹配自动入组的模型无法排序 | 弃：疑似声明行为（动态成员无序），无证据推翻产品取舍 |
| #2729 | DeepSeek Search API 建源 + searchHosts 按 host 误判 flash | 弃：接入面需维护者先看新网络地址（报告者自己已按 contributors 规则开 issue 等维护者）；误判面报告者正文已报并点名 #1406 同根因，无未报面 |
| #2726 | dsh web-search-deepseek 被重写到网关 | 弃：维护者逐条确认四点并给出 Plan（claimed）；报告者后续评论在讨论产品方向 |

## 二、七问记录（05 §3.1）

1. **来源**：他人报告 #2741（geeknonerd），真实上游 400（确定性 ~230ms，逐字报错 "Missing required parameter: 'messages[1].reasoning_content'. This model needs the reasoning of every earlier assistant message"）。我方增量=修法+双消费方核对+守护测试。
2. **真实失败**：报告者真实失败在案；我方 RED 是断言级（基线 b14784c0 上新测试两断言红），不依赖构造上游 400。
3. **举证**：RED→GREEN→消融回红→mutation 抓住，全部本轮实测（见四）。
4. **收益**：内置 Command Code（API key）用户在 stealth/reflection 模型上第二轮起每轮必 400；现唯一出路是把模型 disable。受益人、操作、影响面清楚。
5. **边界**：非维护者裁决区；`chatReplaysReasoning` 判定本体最后改动=db024bcd（10-01），686e8a93（10-16）只动 buildHost/failedAsText 未动判定；非 Watched 守护区；发帖前复 fetch 无漂移、issue 仍 0 评论。
6. **兄弟路径与失败读取**：rg 全查记录见三；读失败语义：不适用（判定无文件/网络读取，不匹配=维持现状）。
7. **本人能讲清**：改了什么（判定加内置 host）、为什么（内置 /provider/v1 的 stealth/reflection 拒收无 reasoning_content 的回放轮，内置此前对 /alpha/generate 本就回放、plugin 现在全目录回放）、怎么验证（缝上 RED→GREEN+消融+mutation+全包）。

## 三、兄弟路径 rg 全查（Watched 三条之一）

- `rg -n "chatReplaysReasoning" internal/`：生产消费方 2 处——`buildChat`（internal/gateway/chat.go:273，翻译路径）与 passthrough Chat 分支守卫（internal/gateway/gateway.go:4077，`withReasoningOnToolTurns` 前的 `chatReplaysReasoning(buildHost(p), model) || chatReplaysReasoning(buildHost(p), upstream)`，直通路径）。两处共享同一判定，改判定一处即同时覆盖；测试分别钉缝（buildChat 直传 host 字符串=plugin_parity_test 先例；buildHost(p) 缝由 TestBuiltInCommandCodeBuildsForItsAPIHost 钉住）。
- 同概念兄弟判定（未改，理由在案）：`replaysReasoning`（internal/gateway/responses.go:838，Responses 直通回放）与 `anthropicReplaysThinking`（internal/gateway/anthropic.go:286，Anthropic 回放）——#2741 证据仅 Chat；无任何证据表明 Command Code 的 Responses/Anthropic 端点要求回放。
- `buildHost` 其余 plugin id（cursor/devin/qoder/qoder-cn）：无报告表明其内置读回 reasoning，不改。
- `rg -n "api.commandcode.ai"`：searchModelsHosts（搜索模型）、balance.go:74、planquota.go:49/606、commandcode_plan.go:45（cmdAPI）——额度/余额/搜索概念，不触碰。
- issue 两条附注不触碰：membersIn 不按 served 列表过滤具名组成员（疑声明行为）；400 不触发组 failover（#1765 在案）。

## 四、验证记录（Watched：手拆回红，本轮实测非历史绿）

环境：macOS arm64（darwin 24.6.0），Go 按 go.mod（GOTOOLCHAIN=auto），-tags nogui。

- **BASELINE**（b14784c0，产品文件未动，仅加测试）：`go test -tags nogui -count=1 -run 'TestCommandCodeBuiltInReplaysReasoning|TestBuiltInCommandCodeBuildsForItsAPIHost' ./internal/gateway` →
  ```
  --- FAIL: TestCommandCodeBuiltInReplaysReasoning (0.00s)
      commandcode_builtin_replay_test.go:21: the built-in's API host got reasoning <nil>
      commandcode_builtin_replay_test.go:45: the built-in's tool call without thinking went without reasoning_content: map[role:assistant tool_calls:[...]]
  FAIL
  ```
  TestBuiltInCommandCodeBuildsForItsAPIHost 通过（缝正确：Save 曾因缺 key 报 "Command Code needs an API key"，补 Key:"k" 后该缝绿）。修前第一版 Save 失败已定性并修正测试构造，不是行为红被吞。
- **MODIFIED**（72133c0e：chat.go 判定加 `|| host == "api.commandcode.ai"` + 注释更新）：同 run → `ok`；家族定向（CommandCode|ChatToolTurn|ReasoningOnToolTurns|ResumePrefill|ReasoningDetails|DeepSeekStepLead|DeepSeekAnthropic|MovedBuildHost|PluginToolFailure|PluginReasoning）→ `ok`；全包 `go test -tags nogui -count=1 -timeout 40m ./internal/gateway` → `ok 351.237s`（/tmp/magpie-h1-abl/gateway-full.log）。
- **ABLATION**（05 §5.2 显式摘产品文件）：cp 修复副本 → `git show b14784c0:internal/gateway/chat.go >` 恢复基线（文件级，无 stash/reset/checkout），测试保留 → 同两断言红（逐字同 BASELINE）；恢复副本 → `ok`。
- **MUTATION**：判定改 `return true`（过宽）→ 负向控制红（`commandcode_builtin_replay_test.go:48: api.openai.com was given reasoning_content`）；Mistral 测试仍绿（其豁免在 passthrough 的 `!mistral` 守卫，正确不受判定过宽影响）；恢复副本 → `ok`。判定过窄（移除新条目）=ABLATION 已盖。
- **质量门**：`gofmt -l` 两改动文件 clean；`go vet -tags nogui ./internal/gateway` ok；`GOOS=linux/windows go vet` ok；`go build` linux/windows/darwin（-tags nogui）全 ok。darwin 构建时 internal/gui/trayimage_darwin.go 有一条 cgo `-Wenum-conversion` warning，预存（非本次触碰文件），仅提示。
- **没跑什么**：真实 Command Code key 端到端（无 key，报告者 400 记录代位）；GUI 全套件；非 gateway 其余包全量（判定仅 gateway 内消费）；`-race`（无并发面改动）；glyph-cluster 对回放的实测反应（无真实 API，帖中如实写为唯一行为变化面）。

## 五、产物

- patch：`0001-gateway-the-built-in-Command-Code-s-replayed-turns-c.patch`（format-patch 自 72133c0e，sha256 `5b80ff7dee46d8f10fda18c6a7c4304efbcac9def3cbecbacdb0d0ed70602a4f`）
- 英文待发布稿：`2741-comment.body.md`（五段+Verification 表+没跑什么+版本 C 尾部；patch 以 `<details>` 内嵌 → commit 尾注承载模型名，尾部 AI 项只有承诺句）
- 本日志：`RESULT.md`
- 本地分支：/tmp/magpie-h1 detached HEAD `72133c0e`（未推 fork；推送/发帖待主线程授权）

## 六、收口状态

本地待发布稿，未发帖、未评论、未认领、未推送。主线程复核后按发帖格式发布（长 body 用 --body-file，发后 GET 回读）。
