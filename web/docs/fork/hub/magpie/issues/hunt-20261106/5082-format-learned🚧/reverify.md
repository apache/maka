# #5082 rework 验证记录（2026-11-06）

车道 A。rework 形态（原 patch formatToldInBody 被维护者拒，改为从回复学习）。

- 分支：`fix/5082-format-learned` @ `bd9edf36799299e80067dc94d9a6390c247c7b66`（基点 upstream/main `4ef47b3f4`）
- 远端：`git ls-remote origin refs/heads/fix/5082-format-learned` = `bd9edf36799299e80067dc94d9a6390c247c7b66`（一致）
- patch：`0001-gateway-a-schema-a-relay-drops-without-a-word-is-lea.patch`（`git format-patch -1 --zero-commit`）
- sha256：`676e7aa7f0303a36cd2de34d75f931c3de3d0661b5aacd95393132d0c3186c85`
- take：https://github.com/yetone/magpie/issues/5082#issuecomment-6684946833
- PATCH 帖：https://github.com/yetone/magpie/issues/5082#issuecomment-6685499021
- 回读：GET `/issues/comments/6685499021` → user=ggbdpq，围栏成对（2 处 ``` 行），patch 与本地产物逐字节一致（diff 空）

## 改动面（4 文件，+294/-3）

- `internal/gateway/format.go`：`formatIgnored(model)` 标记（"format_ignored:"+model）；`instruction` 注释涵盖新场景
- `internal/gateway/sniff.go`：usageSniffer 增 `askedJSON`/`text`；`gatherText`（SSE 事件逐个）/`gatherWhole`（整 body，settleWhole 后手动调）/`ignoredFormat`（failed、流未到末事件、空文本均不算非 verdict）；flushEvent 里 parse 后 gather
- `internal/gateway/gateway.go` passthrough：转发门第三分支（refused → schemaRefused → ignored → formatInBody(proto, body, false)）；门后 `schemaAsked := bodyFormat != nil && Type == "json_schema"`（未被改写才真，自动排除已有标记的场景）；sniffer 创建处 `sniff.askedJSON = schemaAsked`；尾部 drain/settleWhole+gatherWhole 后 `if schemaAsked && (rerr == nil || rerr == io.EOF) && sniff.ignoredFormat() { s.markUnfit(p.ID, formatIgnored(model), proto) }`
- `internal/gateway/format_test.go`：`ignoredVendor`（可 honors 变体，流式/整体皆答）+ `TestIgnoredFormatLearnedFromReply`（4 子用例）+ `TestHonoredFormatNeverLearned`（3 守护子用例）

## 验证矩阵（GOCACHE=/tmp/mg-5082-gocache）

| 项 | 结果 |
| --- | --- |
| RED（实现前） | `TestIgnoredFormatLearnedFromReply` 4 子用例 turn 2 全红（field kept），`TestHonoredFormatNeverLearned` 绿 |
| 实现后（同两测试 -count=1 -v） | 全绿（7 子用例） |
| 消融回红（摘转发门 formatIgnored 消费分支） | 4 学习用例 turn 2 全红；恢复后绿 |
| `go test ./internal/gateway/ -tags nogui -timeout 25m -count=1` | ok（770.476s，零失败；本机预存红 TestMothX/TestLaneLimitRoutes/TestProxyCheckSaysAProxyPassedBy 未触发） |
| `go test -tags nogui -race` 定向（新测试+format 家族+TestSniff*+TestPassthrough*） | ok（3.875s） |
| `gofmt -l` 触及 4 文件 | 空 |
| `go vet -tags nogui` darwin | 干净 |
| `GOOS=linux go vet -tags nogui` | 干净 |
| `go build ./...` darwin | ok（ld warning 为本机噪音） |
| `GOOS=linux go build ./...` | 失败仅在 wails 第三方包（`undefined: pointer`，错误全在 mod cache，不涉触及文件）——任务书声明预存红 |

## 兄弟面（rg formatRefused|schemaRefused|formatIgnored 全查，10 处）

| 位置 | 改/不改 | 理由 |
| --- | --- | --- |
| gateway.go:6217/6219（passthrough 转发门 refused/schemaRefused 消费） | 紧邻新增 ignored 分支 | 优先级 refused > schemaRefused > ignored：400 学到的更明确，不被应答学习覆盖 |
| gateway.go:6326-6328（passthrough #2126 400 学习点） | 不改 | 400 学习语义原样；同一请求 400 走重试链、200 走检测点，两条学习互斥 |
| gateway.go:7083（200 学习点） | 新增 | 本次改动 |
| gateway.go:7429/7431（translated 门 inSystem/asObject） | 不改 | #5082 是 relayed 场景；translated 的"200 非 JSON"不能归因字段被丢（inSystem 已可能给 schema 另一路），学习需单独设计；列 Not verified |
| gateway.go:7745/7753（translated 400 学习点） | 不改 | 400 学习语义原样 |
| format.go:121（instruction 注释） | 已改 | 涵盖 formatIgnored |
| format.go:143-172（标记定义） | 新增 | formatIgnored |
| claude_cli_schema_test.go schemaRefusedOnce | 不改 | #2126 测试，行为不变（全包绿覆盖） |
| mantle.go:70（unfit 删除） | 不改 | 只删 mantle 路由 key |
| token_field.go:65 | 不改 | 其它标记 |

## Not verified

- 无 live new-api/deepseek relay：学习用 in-process vendor 复现（200 纯文本），无 live Claude Code run 验证 title 真出现
- translated 路径（buildChat/buildResponses 字段）的静默丢弃者未覆盖，需单独设计
