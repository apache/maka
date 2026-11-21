# Hunt54-D · issue #3083 处理报告（plugin sign-in CLI 超时常量与措辞）

日期：2026-10-21 · 分支 `hunt54-d-signin-timeout`（独占 worktree `/tmp/magpie-h54`）· base `c922225f`（=upstream/main）

## 产物

- head SHA：`f21de209e2727b6a557c1362f826ddebbe596df7`（`f21de209`）
- patch：`docs/issues/hunt54/3083-signin-timeout/0001-cli-a-plugin-sign-in-that-runs-out-says-so-on-the-sa.patch`
- patch sha256 前 16：`aa4b023ef0470150`
- 英文帖草稿：`docs/issues/hunt54/3083-signin-timeout/issue-body.md`（零中文，模型名只在 patch 内 Generated-by）
- commit message：`docs/issues/hunt54/3083-signin-timeout/commit-message.txt`
- 未 push、未发帖、主 clone 未动、未动其他 /tmp/magpie-h*。

## 改动面（4 文件，+51/-3）

1. `internal/provider/signin.go`：新增导出访问器 `SignInTimeout() time.Duration`（返回未导出 `signInTimeout`，var 不改名不导出）。
2. `internal/cli/plugins_cli.go:498`：`context.WithTimeout(ctx, 10*time.Minute)` → `context.WithTimeout(ctx, provider.SignInTimeout())`；`time` 导入随之删除（该字面量是它的唯一用点）。
3. `internal/cli/plugins_cli.go:521-525`：`plugin.Finish` 错误为 `context.DeadlineExceeded` 时转译为 `"the sign-in timed out; start it again"`（照 GUI `pluginDone` 的措辞）；其他错误原样透传。
4. `internal/cli/plugin_login_cli_test.go`：两个新测试（超时措辞 + 非超时透传守卫）。
5. `internal/plugin/testdata/fake/index.js`：fake 插件 oauth callback 加 `code === "wait"` 分支（永不定结的 promise），供测试制造慢 sign-in；其他 code 值行为不变。

## 假设与选择

- **慢 sign-in 模拟**：最初用 fake 插件 `$FAKE_LOOPBACK=1`（callback 挂在等浏览器回调上）+ 短超时父 ctx。父 deadline 先到时子 ctx `Err()` 也是 `context.DeadlineExceeded`，与真实 10 分钟到点同形，`errors.Is` 可判；无需缩短 `signInTimeout`（provider 未导出 var，cli 测试不可及）。
- **第一形态被 race 打回**：FAKE_LOOPBACK 使 CLI 走粘贴分支，`plugins_cli.go:504` 的 goroutine 读包级 `stdin`，与 `piped` cleanup 恢复 `stdin` 之间无 happens-before——`-race` 报 DATA RACE（真实终端下无此竞争，纯测试环境产物）。改用 `code === "wait"` 分支走 code 方法，不开粘贴 goroutine，race 干净。
- **FAKE_LOOPBACK 环境变量时序坑**：`t.Setenv` 必须在 `fakeCoHome` 之前——host 子进程在 `fakeCoHome` 内 `plugin.Providers` 就已启动，晚设的环境变量它看不到（表现为 authorize 走了 code 分支、测试拿到 stdin EOF）。
- **共享常量导出形态**：选导出**函数** `SignInTimeout()` 而非导出 var 或改名。provider 包对外暴露配置以导出函数为主（`StaleAllowance`、`ProxyOfLogin`）；导出可变 var 等于允许其他包改写；改名则动包内多处。修法 (2) 的一致性收益靠这行落点保证，无行为差可测（两个都是 10 分钟），由消融+检视覆盖。
- **措辞转译放 CLI 侧**：不放进 `plugin.Finish`（那会波及 GUI 的 `pluginDone` 判定链），不加 Authorization 字段（修法 (1) 留维护者），不改 10 分钟默认，不动 GUI。

## RED / GREEN / 消融（最终形态）

- RED（base，产品文件 `git restore`，测试保留）：`go test ./internal/cli -run TestPluginLoginSaysTimedOut -count=1`
  ```
  --- FAIL: TestPluginLoginSaysTimedOut (5.08s)
      plugin_login_cli_test.go:116: the clock ran out and magpie said "context deadline exceeded"; want it timed out
  FAIL
  FAIL	github.com/yetone/magpie/internal/cli	5.532s
  ```
- GREEN（重新应用修复）：同命令 `ok`（5.08s）；负例 `TestPluginLoginKeepsAPluginErrorAsItCame` ok。
- 消融：`git diff --name-status upstream/main` 全列（4 文件）→ `git restore internal/cli/plugins_cli.go internal/provider/signin.go`（保留测试与 testdata）→ 上命令复现同文 FAIL → 恢复修复复绿。

## Watched 三查

- (a) 手动打破：删掉转译（保留共享常量）→ `TestPluginLoginSaysTimedOut` FAIL（"context deadline exceeded"）→ 还原复绿。
- (b) 字面量与用点清单（`rg 'signInTimeout|10 \* time\.Minute|WithTimeout' internal/{cli,provider,gui}` 非测试 + mcpauth 全库补查）：
  - `provider/signin.go:48` `signInTimeout` 权威源——不改（改默认值 out of scope）。
  - `provider/signin.go:267` `timeout := signInTimeout`、`provider/pluginsignin.go:126`——已共享。
  - `cli/plugins_cli.go:499`（base 行号；issue 写 498 有 1 行漂移）——本次改为 `provider.SignInTimeout()`。
  - **Left**：`internal/mcpauth/mcpauth.go:63-64` 自持一份 `signInTimeout = 10 * time.Minute`（MCP 浏览器授权），超时措辞已是人话（mcpauth.go:927），只余常量副本未统一——独立包、issue 未提，列给维护者。
  - **Left（无裸 deadline 问题）**：内建 sign-in 的 CLI 入口超时由 provider 侧 watcher `finish(failed, "the sign-in timed out; start it again")`（signin.go:275）`WaitSignIn` 带回人话，无需转译。
  - 其余 `10*time.Minute` 语义无关 sign-in，不动：update_cli.go:155（自更新）、gui/update.go:280、gui/providers.go:986（订阅迁移 moveContext）、provider/install.go:67（installTimeout，装 CLI 预算）、autolist/partners/migrate/codex_warmup/logins/quota_alert/account/copilot_cli/codex_autoreset（簿记类）。
  - 裸 `DeadlineExceeded` 非测试用点全列：本次加的 plugins_cli.go:522、GUI 的 pluginsignin.go:152/202——无其他 Left。
- (c) 负例守卫：`TestPluginLoginKeepsAPluginErrorAsItCame`（fake 的 expired code → "the sign-in page expired" 原样透传）在 RED/GREEN/消融各轮均 PASS。

## 矩阵（全绿）

| 项 | 命令 | 结果 |
|---|---|---|
| 定向 | `go test ./internal/cli -run 'TestPluginLoginSaysTimedOut\|TestPluginLoginKeepsAPluginErrorAsItCame' -count=1` | ok（5.5s） |
| cli 全包 | `go test ./internal/cli/... -count=1` | ok 48.3s |
| plugin 全包（testdata 动了） | `go test ./internal/plugin/... -count=1` | ok 70.2s |
| provider 全包（覆盖任务要求的 SignIn\|Signin 定向） | `go test ./internal/provider/... -count=1` | ok 85.7s（SignIn 定向单独跑过 ok 24.8s） |
| race 定向 | `go test ./internal/cli -run TestPluginLogin -count=1 -race` | ok（第一形态曾报 paste goroutine race，换 code 形态后绿） |
| gofmt | `gofmt -l internal/cli internal/provider internal/plugin/testdata` | 空 |
| vet | `go vet ./internal/cli/... ./internal/provider/...` | 干净 |
| build×3 | darwin/arm64、linux/amd64 `-tags nogui`、windows/amd64 | 全 exit=0（darwin 仅有本机预存 ld 版本警告） |

## 不确定项 / 如实说明

- 未在真实 qoder 插件上复跑 15 分钟流：测试的时间压缩是「fake 永挂 callback + 5s ctx」，deadline 处返回的错误与真实 10 分钟到点同为 `ctx.Err()`=`context.DeadlineExceeded`（host.go:1465-1467 原样返回），但真实浏览器流未跑。
- 修法 (2)（共享常量）无行为差可测（两处同为 10 分钟），其验证是消融外的代码检视+字面量清单，非失败测试。
- fake 插件 testdata 是共享资产：`code === "wait"` 分支仅在该 code 值生效，plugin/provider 全包已跑绿，但下游若有人按 code 值枚举测试需知悉。
- commit 尾注 `Generated-by: GLM-5.3-Flash (ZCode)` 按任务要求添加；上游近期 commit 无此惯例。
