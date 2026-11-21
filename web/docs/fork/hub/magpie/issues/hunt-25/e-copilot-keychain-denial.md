接单修复，补丁在本机完成并验证通过，分支与 patch 见文末。

## 现象

报告者卸载 Copilot CLI 后，magpie 反复拉起 `security find-generic-password -s copilot-cli -a <账号> -w`（报告者的 ps 证据里这条命令与 `internal/provider/copilot_cli.go` 的 darwin 分支逐字一致，PPID 就是 magpie）。对弹出的 Keychain 授权框点 **Deny** 之后，弹窗仍会一遍遍回来——间隔约 10 分钟，只要 magpie 开着就无限循环。

## 最小复现（单元级）

前提：`~/.copilot/config.json` 还留着 `loggedInUsers`/`lastLoggedInUser`（卸载 CLI 不会删这个目录，#1495 已定性这是 agent 自己的文件、保持 discovered），且该账号在 `copilotTokens` 里没有明文 token。

1. magpie 列出订阅账号（`Accounts()`，GUI 的常规轮询就会走到），`copilotCLILoginIn` 找到账号、无明文 token → 调 `copilotCLISecret`；
2. darwin 上 spawn `security find-generic-password`，magpie 不在该 Keychain 项的 ACL 里 → 系统弹授权框；
3. 用户 Deny → 读失败 → 旧代码把它当作"没读到"缓存 10 分钟；
4. 10 分钟后下一次账号列表再走 1-3，弹窗回来。循环不终止。

红测试把这个循环钉住了：假 `security` 以 51 退出（模拟被拒的授权框），第一次读运行 1 次；把缓存时间拨过 10 分钟再读，旧代码又运行了一次 security——这正是"Deny 之后弹窗回来"的根源。

## 根因

`internal/provider/copilot_cli.go`（修复前）：

```go
out, _ = proc.Command("security", "find-generic-password", "-s", "copilot-cli", "-a", account, "-w").Output()
...
ttl = 10 * time.Minute // denied or absent; don't ask again at once
```

错误被整个丢弃，"用户看着弹窗点了拒绝"和"keychain 里根本没有这一项"共用同一个 10 分钟退避。前者每一次重试都会把对话框放回用户面前，后者从不弹任何东西。

## 修法

按退出码把两种失败分开（只动 darwin 分支，Linux/Windows 行为不变）：

- **退出码 44**（条目不存在；本机 macOS 实测 `security find-generic-password -s <不存在的项> -w` → exit 44、无任何 UI）：保留原 10 分钟重试，之后在 CLI 里新登录的账号仍能被及时发现；
- **其余失败**（要么是用户刚拒绝的授权框，要么是打不开的 keychain——重读只会把同一界面再放出来）：该账号本轮不再读，**重启 magpie 即是显式重试**（与报告者期望一致：Deny 生效、重试需用户动作）。

实现上把真实现从匿名 var 提为具名函数 `copilotCLISecretReal`（`copilotCLISecret` 仍指向它），测试才能占位再还原；`docs/subsystems/providers-accounts.md` 的 Copilot 段补了这句行为。

发现（discovery）的总开关、对残留凭据的 discovered 语义都不动——#1495 维护者已定性残留的 `~/.copilot` 是 agent 自己的文件，本修只尊重用户对具体 Keychain 项说过的"不"。

## 验证

| 检查 | 结果 |
|---|---|
| 修前红（2e2c8903 + 测试桥接副本） | `TestCopilotCLISecretDeniedNotAskedAgain`: `security ran 2 times after a denial, want still 1` |
| 修后绿 | 同测试 ok；`TestCopilotCLISecretAbsentRetriedAfterTheWait`（44 仍按 10 分钟重试的对照组）新旧树都 ok |
| 全包 | `go test -tags nogui -p 2 -count=1 ./internal/provider/` ok（74.8s） |
| 消融 | `git checkout 630cdb86~1 -- internal/provider/copilot_cli.go` 后红测试以同一断言复红，回置修复转绿 |
| gofmt | `gofmt -l internal/` 干净 |
| vet | `go vet ./...`、`GOOS=linux go vet -tags nogui ./...`、`GOOS=windows go vet ./...` 干净（`trayimage_darwin.go` 的 cgo `-Wenum-conversion` 警告为已知环境噪声） |
| build | darwin、`GOOS=linux -tags nogui`、`GOOS=windows` 三平台 `go build` ok |

**没跑什么（如实）**：没在真实 GUI 里走完一次 Deny 对话框——弹窗无法自动化点击；修法刻意不依赖 Deny 的精确退出码（非 44 即按"用户见过的失败"处理），44 的无 UI 路径在本机实测。Linux `secret-tool` 的拒绝语义未验证（本修不改 Linux 行为）。Windows 无 keychain 读，未测。cursor 的 `cursor-access-token` 读（10s TTL，同样无拒绝追踪）是同族面，但无报告、且挂着 fresh 语义，本修不碰，留作后续判断。

<details><summary>patch</summary>

```diff
