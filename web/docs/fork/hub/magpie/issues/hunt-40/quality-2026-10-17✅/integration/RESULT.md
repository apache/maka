# 四份补丁同副本的全仓测试

副本：`/private/tmp/magpie-quality-20261017-integrated`。其中能看到四份改动的标记：Gemini 导入、`didNotStream`、失败出口的 `Call.Route`、流内 413 的 `request_too_large`。进程启动时的工作目录没有写进日志。

观察到的命令（2026-10-17 07:43，超时 15 分钟）：

```sh
export GOPATH=/Users/ggbdpq/go GOMODCACHE=/Users/ggbdpq/go/pkg/mod GOCACHE=/Users/ggbdpq/Library/Caches/go-build GOTOOLCHAIN=auto
go test -tags nogui -p 2 -count=1 -timeout 15m ./...
```

退出码：`1`（`full-suite.exit`）。完整输出：`full-suite.log`。

`internal/gateway` 317.608s 通过，`internal/provider` 85.156s 通过。唯一失败包是 `internal/gui`：`TestProxyCheckSaysAProxyPassedBy` 报 `Error:HTTP 502`、`Proxied:false`、`the proxy asked 0 times`。失败形状与 [2562 的既有记录](../../2562-proxycheck-home/verification.md) 相同；这四份补丁都不改 `proxycheck`。本轮没有在干净基线上重跑这条测试，所以不能把「既有记录」写成「本轮已证明与四份补丁无关」。

这次不是全仓通过。没有跑 `go vet`、三平台构建，也没有跑 Chromium/WebKit。
