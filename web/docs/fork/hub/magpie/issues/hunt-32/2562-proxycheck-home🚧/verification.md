# #2562 验证证据

环境:macOS darwin arm64,Go 1.26.8,沙盒 HOME(mktemp -d /private/tmp/magpie-sbx-2562-*),GOTOOLCHAIN=auto,固定 GOMODCACHE/GOCACHE。宿主 `scutil --proxy` 开着系统代理(127.0.0.1:7897,HTTP/HTTPS/SOCKS+PAC)——正是 issue 报告的宿主条件。

## 红(修前,upstream/main 基线 9b04c4e2)

```
=== RUN   TestProxyCheckSaysAProxyPassedBy
    proxycheck_test.go:100: passed by: &{IP: Loc: Ms:818 Error:HTTP 502 Proxied:false}, the proxy asked 0 times
--- FAIL: TestProxyCheckSaysAProxyPassedBy (0.82s)
FAIL    github.com/yetone/magpie/internal/gui
```

与 issue 的失败差异:reporter 宿主代理挂到超时(`context deadline exceeded`),本机宿主代理(7897)对解析不了的 trace.example.invalid 返回 `HTTP 502`。断言行(proxycheck_test.go:100)、`Proxied:false`、`the proxy asked 0 times` 三要素一致,同根因。

## 绿(修后,commit 74f704c5)

```
=== RUN   TestProxyCheckTellsTheProxyFromDirect          --- PASS (0.00s)
=== RUN   TestProxyCheckSaysTheProxyTookItUnderOneExit   --- PASS (0.00s)
=== RUN   TestProxyCheckSaysAProxyPassedBy               --- PASS (0.23s)
=== RUN   TestProxyCheckConnectedToByName                --- PASS (0.00s)
=== RUN   TestProxyCheckGoesAroundTheGlobalProxyForDirect--- PASS (0.00s)
=== RUN   TestProxyCheckWithNoProxyAsksOnlyDirect        --- PASS (0.00s)
=== RUN   TestProxyCheckSaysAProxyDownWithoutItsPassword --- PASS (0.00s)
=== RUN   TestProxyCheckReadsNoAddressAsAFailure         --- PASS (0.00s)
ok  github.com/yetone/magpie/internal/gui  1.207s(rebase 到 a751f528 后复验)
```

## 消融

还原 internal/testenv/testenv.go 单文件改动(git checkout --)后同一测试复红:

```
proxycheck_test.go:100: passed by: &{IP: Loc: Ms:184 Error:HTTP 502 Proxied:false}, the proxy asked 0 times
FAIL    github.com/yetone/magpie/internal/gui   0.987s
```

恢复后 `git diff --stat` = 1 file, 9 insertions(+), 5 deletions(-)。

注:第一次消融尝试用了相对路径,agent 线程 cwd 重置导致 cp/git checkout 落在主仓 magpie(同仓库另一工作树)而 go test -C 跑的是 magpie-pr2,得出假阴性。已核验主仓 tracked 文件零改动(仅 3 个既有 untracked),改用绝对路径重做,上为有效结果。

## 包全量(-tags nogui -count=1,沙盒 HOME)

```
ok  github.com/yetone/magpie/internal/testenv   4.486s
ok  github.com/yetone/magpie/internal/netproxy  1.627s
ok  github.com/yetone/magpie/internal/gui      47.753s
```

gui 包 TestMain 走 testenv.Run(Isolate),全量绿即证明 Isolate 对 tools 清单的 LookPath 断言(含新加的 scutil 解析到 stand-in)通过。

## gofmt / vet / build

- `gofmt -l internal/testenv/` 无输出。
- vet:darwin / windows / linux 三平台 `CGO_ENABLED=0 go vet -tags nogui ./internal/testenv/ ./internal/netproxy/ ./internal/gui/`,均退出 0。
- build:三平台 `CGO_ENABLED=0 go build -tags nogui .`,均退出 0。

## 没跑

- 全仓 `go test ./...`(66 包):改动是测试基建,以 testenv/netproxy/gui 三包全量覆盖受影响面。
- `-race`。
- Windows 宿主真实系统代理(注册表 Internet Settings)下的同类红:本单报告面是 macOS;Windows 源未被 stand-in 覆盖,如实标注为未处理、未测。
- 未连真实 Langfuse/无关。
