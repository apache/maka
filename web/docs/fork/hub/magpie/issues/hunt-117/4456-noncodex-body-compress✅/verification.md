# #4456 验证证据（hunt-117，2026-11-02）

基线：upstream/main 5daba8337；分支 fix/4456-noncodex-body-compress；提交 b43be9e41955f66165ab61cd0b23ae4789e38cd7（author ggbdpq <ggbdpq@gmail.com>）。

## RED（实现前，Record 字段已加、行为未接）

```
$ go test ./internal/gateway/ -run TestLedgerKeepsUpBytes -count=1
--- FAIL: TestLedgerKeepsUpBytes (0.15s)
    upbytes_test.go:79: UpBytes 0, the tries' bodies [57 57]
FAIL
```

fake vendor 实收两次 body（sizes [57 57]），行为面全通，仅记录缺失。

## GREEN（b43be9e41）

```
$ go test ./internal/gateway/ -run TestLedgerKeepsUpBytes -count=1
ok  	github.com/yetone/magpie/internal/gateway	1.199s
```

## 消融回红（基线=分支父提交 5daba8337，只回退 internal/gateway/gateway.go，测试保留）

```
$ git checkout 5daba8337 -- internal/gateway/gateway.go
$ go test ./internal/gateway/ -run TestLedgerKeepsUpBytes -count=1
--- FAIL: TestLedgerKeepsUpBytes (0.15s)
    upbytes_test.go:79: UpBytes 0, the tries' bodies [57 57]
FAIL
$ git checkout HEAD -- internal/gateway/gateway.go
$ go test ./internal/gateway/ -run TestLedgerKeepsUpBytes -count=1
ok  	github.com/yetone/magpie/internal/gateway	1.223s
```

注：usage.go 的字段定义回退=编译错误，不属有效消融形态（门禁：编译错误不算）；codex_backend.go 的记录行无直接断言测试（其路径无该字段断言的既有测试），靠 gateway 主测试 + 现有 Codex 套件护航回归，如实记录。

## 定向 -race（账本 + hand-on 相邻族）

```
$ go test -race ./internal/gateway/ -run 'TestLedgerKeepsUpBytes|TestGroupFailsOver|TestRefusalFailsOver' -count=1
ok  	github.com/yetone/magpie/internal/gateway	11.685s
```

## gofmt / vet / build

- gofmt -l（5 个改动文件）：无输出，exit 0。
- go vet ./...（darwin）：exit 0；唯一输出 internal/gui/trayimage_darwin.go cgo -Wenum-conversion warning，预存（与改动文件无关）。
- GOOS=linux go vet -tags nogui ./...：exit 0。
- GOOS=windows go vet ./...：exit 0。
- 改动包三平台 build（gateway+usage）：linux OK / windows OK / darwin OK（darwin 有 ld 的 macOS 版本 warning，预存）。
- GOOS=linux go build ./... 全仓：exit 1——wails v3 linux webview（webview_window_linux.go:44 undefined: pointer）**父提交复测同红（exit 1），预存**，与本单无关。wails 属 gui 包，本单不触。

## 全量套件 go test -tags nogui ./...（82 ok / 5 FAIL，5 个全部定性预存）

| 失败 | 包 | 定性 |
| --- | --- | --- |
| TestCodexPoolSaysTheClientsVersion | gateway | 任务已知预存 flake |
| TestMothX | agent | 父提交复跑同红（exit 1） |
| TestEveryRouteHasACommandOrIsNamed | cli | 父提交复跑同红；上游守卫测试抓上游新路由 /api/usage/checkin-account 未配 cliForRoute |
| TestProxyCheckSaysAProxyPassedBy | gui | 父提交复跑同红；需外部代理环境（proxy asked 0 times, HTTP 502） |
| TestHostToldTheGatewayAddress | plugin | 父提交复跑同红；端口迁移时序 flake（MAGPIE_ADDR=3591 vs 3592） |

改动包+相邻包（gateway/usage/budget/usageapi）：usage ok 59.5s、budget ok、usageapi ok；gateway 与后台全量并行互踩 600s 超时（两套 gateway 全量同时跑，handbook 已知模式），随后单独重跑（见下）。

## gateway 包单独全量（-tags nogui -timeout 25m，无并行干扰）

```
gw exit: 1；--- FAIL 仅 1 个：TestCodexPoolSaysTheClientsVersion (0.03s)
FAIL	github.com/yetone/magpie/internal/gateway	559.309s
```

除任务已知预存 flake 外全绿（含新测试 TestLedgerKeepsUpBytes 与现有 Codex 套件），无新回归。

## Watched 三查

1. **手动打破回红**：消融已证（gateway.go 回父提交 → 新测试红）。
2. **兄弟面 rg 全查**（发上游的全部点）：
   - gateway.go forwardOnce（主路径，agent 请求）→ 已接。
   - codex_backend.go:1218 s.client.Do（Codex 订阅池 agent 请求）→ 已接。
   - codex_relay.go:82（magpie 未跑时的独立直连线程）→ 不接：该路径无账本行（relayError 直写响应，无 appendUsage）。
   - codex_warmup.go:477（预热）→ 不接：非 agent 请求，无行可落。
   - draw.go:1191 / embeddings.go:393 / decide.go:515 / video.go:1244 / search_kimi.go:137 / search_workbuddy.go:78 / codex_search.go:169（工具与小调用）→ 不接：非会话 turn 主链，body 为 KB 级，非本单目标（issue 语境是会话请求的上行）。
3. **失败读取语义**：ctx 无槽位（不经 serve 的旁路）→ upBytesOf 返回 nil → 记录与组装都跳过 → 行无字段（omitempty）。缺失 = 不知道，不假装 0，与旧记录缺失一致。

热路径代价：每请求 1 次 &upBytes{} 分配（~32B）+ 1 次 WithValue；每 try 1 次 ctx.Value 读 + 2 次 int 写（字节已在 sent 变量中算出，零额外遍历）；组装 1 次读。相对 MB 级 body 解析为噪声。

