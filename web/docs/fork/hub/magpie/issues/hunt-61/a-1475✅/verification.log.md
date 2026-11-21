# hunt61 Lane A — #1475 验证日志

仓库：/tmp/magpie-r61-a（worktree），分支 hunt61-a-1475-unnamed-call，基线 7dd965ed22e6619c9084f3bca58e444073e8a41c
提交：fd71715096476181d00fa26f03f5da3c9696e25c（author/committer 均为 ggbdpq <ggbdpq@gmail.com>，已核验）
patch：docs/issues/hunt61/a-1475/0001-gateway-a-Chat-tool-call-naming-no-function-is-dropp.patch
patch SHA-256 前 16：6a28debfeb4c7f77

## 前提核验

- gh 读 #1475 全帖（0 评论）：Qoder 长轮次，客户端 AI_InvalidResponseDataError "Expected 'function.name' to be a string"，magpie 记 status=200 done=true，0.1.1137。报告者已排除配额/截断/请求/上下文/parsers，指认 chatWholeEvents 只补 index 不补 name，且自认无法钉死自己命中的路径（流式，4 次重放均 well-formed）。
- gh 读 #823 全帖：同症不同路径（Trae CN DeepSeek 把调用写成文本）。修复族：bbc89f9e（0.1.909 文本转调用）、878a8489、c353f7bd（0.1.919：无法解析的块丢弃/保留文本，不伪造调用）。#823 仍 open（后续又有 DSML 残留案例）。
- 同域提交逐读：9a0df964（relayed Chat reply made calls + ended stop → tool_calls，chatTidy/chatWhole）、b0d46ca7（group 与 model 走同一套 tidy，只加测试）、b3330ea8（#1341 synthetic result）、d0c587ae（#1845 whole 文本转调用）、bbc89f9e/878a8489/c353f7bd（#823 族）。
- 日志点定位：internal/gateway/gateway.go:2832 `Try{... Done: true, Status: call.Status ...}`（流结束无 HTTP 错即 done=true），落盘 internal/gateway/history.go:75 saveRoute（trace.go:658 go saveRoute(c)）。done 语义="流发完"，不看内容形状——与报告一致。
- handbook/10 家族规则确认："工具交换/消息形状修补"族，#1916 定版"无条件转换优于被拒后补救并记住"。

## 现状复核（rg 定位，行号已重核）

- whole_stream.go:101-110（chatWholeEvents）：delta 只补 index，name 原样透传 —— 报告者指认的洞，仍存在。
- chattidy.go（chatTidy）：withoutEmptyNames 只删后续片段空名重复（grok CLI），首片段 name 缺失/null/非字符串原样放行。
- chattidy.go（chatWhole）：补 id、补 finish、文本转调用，不修 name。
- 翻译路径（chatEncoder KToolStart chat.go:1420 / renderChat chat.go:1494）：name 来自 IR（Go string），最坏空串，类型不变量不破 → 不改（理由：空名失败为 unknown tool，丢工具不丢会话）。
- passthrough 组装：internal/gateway/gateway.go:4686-4700（chatTidy/textCallTidy/chatWhole 按 proto/sse/ctype 设置）；whole→stream 唯一入口 fallback.go:2396（holdWriter.release，octet-stream 类 ctype 下 chatWhole==nil，chatWholeEvents 是唯一防线）。

## 修法取舍（a vs b）

选 a 变体（修形状/丢弃），不选 b（归类流失败）：
- 家族先例 c353f7bd 对"无法成为合法 call 的东西"是丢弃/保留文本，不是报错；#823 的目标是会话不死。
- 坏 call 常伴随正常文本，整条回复判死太重；丢弃后 finish 回退 stop，回合干净结束。
- 报告者建议的 "degrade to text" 不照字面落：把 arguments 拼进 content 是发明模型没说的话（发布稿已写明取舍）。
- 口径：name 非字符串/缺失 → 丢弃；空串放行（string 类型过客户端校验，语义失败在下游）。b3330ea8 的"合成"先例仅用于补配对（result），无合成 name 先例，不发明占位名。

## RED（基线 7dd965ed 产品代码 + 新测试）

新增 internal/gateway/chat_call_name_test.go 五测试：

```
--- FAIL: TestNamelessCallStreamDropped (0.11s)
--- FAIL: TestNameAbsentStreamDropped (0.01s)
--- FAIL: TestNamelessCallBesideAGoodOne (0.01s)
--- FAIL: TestNamelessCallWholeDropped (0.01s)
--- FAIL: TestNamelessCallWholeAsStreamDropped (0.00s)
FAIL    github.com/yetone/magpie/internal/gateway
```

红证据指向透传：流式客户端帧含 "function":{"name":null,...}；chatWholeEvents 事件含 "name":null；whole 中继原样带 tool_calls 且 finish tool_calls。初次跑测试 helper relayedChat 在 nameless 帧上越界 panic（textcalls_test.go:67 names[-1]），给 helper 加 len(names)==0 continue 容错（测试基建，非产品）。

## GREEN（修复后）

- go test -tags nogui -run '^(TestNamelessCallStreamDropped|TestNameAbsentStreamDropped|TestNamelessCallBesideAGoodOne|TestNamelessCallWholeDropped|TestNamelessCallWholeAsStreamDropped)$' ./internal/gateway/ → ok
- 同域家族测试：go test -tags nogui -run 'TestChatCallsEndToolCalls|TestEmptyCallID|TestStreamedCallGivenAnID|TestTextWritten|TestDSML|TestQuietWholeReplyStreamed|TestPluginTextWritten' → ok 14.483s
- gateway 全量：go test -tags nogui -count=1 ./internal/gateway/ → ok 326.578s（修复树首次全量）

## 消融

精确测试名（grep -n '^func Test' chat_call_name_test.go）：TestNamelessCallStreamDropped / TestNameAbsentStreamDropped / TestNamelessCallBesideAGoodOne / TestNamelessCallWholeDropped / TestNamelessCallWholeAsStreamDropped

第一轮：`git checkout 7dd965ed -- whole_stream.go chattidy.go chat_call_ids.go`（修复未提交，工作树修复被覆盖——失误）→ 五测红（真实红，产品基线代码）；重放三文件修改 → 五测绿。教训入 LESSONS：消融前必须先提交。

正式轮（提交 fd717150 之后）：
- 产品回 7dd965ed、测试保留 → 五测全红（--- FAIL ×5, FAIL）。
- `git checkout HEAD -- <三文件>` 恢复 → -count=1 复跑 → ok（exit 0）。
- 工作树恢复干净（git status 无改动）。

## 矩阵（最终 HEAD 树）

| 项 | 结果 |
| --- | --- |
| go test -tags nogui -count=1 -run '^(五测试)$' ./internal/gateway/ | ok 1.003s, exit 0 |
| go test -tags nogui -count=1 ./internal/gateway/（全量重跑，后台任务 exec_97eddf5a） | ok 336.907s, exit 0 |
| gofmt -l internal/gateway/ | 空, exit 0 |
| go vet ./... | exit 0（internal/gui trayimage_darwin.go cgo 枚举转换警告为预存，本次未触碰 internal/gui） |
| GOOS=linux go vet -tags nogui ./... | exit 0 |
| GOOS=windows go vet -tags nogui ./... | exit 0 |
| go build . （darwin/arm64） | exit 0（ld duplicate libraries 警告预存） |
| GOOS=linux GOARCH=amd64 go build -tags nogui . | exit 0 |
| GOOS=windows GOARCH=amd64 go build -tags nogui . | exit 0 |

注：入口为根 main.go（无 cmd/）。任务书提到的已知预存红 TestMothX/TestProxyCheckSaysAProxyPassedBy 本次 gateway 全量未出现（可能在其它包或已修复），以全量 ok 为准。

## 兄弟面清单（改/不改）

改：
- chatTidy（流式中继，Chat）：nameless 丢弃 + bad index 跨 chunk 压后续片段 + finish 双向（stop→tool_calls 仅当有带名 call；tool_calls→stop 当无带名 call）。
- chatWhole（whole 中继，Chat）：wholeNameless + finish 回退（wholeNamedCall）。
- chatWholeEvents（whole→stream，Chat）：kept 过滤 + finish 回退（覆盖 octet-stream 类绕过 chatWhole 的路径）。
- docs/subsystems/gateway-routing.md：tidy 家族条目后加一行（照 9a0df964 先例）。

不改（理由）：
- 翻译路径 chatEncoder/renderChat：IR 层 name 恒 Go string，类型不变量不破；空名失败=unknown tool（丢工具不丢会话）。
- responsesWholeEvents / anthropicWholeEvents（Responses/Anthropic whole 事件层）：同族洞确实存在（function_call item / tool_use block 的 name 同样可能坏型），但无报告、报告协议为 Chat、Anthropic block index 重编有客户端合并语义风险 → 留待有报告单开；已在发布稿 Siblings 与 Not verified 写明。
- passthrough 字节保形本身：tidy 家族已在字节层修补（chatTidy/chatWhole 即 passthrough 的过滤器），纯 passthrough 无解析不动是设计（照 b0d46ca7 的架构事实）。
- textcalls 解析器：已有 names[v.Name] 校验（textcalls.go:322），无需改。
- withoutEmptyNames 既有行为（grok CLI 空名重复）：保留，新逻辑与它正交（空串是 string，aName 放行）。

## 不确定项

- 报告者确切命中的路径无法钉死（其本人 4 次重放均 well-formed）；本修复覆盖 Chat 全部三个 emit 面，无论哪个面命中都被挡住。
- AI SDK 对空串 name 的接受度未实测（口径按报错文本"to be a string"）；空名 call 的下游失败是 unknown tool 错误，会话不死。
- Responses/Anthropic whole 事件层同族洞未修（见上）。

## 交付物

- 提交：fd71715096476181d00fa26f03f5da3c9696e25c（分支 hunt61-a-1475-unnamed-call，基线 7dd965ed 之上 1 提交）
- patch：0001-gateway-a-Chat-tool-call-naming-no-function-is-dropp.patch（本目录，SHA-256 前 16：6a28debfeb4c7f77）
- 待发布稿：1475-comment.body.md（三件套自检：attribution=1 / patch-line=1 / branch-line=1；中文仅 patch 全文内仓库既有行，属逐字引用）
- 未 push、未发帖、未评论。
