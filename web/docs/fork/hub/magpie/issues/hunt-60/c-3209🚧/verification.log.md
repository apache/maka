# hunt60 Lane C — #3209 验证日志

分支 `hunt60-c-3209-gateway-selfport`，基线 `b0d46ca7`，head `ced737100a5b5aa6a9fe53c37549fa7ef0f217e7`。
worktree：`/tmp/magpie-r60-c`（独占）。日期：2026-10-22。

## 定位链复核（基线 b0d46ca7）

- `internal/gui/web.go:82` — `StartWeb` 里 `net.Listen("tcp", addr)`：页面 listener 先占口。
- `internal/gui/backend.go:126`（`serveGatewayLocked`，由 `backend.go:44` `startBackend→serveGateway` 进入）：
  `gateway.ServedBy()` GET 网关地址 `/`，页面回 401 登录页 HTML，无 `"magpie"` → `Running=false`；
  随后 `gateway.Taken()`（`internal/gateway/gateway.go:318`，对 `gateway.URL()` 的裸 TCP dial）拨通
  **本进程自己的页面 listener** → true → 跳过挂载，打日志
  `gateway: <url> is taken but doesn't answer as magpie yet; …`。
- `backend.go:83` `watchGateway` 每 15s 重问同一探测，自家 listener 永不释放 → 进程存活期内永远不挂载。
- `internal/gui/port.go:123` 一带只有换端口路径的重挂载，不是本症状的补救。
- issue 中"默认地址恰好是坏 case"范围核实：页面默认地址自 #102（59e4f417）起一直是
  `127.0.0.1:3430`（`internal/cli/web_cli.go` `webAddr`，"beside the gateway"），**不是** 3425。
  坏 case 触发面：`--addr` 指到网关端口、`magpie serve --web=<网关地址>`、或
  `MAGPIE_ADDR=127.0.0.1:3430`（网关压到页面默认口上，无 flag 即触发）。报告者"or omit --addr"一说
  与当前 main 不符。

## 修法取舍

- 报告建议 (i) "本进程 listener 跳过 Taken()"：单独不成立——跳过后 `gw.ListenAndServe` 绑不上
  （页面占着口），变成每 15s 一条 bind 报错，网关仍然永远不服务。
- (iii) 补日志：不治 deadlock。(iii') 重试：watch 本来就在重试，错在等一个永不发生的释放。
- 采用：**在绑定前不让页面占网关的口**（webListen/pageBeside/bothTake，页面让位 3430 或临时口）。
  探测路径从此只见真正的外部占用者；`gateway.Taken()` 语义零改动（全仓唯一调用方
  `backend.go:132`，无测试直接钉死其语义；`TestGatewayTakenOver`、`TestGatewayNotServedBesideASlowOne`
  钉的是外部占用路径，保持绿）。

## RED（基线代码 + 新测试）

```
=== RUN   TestWebOnTheGatewaysOwnAddress
2026/10/22 06:09:06 gateway: http://127.0.0.1:59177 is taken but doesn't answer as magpie yet; this magpie serves the gateway once it is free
    takeover_test.go:146: the page took the gateway's own address 127.0.0.1:59177
--- FAIL: TestWebOnTheGatewaysOwnAddress (0.71s)
```

测试逐字复现 issue 的误导日志（占口者=自家页面 listener）。

## GREEN（修复后）

```
=== RUN   TestWebOnTheGatewaysOwnAddress
2026/10/22 06:11:49 magpie web: 127.0.0.1:64110 is the gateway's own address, so the page is on 127.0.0.1:3430
--- PASS: TestWebOnTheGatewaysOwnAddress (0.09s)
ok  github.com/yetone/magpie/internal/gui
```

## 消融（产品回基线、测试保留 → 红；恢复 → 绿）

- `git diff > /tmp/c3209-fix.patch` → `git checkout -- internal/gui/web.go internal/cli/web_cli.go`：

```
2026/10/22 06:12:55 gateway: http://127.0.0.1:65119 is taken but doesn't answer as magpie yet; this magpie serves the gateway once it is free
--- FAIL: TestWebOnTheGatewaysOwnAddress (0.71s)
FAIL
```

- 恢复补丁后重跑：`ok github.com/yetone/magpie/internal/gui 1.021s`。

## 矩阵（全部在本 worktree 实跑）

| 项 | 结果 |
| --- | --- |
| 定向：`-run 'TestWebOnTheGatewaysOwnAddress'` | PASS |
| `go test -tags nogui -run 'TestGateway|TestWeb' ./internal/gui` | 全 PASS（含 TestGatewayTakenOver、TestGatewayNotServedBesideASlowOne） |
| `go test -tags nogui ./internal/cli`（全量） | ok 28.259s，exit 0 |
| `go test -tags nogui ./internal/gui`（全量，165.772s） | 仅 `TestProxyCheckSaysAProxyPassedBy` 红——stash 回基线复红，预存 |
| `TestMothX`（internal/agent） | 基线复红，预存（不在改动包，备案） |
| `gofmt -l` 三个改动文件 | 干净，exit 0 |
| `go vet ./...` | exit 0（trayimage_darwin.go cgo enum warning 预存） |
| `GOOS=linux go vet -tags nogui ./...` | exit 0 |
| `GOOS=windows go vet -tags nogui ./...` | exit 0 |
| `go build -tags nogui` darwin / linux / windows | 均 exit 0 |
| `git am` 内嵌 patch 于基线 b0d46ca7 临时 worktree | 干净应用，am 后 SHA eacceed2，作者 ggbdpq |

## 兄弟面三查

1. `gateway.Taken()` 调用方全仓仅 `internal/gui/backend.go:132`（codex.go 命中为 `mirrorsTaken`，无关）；
   CLI `serve()` 直连路径不经它，行为不变。
2. 同病入口：`magpie serve --web=<gw addr>`、daemon `--web`、`MAGPIE_ADDR` 撞 3430 —— 全部经
   `StartWeb`，同一修复覆盖；桌面 app 无 TCP 页面 listener，不涉及；`gateway.Handover`（make dev）
   分支不经过该探测块，未触碰。
3. 失败读取：修复后探测到的"占用"只剩真外部占用者，原日志语义变准；页面被挪走时打
   `magpie web: <asked> is the gateway's own address, so the page is on <actual>`。

## 交付物

- 提交 `ced737100a5b5aa6a9fe53c37549fa7ef0f217e7`，author/committer 均 `ggbdpq <ggbdpq@gmail.com>`（已核验）。
- patch：`0001-web-a-page-told-onto-the-gateway-s-own-address-goes-.patch`，
  SHA-256 前 16 `3701f5bc5fa7f100`（全串 3701f5bc5fa7f100dbffe73d4807a3d38eab12855f003ccf04012a56b27e2bdc）。
- 待发布稿 `3209-comment.body.md`：Attribution 精确行 ×1、details/patch summary ×1、
  Branch 行 ×1、无 AI use 段、零中文、表格行间无空行、内嵌 patch 与 .patch 逐字节一致。
- 未 push、未发帖、未评论；#2932 相关代码零触碰。
