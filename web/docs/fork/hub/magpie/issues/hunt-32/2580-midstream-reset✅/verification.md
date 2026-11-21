# #2580 验证日志（macOS darwin arm64，go1.26.8 缓存工具链，沙盒 HOME）

分支 `hunt/2580-midstream-reset`（基于 upstream/main a751f528，rebase 自 9b04c4e2），commit `2acffddf`。

工具链说明：任务书指定 GOTOOLCHAIN=local，本机系统 go 为 1.25.5 而 go.mod 要求 1.26.8；未放开 auto 下载，改用 GOMODCACHE 中已有缓存工具链 `golang.org/toolchain@v0.0.1-go1.26.8.darwin-arm64/bin` 显式置 PATH + GOTOOLCHAIN=local（零下载）。

## 红证据（修前，upstream/main 基线 + 新测试）

```
--- FAIL: TestChatStreamCutMidLineLeavesNoHalfEvent (0.57s)
    passthrough_severed_test.go:190: a half event the upstream never ended went to the client as data: glm-5.3","choices":[{"index":0,"delta":{"reasoning_content":"thinking"}}]}

    data: {"id":"c1","model":"glm-5.3","choices":[{"index":0,"delta":{"reasoning_content":"the VM program itself hit an undefined

    data: {"error":{"message":"UP: connection lost mid-reply (unexpected EOF)","type":"api_error"}}

FAIL	FAIL	github.com/yetone/magpie/internal/gateway	1.019s
```

半截 data 行原样转发 + 错误事件跟在后面，与 issue 中 pi 收到的形状一致（pi 的解析器在半行上死，错误事件永远读不到）。

## 绿证据（修后）

```
=== RUN   TestChatStreamCutMidLineLeavesNoHalfEvent
--- PASS: TestChatStreamCutMidLineLeavesNoHalfEvent (0.44s)
PASS
ok  	github.com/yetone/magpie/internal/gateway	1.011s
```

## 消融回红（摘行缓冲：write 退回直写，dropHalf/unheld 变 no-op）

```
        data: {"id":"c1","model":"glm-5.3","choices":[{"index":0,"delta":{"reasoning_content":"the VM program itself hit an undefined
        data: {"error":{"message":"UP: connection lost mid-reply (unexpected EOF)","type":"api_error"}}

FAIL	FAIL	github.com/yetone/magpie/internal/gateway	1.035s
```

（恢复行缓冲后复绿。）

## 定向邻居（修后，含 rebase 到 a751f528 后复跑）

```
go test -tags nogui -count=1 -run 'TestChatStreamCutMidLineLeavesNoHalfEvent|TestPassthroughStream|TestLoopCutMidLine|TestGeminiCompat|TestRequestBodyProgress|TestStreamCut|TestTranslateBufferedSevered' ./internal/gateway/
ok  	github.com/yetone/magpie/internal/gateway	6.250s
```

覆盖：TestPassthroughStreamSeveredUpstream / EndsShort / CutMidLine / EndsOnLineEnd / Whole / ResponsesEndsShort / ResponsesBigLastEvent、TestLoopCutMidLine、TestGeminiCompatRelayEndedShort / TranslatedEndedShort / FinishAfterPartialLine、TestTranslateBufferedSeveredUpstream、TestRequestBodyProgressRenewsIdleDeadline（上游 a751f528 的新测试）。

## gateway 包全量

```
go test -tags nogui -p 2 -count=1 -timeout 45m ./internal/gateway/
ok  	github.com/yetone/magpie/internal/gateway	293.477s   （0 FAIL）
```

（跑于 9b04c4e2 基线的修复版；rebase 后定向回归复验，全量未重跑——rebase 带入的 7 个上游提交中 gateway.go 仅 compaction 429 文案与测试 idle 窗口两处、均不在 passthrough 区域，定向组含上游新测试已绿。）

## 检查

- `gofmt -l internal/gateway/ docs/`：无输出
- `go vet -tags nogui ./internal/gateway/`：过；GOOS=linux、GOOS=windows 同过
- `go build -tags nogui .`：过（internal/gui/trayimage_darwin.go 的 cgo -Wenum-conversion 警告为本机已知预存）
