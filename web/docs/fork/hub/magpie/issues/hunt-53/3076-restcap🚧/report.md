# #3076 rest-cap 修复报告（hunt53-d-restcap）

## 产物

- 分支：`hunt53-d-restcap`（基于 `318697dcea4ebd7514606a298a56fba9773d893d` = upstream/main），head **`048abe41e520c18823f8fda20270b12767d64abb`**，作者 `ggbdpq <ggbdpq@gmail.com>`，工作树干净。
- patch：`/Users/ggbdpq/cc/guahub/fork/magpie-hub/docs/issues/hunt53/3076-restcap/0001-provider-a-provider-s-rest-cap-and-quota-rest-reach-.patch`
- patch SHA-256 前 16：`1ef110ada14b45cb`
- issue 帖草稿：`issue-body.md`（嵌入 patch 与 patch 文件 diff 逐字节一致已验证；零中文；围栏 3 对；模型名仅出现在 patch 内 Generated-by）
- commit 消息：`commit-msg.txt`；全包日志：`provider-full.log`

## 改动

`internal/provider/provider.go` withPicks（:675）补 1 行多赋值（+3 行注释）：
`a.QuotaRest, a.QuotaResetAt, a.RestCap = pk.QuotaRest, pk.QuotaResetAt, pk.RestCap`
`internal/provider/rest_cap_test.go` 新增 2 个测试（63 行）：`TestWithPicksKeepsTheRest`（直接断言 + off/未设负例）、`TestRestCapReachesTheAccount`（SetRestCap→Find 写读回路，即报告者两个现象的单元层）。共 +67 行，无删改。

## 假设与引入提交证据（疏漏非有意）

1. `withPicks` 由 `5e5b6a5a`（2026-10-13，#1899）引入，引入时 RestCap 字段尚不存在。
2. `RestCap` 由 `bf258427`（2026-10-14，#2008）加入——晚 withPicks 一天。该提交把三字段补进 Save 侧账号拷贝白名单（provider.go:807），message 明说 "It is kept by the editor's save, the account copy and normalize"，全是写入侧，读取侧 overlay 被漏。
3. 既有惯例是新用户设置逐个补进 withPicks：`ExtraBody` 由 `dd25997a`（2026-10-15）补入；RestCap 被遗忘。
4. `QuotaRest`/`QuotaResetAt` 早于 withPicks 存在，同样从未被复制——`quota-rest` 对订阅账号同样失效（与报告者推测一致），同一行修复。

## RED（base 318697dc，还原 provider.go 保留测试，exit 1）

```
=== RUN   TestWithPicksKeepsTheRest
    rest_cap_test.go:16: an account of the provider keeps its rests: quota rest 0, reset at "", rest cap 0, want 90, "08:00", 240
--- FAIL: TestWithPicksKeepsTheRest (0.00s)
=== RUN   TestRestCapReachesTheAccount
    rest_cap_test.go:49: a rest cap set on codex reads back 0, want 240
--- FAIL: TestRestCapReachesTheAccount (0.05s)
FAIL
FAIL	github.com/yetone/magpie/internal/provider	0.998s
```

## GREEN（exit 0）

```
=== RUN   TestWithPicksKeepsTheRest
--- PASS: TestWithPicksKeepsTheRest (0.00s)
=== RUN   TestRestCapReachesTheAccount
--- PASS: TestRestCapReachesTheAccount (0.07s)
PASS
ok  	github.com/yetone/magpie/internal/provider	1.006s
```

## 消融

- 还原清单：`git diff --name-status upstream/main` = 仅 `M internal/provider/provider.go`（+新增测试文件未跟踪）。`git checkout upstream/main -- internal/provider/provider.go` 还原产品文件、保留测试。
- 结果：断言级 FAIL（即上面 RED 原文，无 build failed，符号闭包一次成立）。
- 恢复：修好的 provider.go 事先存仓外，拷回后 `git diff --stat upstream/main` = 1 file +4 行，定向复绿 exit 0。

## Watched 三查

- (a) 手动打破：注释掉新赋值行 → 两测试回红（exit 1）→ 还原复绿（exit 0）。
- (b) 兄弟面（逐点改/不改理由）：withPicks 调用点仅 2 处（provider.go:657 allProviders、logins_on.go:124 AlsoOn），同一 choke point 自动覆盖；Save 白名单 provider.go:807 已含三字段（不改）；normalize 夹紧 :1300-1305（不改）；setter 三件（SetRestCap/SetQuotaRest/SetQuotaResetAt）走 Find→Save 写侧本就保留（不改）；gateway 读点 routing.go:860/905/930/1051 读合并结果，是受益方（不改）；CLI echo providers_cli.go:1696 读 Find（不改，现象 1 的修复点）；GUI keep-old（gui/providers.go:1525-1536，old 来自 Find :1503）今天会把已存 restCap 抹成 0 存回——同根因下游，修 withPicks 即愈（不改）。**第三个漏复制构造点：无**。全仓 `Provider{` 字面量中代表「账号型 provider 存储设置」的只有 807（写，含）与 withPicks（读，曾缺）；其余（models.go 目录查找、importurl 向导、tui 表单、fallback.go 组路由、provider.go:1173 隐藏标记等）均无关。
- (c) 读失败：pk 未设（0）→ 合并后 0 → `RestCapOr(def)`=def、`NoFailRest()`=false，账号行为与今天完全相同（magpie 自己 1→2→4…10/30 分钟 ladder）；`RestCapOff(-1)` 可穿过 save/normalize/复制，unnamed failure 不休息、rate limit 仍 magpie 自己 30 分钟帽。负例由 `TestWithPicksKeepsTheRest` 后两段与 `TestRestCapReachesTheAccount` 中后段守卫。

## 矩阵（全在 /tmp/magpie-h44，GOTOOLCHAIN=auto）

| 项 | 命令 | 结果 | exit |
|---|---|---|---|
| 定向 | `go test ./internal/provider/ -run 'TestWithPicksKeepsTheRest\|TestRestCapReachesTheAccount' -count=1 -v` | 2/2 PASS, ok 1.0s | 0 |
| 全包 | `go test ./internal/provider/... -count=1 -timeout 20m` | `ok 80.552s`（无 flake，日志 provider-full.log） | 0 |
| 相邻 | `go test ./internal/gateway/ -run 'Rest\|rest' -count=1` | `ok 5.024s` | 0 |
| race | `go test -race ./internal/provider/ -run '<两新测试>' -count=1` | `ok 2.070s` | 0 |
| gofmt | `gofmt -l $(git diff --name-only upstream/main -- '*.go')` | 无输出 | 0 |
| vet | `go vet ./internal/provider/` | 无输出 | 0 |
| build darwin/arm64 | `GOOS=darwin GOARCH=arm64 go build ./...` | ok（ld 的 macOS SDK 版本 warning 预存） | 0 |
| build windows/amd64 | `GOOS=windows GOARCH=amd64 go build ./...` | ok | 0 |
| build linux/amd64 不带 tags | `GOOS=linux GOARCH=amd64 go build ./...` | 失败于 wails v3.0.0-beta.24 模块缓存内 `webview_window_linux.go:44 undefined: pointer`——预存依赖问题，与本次 diff（仅 internal/provider 两文件）无关；provider/gateway 单包 linux 构建均过 | 1（预存） |
| build linux/amd64 nogui | `GOOS=linux GOARCH=amd64 go build -tags nogui ./...`（Makefile :18/:41 的跨平台姿势） | ok | 0 |

## 不确定项

- linux 不带 tags 的全仓构建失败为预存（错在模块缓存里 wails 自身 linux 文件，本次 diff 不可达；且仓库自身跨平台构建走 `-tags nogui`）。未在 base 上重建对照（避免 stash/worktree 额外面），定性依据是出错文件位置 + 触达包单包构建全绿。
- 未验：真实 Codex 订阅账号、Docker 部署、报告者生产数据复算、GUI 编辑器手工流程（帖内 Not verified 如实列出）。
- issue 报告中的行号有漂移（如 withPicks :664 → 当前 main :675，restAfterMarked 实际在 gateway/routing.go:813 而非 provider.go）；帖内一律用 base main（318697dc）实测行号。

## usage

产物目录共 5 个文件（patch、issue-body.md、report.md、commit-msg.txt、provider-full.log），均未提交进任何仓库。worktree /tmp/magpie-h44 干净停在 head 048abe41，未 push。
