# #5535 兄弟面 rg 全查（2026-11-07，车道 M3）

搜索面：`rg "cut short"` 全仓（产品+测试）、`failed(`、`endedBefore|abortFor`、`KError` 全部转发点、`cutWords|cutShort` 匹配点。

## 改

| 面 | 位置 | 判定 |
| --- | --- | --- |
| `failed` 闭包 | internal/gateway/claude_subscription.go:3819（emit 行 3831） | 共享根因，一处后缀覆盖三个调用点（4020 ended-the-turn-without-asking-again / 4209 after-the-reply-had-begun / 4229 and-Claude-Code-stopped），全改 |

## 查过不改

| 面 | 位置 | 不改理由 |
| --- | --- | --- |
| `r.replyUnended()` 分支 | claude_subscription.go:4249 一带（`"Claude Code " + r.endedBefore("ended its reply").Error()`，502） | 同为流中段失败措辞，但文本由 `endedBefore` 拼（exit 状态+stderr 尾），其 Error() 还被 turn 级错误与日志共用（1766/1787/5783/5842）；issue 只点名 cut short 措辞，动 endedBefore 波及日志语义，超出本单验收 |
| `abortFor("its reply failed or was cut short")` | claude_subscription.go:2245 | 仅存 endWhy 供日志（whyNoRun），不达客户端 |
| `cutWords` 正则 | internal/gateway/routing.go:447 | 匹配的是插件族措辞「tool call, written as text, was cut short」（Trae/Qoder，plugins#38/#579），另一族；本次后缀不触碰它，该正则也不匹配本次改动后的新文本（已核） |
| KError 各协议转发点 | anthropic.go:1728 / chat.go:1649 / gemini.go:753 / responses.go:2401 / ir.go:747 等 | 全部原样转发 `ev.Text`，一处根因修全部 client 形状（报告者 pi 走 /v1/chat/completions → chat.go 路径已覆盖），无需各自改 |
| `streamError` 的 `(request_too_large)` 先例 | internal/gateway/gateway.go:9977 一带（#2372：流中 Pi 只读事件文本） | 同型先例，本修法沿用其手法（追加括注短语），非兄弟面而是判例支持 |
| dav.go/notbackup.go 等其它 "cut short" 文案 | internal/davsync/*.go、internal/cli/*.go | WebDAV/备份/CLI 帮助文案，不达 gateway 客户端 |
| 旧措辞精确断言 | `rg "ended the turn without asking again\|and Claude Code stopped\|after the reply had begun"` 测试面 | 仅 claude_cut_run_test.go 断言 endedBefore 系措辞（不动）；cut stream 两处旧测试只 Contains "cut short"，后缀兼容，全绿实证 |

## 失败读取语义

读不到变成什么：无读取方——本次改的是错误事件的文本字面量，无解析方按旧文本分叉（唯一按文本匹配的 `cutWords` 是插件族，不重叠）。
