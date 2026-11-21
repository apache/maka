# hunt41-H3 验证日志：#1475 整段回复无名工具调用降级为文本

车道：他人 open、无人认领、小范围可本地验证。日期：2026-10-17（UTC）/ 10-18（本地）。

## 候选筛选

全量 open issue 1014 条（`gh issue list --limit 1200`），滤网：作者非 ggbdpq/yetone、创建超 48h（边界 2026-10-15T18:20Z）、评论 0。命中约 80 条，逐个过标题与正文：

| 候选 | 排除/选定原因 |
| --- | --- |
| #1448 | 报告者自证「很可能不是 magpie 的 bug」（undeclared_tool 来自 Cline API），剩余需真实 Cline key 取证 → 七问第 2 问不过，弃 |
| #2179 | 报告者已自带修复分支 `Essaim8:fix/tool-object-types`（占坑）→ 让位 |
| #1682 | 需真实 Pi 运行时 + bun 插件机制验证，范围偏大 → 弃 |
| #1677 | 多方案（HTTP 探测/文件锁/日志重定向）待产品裁决，非小修复 → 弃 |
| #2289 | 与我方在途 #2530（`hunt/2530-usage-only-models`）同族 → 勿撞，弃 |
| #2274 | compaction 区是维护者近 48h 连续自修+已裁决区（#2642/#2582/#2725/#2727）→ 边界不过，弃 |
| #1391/#1747/#1948/#2381/#2588 等 | Windows/MSIX/Linux/GUI/WebKit 本机难验证 → 弃 |
| 其余 | feature 请求、需真实账号/第三方资源、正文过虚 → 弃 |
| **#1475** | **选定**：报告者真实使用（Qoder 订阅、真机客户端拒绝日志），给出了可复现的洞（whole_stream.go emit 边界无 name 不变量）与修法方向；工具形状修补家族正是我方积累区 |

排雷：#1475 无 assignee、无 label、0 评论（8 天）、open PR 正文搜索零引用；标记物在 b14784c0 仍在（`chatWholeEvents` 只补 `index` 不补 `name`）。

## 根因

- `internal/gateway/chattidy.go` `chatWhole.flush()`：整段 Chat 回复的共根 mend 点（#483 typed content、#1845 文本调用提取、#2611 无 id 补齐都在这里），但对已结构化的 `tool_calls` 中缺 name 的调用不做任何处理。
- 两条消费链都中招：①`stream:false` relay 的整段体原样到客户端；②keepalive 已发头后 `fallback.go` `release()` → `wholeAsStream` → `chatWholeEvents`（whole_stream.go，只补 `index`）→ 客户端拿到无名帧，ai-sdk 拒 `Expected 'function.name' to be a string`，坏调用进历史、会话死。
- 不涉面（已核）：翻译路径对上游整段回复直接 502 failover（gateway.go ~5647 "give up cleanly"），不转换不投递；流式路径空 name 片段已有 `withoutEmptyNames`（维护者自己修的）；Responses/Anthropic 整段路径同形状但无实证客户端失败、无报告 → 记录为 left。

## 修法（最小）

`chatWhole.flush()` 末尾加一道 `withoutNamelessCalls`：function.name 缺失/空/非字符串的调用降级为其自身 JSON 文本（一行一个，接在 content 后），named 调用原样保留；全降级且 finish=tool_calls 时改写为 stop。`tool_calls` 解析失败、content 非字符串非 null、marshal 失败 → 回复原样走。位置在 #2611/#1845 之后（最后一个 mend）。

## RED→GREEN

- BASELINE（b14784c0 + 仅加测试）：`go test ./internal/gateway -run 'TestQuietWholeReplyStreamed|TestWholeReplyNamelessCallAsText'` →
  - `--- FAIL: TestQuietWholeReplyStreamed/chat_with_a_nameless_call_beside_a_real_one`：agent 流收到 `"tool_calls":[{"function":{"name":"get_weather",...},"id":"call_1",...},{"function":{"arguments":"{}"},"id":"call_2",...}]`（第二调用无 name 键），said=`text:Checking.|tool:get_weather {"city":"Paris"}|tool: {}|stop:tool`
  - `--- FAIL: TestQuietWholeReplyStreamed/chat_whose_only_call_has_no_name`：said=`tool: {}|stop:tool`
  - `--- FAIL: TestWholeReplyNamelessCallAsText`：200 整段体带无名调用原样出境
- GREEN（加修复）：同命令 ok；家族测试（TestTextWritten*、TestGLMTextCall*、TestPluginTextWrittenCall、TestEmptyCallID*、TestWholeReplyCallGivenAnID、TestQuietNotAReplyLastFails、TestWholeAsStreamClientReads）ok 6.5s。
- race：定向集 `-race` ok（3.7s，收紧后复跑 2.6s/3.7s 两轮均 ok）。

## Mutation（每个守护单独打破）

1. M2：摘 finish_reason 改写（`!left` 分支）→ 仅 `chat_whose_only_call_has_no_name` 红：`stop:tool` vs `stop:stop`。✓ 定点
2. M3：调用移除但不落文本 → 三处全红（text 缺 JSON）。✓ 定点
3. 无名调用不降级（整体摘除）= RED 阶段证据，三处全红。✓

## 消融（§5.2 显式摘全部产品文件）

产品文件集合 = `internal/gateway/chattidy.go`（唯一）。`git show upstream/main:...` 恢复、保留测试 → 4 条 FAIL（3 用例+父级）；恢复修复 → ok。

## 质量门

- gofmt -l（internal/gateway + docs）：干净。
- go vet -tags nogui：darwin / GOOS=linux / GOOS=windows 三平台干净。
- go build -tags nogui：darwin/arm64、linux/arm64、windows/amd64 三平台 ok（darwin 的 cgo warning 为 trayimage_darwin.go 预存，与本单无关）。
- 全量 `go test -tags nogui ./internal/gateway`：见下方结果行。

## 全量结果

`go test -tags nogui ./internal/gateway -count=1`（最终代码，含 content 守卫收紧）：**ok 332.303s，exit 0**。日志 /tmp/magpie-h3-full-gateway.log。

## 产物

- 提交：`00ba51a4d7139b02b071507a556d3ac9d7f38e16`（分支 `hunt41-h3-1475-nameless-call` @ /tmp/magpie-h3，基 b14784c03），作者 ggbdpq <ggbdpq@gmail.com>。
- patch：`0001-gateway-a-whole-reply-s-tool-call-with-no-name-goes-.patch`，SHA256 `573ef0022a81f8683c193a74251f8067a64c8c8cb977418c906df4db46d70ae7`。3 文件 +109/-4。
- 未推送 fork（无推送授权）；发帖时若只贴分支链接，尾部 AI 项须改为 `written with GLM-5.3-Flash (ZCode)` 形态。

## 未跑项

- 全仓 `go test ./...`（只跑了 internal/gateway）。
- 真实 Qoder 会话（其内置 10-17 已退役转插件；本修为协议级，覆盖一切整段回复的 chat 供应商）、真实 ai-sdk/Pi 客户端对修后网关。
- 流式片段路径的「完整无名调用」（无 id 合成先例可循、name 不可合成；超出本单可实证范围，已在交付中记录为 left）。
