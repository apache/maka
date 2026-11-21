# hunt58 Lane G — issue #3161 验证日志

车道：hunt58-g-3161-search-protection
worktree：/tmp/magpie-r58-g（基线 f5b0157420a4491f6e707b49a8af8e87ea8050a1 = upstream/main）
提交：128ec70495a5977cd3ac56c8d46301a239d0dd15（作者 ggbdpq <ggbdpq@gmail.com>，已核验）
patch：0001-gateway-a-searched-conversation-relayed-to-a-custom-.patch（SHA-256 前 16：8e5548ceedec964c）

## 前提核验（全部成立，未弃单）

- issue 全文（gh issue view 3161）：自定义 Responses 上游要求 input 含 `web_search_call` 时请求声明 `web_search` 工具，否则 HTTP 200 + SSE `response.failed`（`response protection is unavailable`）；失败请求为普通 `POST /v1/responses`（摘要指令、`tools: []`、`tool_choice: "auto"`），非 `/responses/compact`、无 `compaction_trigger`；直连同挂，报告者已框定为上游兼容限制。0 评论。
- 当前 main 路径复核（f5b01574）：
  - `internal/gateway/codex_backend.go:868`（codexUpstreamOn）：POST /responses 且 base==CodexBase 时调 `provider.DeclareSearch` ✓
  - `internal/provider/codex_request.go:307`（codexBody）：调 `declareSearch(m, false)` ✓；`internal/provider/account.go:989` `acct.body = codexBody` 是唯一账号 body 绑定
  - `internal/gateway/gateway.go:4179`（Server.passthrough）Responses 分支（4195 起）：无 DeclareSearch ✗ —— 缺口
  - `internal/gateway/search_history_test.go`：仅覆盖账号/登录路径（codexSignedIn、CodexBase 重挂），无自定义 API-key 路径
  - 报告者核对的 ba319a758 是当前基线祖先，结构一致

## 合成复现与 TDD

新测试（internal/gateway/search_history_test.go，helper `protectingUpstream` 按 issue 字面字节拒绝）：

- `TestSearchedConversationCompactsOnACustomProvider` — issue 本案（压缩摘要请求）
- `TestSearchedConversationFunctionToolsOnACustomProvider` — 兄弟情形（函数工具 + 搜索历史）
- `TestUnsearchedConversationUnchangedOnACustomProvider` — 爆炸半径守卫（未搜索不加工具）

RED 原文（基线产品码 + 新测试；`go test -tags nogui -count=1 -run 'TestSearchedConversationCompactsOnACustomProvider|TestUnsearchedConversationUnchangedOnACustomProvider|TestSearchedConversationFunctionToolsOnACustomProvider' -v ./internal/gateway/`）：

```
--- FAIL: TestSearchedConversationCompactsOnACustomProvider (0.09s)
    search_history_test.go:211: status 200: event: response.failed
        data: {"type":"response.failed","response":{"error":{"code":"upstream_error","message":"response protection is unavailable","type":"internal_error"}}}
--- FAIL: TestSearchedConversationFunctionToolsOnACustomProvider (0.01s)
    search_history_test.go:372: status 200: event: response.failed
        data: {"type":"response.failed","response":{"error":{"code":"upstream_error","message":"response protection is unavailable","type":"internal_error"}}}
```

（TestUnsearchedConversationUnchangedOnACustomProvider 在基线 PASS，属设计。）

GREEN（修复后同命令）：三测试全 PASS。

## 两案对照

- 案 A（选定）：passthrough 缝调 `provider.DeclareSearch(body, false)`，守卫 `p.Account == nil`。改动 1 调用点 + 注释；复用 #1270 既有 helper（cached-only、tool_choice none）；历史零损失。
- 案 B（弃）：剥离压缩输入的 `web_search_call`。magpie 无法从任意透传请求中识别 Codex 本地压缩（无 compaction_trigger、无可靠标记），剥离只能全局做 → 每轮丢搜索记录与引用配对，语义损失无界；且严格上游在搜索被组内其他成员承接后历史会再现该项，剥离是永久税。案 B 影响已写进 PR 正文与提交正文。

守卫来由（实测）：第一版无守卫把 `TestSearchedConversationCompactsOnAnAccount`、`TestSearchedConversationCompactionTrigger` 打红（`sent tools [web_search], tool_choice auto: want ... none`）——账号路径的 `Prepare`=codexBody 在透传整形之后跑，其无条件 `m["tool_choice"]="auto"` 会重置先声明的 none；账号本就由 codexBody 声明，故守卫 `p.Account == nil` 恢复原序。

## 消融（最终版修复）

- `git diff internal/gateway/gateway.go > /tmp/g3161-fix2.patch && git checkout -- internal/gateway/gateway.go` → 跑三测试：Compacts FAIL、FunctionTools FAIL（原文见上，均为 issue 字面失败）、CompactsOnAnAccount PASS（基线本绿）
- `git apply /tmp/g3161-fix2.patch` → 三测试 PASS

## Watched 三查

1. 人为打破：消融即证（回基线两测试红，逐行核过原输出）。
2. 兄弟面（rg `web_search_call`、`DeclareSearch`、`s.forward`）：
   - codexUpstreamOn（#1270）✓ 已有；codexBody（账号/翻译）✓ 已有；passthrough（本单）✓ 补上
   - CodexAsSent as-sent 分支：模式契约"原样转发"（#1758），不改，已在 PR 正文说明
   - remote_magpie 转发：远端 magpie 应用自己的同名路径，合并后自愈，不改
   - sessions/calls.go:428（会话查看器）、gateway/fallback.go、gateway/responses.go（magpie 自营搜索的发件侧）、search.go（代搜内部）：非声明点，不改
   - 非 Codex 客户端：无 web_search_call 项，helper 快速路径不触发
3. 失败读取：修复前用户见 200 流内 response.failed（上游回 SSE 时）或 magpie 502 internal_error（上游 Content-Type 异常时，实测复现）；修复后同一请求得到 completed 摘要；真上游仍失败时其 response.failed 原样透传。

## 矩阵（head 128ec704，macOS 15 arm64）

| 命令 | 退出码 |
| --- | --- |
| gofmt -l internal/gateway/gateway.go internal/gateway/search_history_test.go | 0（无输出） |
| go vet ./... | 0（trayimage_darwin.go cgo 警告为预存） |
| GOOS=linux go vet -tags nogui ./... | 0 |
| GOOS=windows go vet -tags nogui ./... | 0 |
| GOOS=windows go vet ./... | 0 |
| go build（darwin） | 0 |
| GOOS=linux go build -tags nogui | 0 |
| GOOS=windows go build | 0 |
| go test -tags nogui -count=1 ./internal/gateway/ | 0 |
| go test -tags nogui -count=1 ./... | 1 —— 66 包 ok；TestMothX（internal/agent）、TestProxyCheckSaysAProxyPassedBy（internal/gui）红 |

全仓红定性：两测试在**干净基线**（改动 checkout 掉）同样红（各自单跑 FAIL，退出码非 0）——预存失败，与本单无关，车道限定不改无关文件，如实上报。

## 交付物

- 分支 hunt58-g-3161-search-protection，head 128ec70495a5977cd3ac56c8d46301a239d0dd15
- 0001-gateway-a-searched-conversation-relayed-to-a-custom-.patch
- 3161-comment.body.md（三件套自检：Attribution=1、details+SHA=1、Branch+head=1，逐字节精确匹配；零中文；内嵌 patch 与 .patch 文件 diff 一致）
