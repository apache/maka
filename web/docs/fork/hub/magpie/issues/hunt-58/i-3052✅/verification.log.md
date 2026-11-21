# hunt58 Lane I — issue #3052 验证日志

- 分支：`hunt58-i-3052-bili-headers`（基线 f5b0157420a4491f6e707b49a8af8e87ea8050a1）
- head：`1fd206c7d04a41e9395e08dfaf8a5a45a79e3d86`
- 身份核验：`git log -1 --format="%an <%ae> | %cn <%ce>"` → `ggbdpq <ggbdpq@gmail.com> | ggbdpq <ggbdpq@gmail.com>`
- patch：`0001-gateway-a-billion-context-proxy-in-front-of-the-prov.patch`，SHA-256 前 16 位 `877c8ee32fc86b29`
- 提交文件清单：`git show --stat HEAD` → 仅 `internal/gateway/gateway.go`（+16）与 `internal/gateway/bili_headers_test.go`（+63）

## 前提核验（全部通过）

1. `gh issue view 3052` 全文核对：头名 `x-bili-plugin` / `x-bili-plugin-conversation` / `x-bili-plugin-context-window`、路径 `internal/gateway/gateway.go` 的 `forwardOnce`、对照现象（直连 bili 出 `sess=test-123`，经 magpie 变匿名 `pfa-*` 并多注入 ~18 KiB 工具）与代码事实一致；0 评论。
2. 白名单定位：`forwardOnce` 用 `http.NewRequestWithContext` 从零建上游请求，只显式拷贝白名单头（Content-Type、Accept、User-Agent、Anthropic 的 anthropic-version/anthropic-beta、`claudeCodeHeader` 门内的 Claude Code 家族、`codexClientHeader` 门内的 Codex 家族、OpenCode/Cline/Kilo 的合成客户端头、codex 账号门内的 `codexHeader` 家族）。`rg -i "x-bili"` 全库零命中（旧树与基线 f5b01574 均核）。
3. 白名单既有条目语义：精确名（`user-agent`、`x-app`、`originator`、`session-id`、`thread-id`）+ 小写前缀家族（`anthropic-`、`x-stainless-`、`x-claude-code-`、`x-openai-`、`x-codex-`），均先 `strings.ToLower`。
4. 「声明过的设计」判定：**不是豁免，是缺口**。
   - `rg -i "strip|dropped|not forward|unknown header|arbitrary header"` 在 internal/gateway、internal/provider 测试中零命中——没有任何测试守护「未知头必须被剥」。
   - `git log --grep header` 显示白名单是逐家族增量扩张史：#179（Claude Code 头，为只认官方 CLI 的中继）→ Codex 头（同类动机）→ #2817（f599af7e，把 #179 的门放宽到带 key 的 plugin provider，作者 ggbdpq）。forwardOnce 注释自述动机是「a relay that serves only Claude Code knows it by its own headers」——按需准入，无通用剥除声明。
5. 单咽喉点：relay 路径 `forward`（gateway.go:3864）与 `passthrough`（4188，尾部 `s.forward(...)`）都经 `forwardOnce`，修一处全覆盖。

## TDD

- 测试：`internal/gateway/bili_headers_test.go`，`TestForwardOnceCarriesBiliHeaders`（`grep -n '^func Test'` 实名核对）。
- RED（基线代码 + 新测试）：
  ```
  --- FAIL: TestForwardOnceCarriesBiliHeaders (0.00s)
      bili_headers_test.go:54: X-Bili-Plugin = "", want "pi": the bili proxy reads it to know the cooperative session
      bili_headers_test.go:54: X-Bili-Plugin-Conversation = "", want "test-123": ...
      bili_headers_test.go:54: X-Bili-Plugin-Context-Window = "", want "200000": ...
  FAIL
  ```
  （同跑中 `X-Custom-Whatever` 与 `Authorization` 两条范围守卫断言本来就过，红的是三个 bili 头。）
- GREEN（修复后）：`ok github.com/yetone/magpie/internal/gateway 1.058s`。
- 消融（产品文件 `git stash push -- internal/gateway/gateway.go` 回基线、测试保留）：三断言再次全红，`FAIL github.com/yetone/magpie/internal/gateway 1.052s`；`git stash pop` 恢复后复绿。
- 触网：无。httptest 本地回环，无真实账号、无 bili 服务。

## 矩阵（worktree /tmp/magpie-r58-i）

| 检查 | 命令 | 退出码 | 备注 |
| --- | --- | --- | --- |
| 定向（未缓存复跑） | `go test -tags nogui -count=1 -run TestForwardOnceCarriesBiliHeaders ./internal/gateway/` | 0 | ok 1.113s |
| 改动包全量 | `go test -tags nogui -count=1 ./internal/gateway/` | 0 | ok 337.007s |
| gofmt | `gofmt -l` 两个改动文件 | 0 | 无输出 |
| vet 本机 | `go vet ./...` | 0 | 预存 cgo 警告：internal/gui/trayimage_darwin.go:112 枚举转换，与本改动无关 |
| vet linux | `GOOS=linux go vet -tags nogui ./...` | 0 | |
| vet windows | `GOOS=windows go vet -tags nogui ./...` | 0 | |
| build 本机 | `go build ./...` | 0 | 预存 macOS SDK 链接版本警告，与本改动无关 |
| build linux | `GOOS=linux go build -tags nogui ./...` | 0 | |
| build windows | `GOOS=windows go build ./...` | 0 | |

## Watched 三查

1. 人为打破（消融）→ 测试回红：见上。
2. 兄弟面清单：
   - 白名单其他消费点：无。`forwardOnce` 是唯一出口（`forward` 与 `passthrough` 都经它）；`sessionHeaders` 是反方向（读头做会话分组、明确不发给 vendor，#2236 先例）；`passOnCaller`/`markSearching` 是 magpie→magpie 方向；`OpenCodeClient`/`ClineClient`/`KiloClient` 是按 vendor 合成客户端头，不消费客户端头。
   - 其他前缀家族为何不加：issue 只报告 bili（billion-context）一家；无报告需求的家族不加是「改动只做目标所需」的规则；通用透传（每供应商设置）是设计拍板，正文留给维护者。
3. 失败读取变成什么：测试中 httptest handler 捕获的头用 mutex 守护（遵循 code-standards「fake server 的 handler 跑在别的 goroutine 上」），断言读的是 handler 实收头，不是构造侧的内存值；Authorization 断言把「供应商自己的 key 上去、客户端 key 不透传」钉死。

## 未验证 / 如实标注

- 未对真实 billion-context 代理做端到端复现（issue 里的 bili 侧日志取自报告者，本单不触网）。
- 未在 Linux/Windows 实机跑（仅交叉 vet/build；仓库规则允许该矩阵口径）。
