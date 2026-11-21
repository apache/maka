# hunt68 Lane C — #2622 验证记录（本机，中文内部稿）

日期：2026-10-23。执行目录：`E:\cc\guahub\fork\magpie-hub\magpie-hunt68-c`（分支 hunt68/c）。

## 基线

- 任务书基线 85534cd0；动手 fetch 发现 origin/main 已前进至 **3b8bcc36**（10 个新提交），hunt68/c 已 ff 到 3b8bcc36。
- `git diff 85534cd0..3b8bcc36` 核对：`chat_tool_shape.go`、`kimi_schema.go`、`oneof_schema.go`、`anthropic.go`、`chat.go` 零改动；gateway.go 的 78 行改动与 shapeChatTools/kimiTool/toolOneOf/forwardOnce/liftMessageTools 零相关行（grep 计数 0）。结论对 85534cd0、3b8bcc36、v0.1.1277（含 72d6103e）同时成立。

## 三问答案

**(a) jinyue806 的 $ref 根因在当前 main 是否仍触发坏形态？是。**
`$ref` → `$defs` 项含 `oneOf` 的 schema 在 Chat→Chat 直通路径上逐字节直通上游（TestProbe2622RelayChat 断言级证据）。forwardOnce 链上全部 schema 内容变换对 sensenova host 闭门：
- `toolOneOfAsAnyOf`（oneof_schema.go:20）：仅 Cline/Kilo/openrouter.ai；
- `kimiToolEnumTypes`/`kimiToolRefTypes`（kimi_schema.go:66 isKimi）：仅 moonshot/kimi host 或 preset 前缀；
- `deepseekToolPatterns`/`grokToolPatterns`：各自 host/preset。
TestProbe2622ChainGates 逐个断言 body 不变。

**(b) 是否就是报告者 400 的同一形状？存活的缺陷维度是，且独立成因为其 A/B 所证。**
原始失败请求同时携带两种缺陷：MCP 平铺外壳（`Tools[0].Type invalid`，c0 直连实验 + 维护者 commit message 均证）与 4 个 rea 工具的 `$ref`→oneOf schema（c6 穷举树切分）。jinyue806 c6 的对照组只翻 schema 维度（内联 oneOf 4/4 过 vs `$ref`→oneOf 4/4 挂），外壳恒定，故 schema 缺陷独立成因。72d6103e 只修了外壳；schema 半边仍原样出网。原始 5 次失败无法回溯性归因于单一原因（两者同在且各自独立致命），但报告者原场景（zcode + rea + sensenova）在当前 main 上仍会发出被上游拒绝的形状——**前提是 c6 的上游实验成立（本机无 key，未复跑）**。

**(c) shapeChatTools 对该形态做了什么/没做什么？**
只重排外壳：name/description/strict + parameters(←parameters/inputSchema/input_schema) 挪进 `function`，补 `type:"function"`（chat_tool_shape.go:23-81）；parameters 内容以 json.RawMessage 原样搬运（:60-67），零 schema 检查。标准外壳请求整体早退、逐字节原样（:38-39 早退分支，探针断言 byte-for-byte）。调用点两处：gateway.go:1465（handle）、chat.go:78（parseChat）。

## 对 jinyue806 c6 的逐点核实

| c6 论点 | 核实结果 |
| --- | --- |
| 真根因 = `$ref` 指向含 oneOf/anyOf 的 `$defs` 项 | 形状层面本机证实（直通）；上游 4/4 拒绝未复跑（无 key），维持其证据地位 |
| 对照组（内联 oneOf 过、`$ref`→object 偶发挂） | 与本机「magpie 对一切 schema 无差别直通」一致；偶发失败原因不明，未查 |
| c0「`$defs`+`$ref` 全 200」与 c6 矛盾？ | 不矛盾：c0 测的是普通 `$ref`，未命中 `$ref`→oneOf 组合 |
| 「`inference request is invalid` 是 magpie 外层兜底」 | **错误**。`grep -rn "inference request" internal/ --include=*.go` 零命中（exit 1）；`reason=unknown`/`retryable=false` 同样零命中。是客户端（zcode）的包装文案，维护者 c3 判断与我方 c4 判断正确 |
| 修法建议（sensenova 出口内联 oneOf） | 属修法拍板，不评估；记录在树最近亲：kimiToolRefTypes（129d8b08，2026-10-19，补 type 而非内联，Kimi only，anyOf 目标有意不动）、toolOneOfAsAnyOf（改名 oneOf→anyOf，Cline/Kilo/OpenRouter） |
| 触发面（rea 207 工具中 4 个）与历史（1469 次成功、rea 10-15 才出现） | 未验证（依赖其路由日志，本机无数据） |

## 兄弟面（同一根因的同病形态面）

1. **一切严格校验的 OpenAI 兼容 chat host**：同一直通，无任何覆盖（sensenova 只是已报实例）。
2. **Chat→Messages 翻译**：schema 原样进 `input_schema`（探针 value 级断言）。anthropic.go:1678 `objectSchema` 只处理**根级** oneOf/anyOf/allOf（#646 先例）；`$ref`→oneOf 在 items 下非根级，直通。Anthropic 是否接受未测。
3. **Chat→Responses 翻译**：schema 原样进 `parameters`。
4. **Kimi/Moonshot**：129d8b08（10-19）已为 zod 风格 `$defs/__schemaN` 补 type——同一 zod `$defs` 家族形状在别处已需要修，sensenova 面无对应物。
5. **Cline/Kilo/OpenRouter**：xgrammar 拒 oneOf，已有 oneOf→anyOf 原位改名。
6. **DeepSeek/Grok**：pattern 字符串修正，同族「按 host 打补丁」模式，成员持续按报告逐个增补。

家族模式：识别名单漂移/按厂商逐个打补丁——每个新 host 的 schema 校验怪癖都要等一份报告。

## 命令与输出（相称矩阵）

```
export PATH="/d/DevTools/Env/mingw64/bin:$PATH"; export CGO_ENABLED=1 GOTOOLCHAIN=auto GOPATH=E:/gopath GOMODCACHE=E:/gopath/pkg/mod GOCACHE=E:/gopath/gocache GOPROXY=https://goproxy.cn,direct

go test ./internal/gateway -run 'TestProbe2622' -v -count=1
  → 4/4 PASS（probe-run-1.txt 全文）

go test ./internal/gateway -run 'TestChatToolInAnotherShapeIsShaped|TestShapeChatToolsLeavesChatShape|TestProbe2622' -count=1 -race
  → ok  github.com/yetone/magpie/internal/gateway  5.131s（matrix-race.txt；维护者自修守护测试同跑全绿）

gofmt -l internal/gateway/zz_hunt68_2622_probe_test.go   → 无输出（exit 0）
go vet ./internal/gateway                                → 无输出（exit 0）
```

探针文件为临时件：副本存 probe-test.go.txt，工作树内已删（git status 干净）。未跑：整包 go test ./internal/gateway 全量、整仓测试（任务书禁止）、真实 SenseNova 上游（无 key，禁动真实账号）。

## 不确定项

- c6 上游行为（4/4 拒绝、3/4 偶发）完全依赖报告者实验，本机不可复验。
- `kimiToolRefTypes` 式补 type 是否能满足 SenseNova 的校验器（vs 必须内联）——无 key 不可测，已转为对维护者的问句而非断言。
- Messages/Responses 上游是否接受 `$ref`→oneOf schema：未测（无对应上游凭据）。
- 5 次原始失败的双缺陷归因比例：不可回溯，评论稿已如实写。

## 边界遵守

该单是维护者自修区（72d6103e 同窗取代我方实现，c4 已撤单）：本轮只交证据与分析稿，不发帖、不带 patch、措辞谦逊；评论稿落 `docs/issues/hunt68/2622-comment.body.md`，发布与否待授权。
