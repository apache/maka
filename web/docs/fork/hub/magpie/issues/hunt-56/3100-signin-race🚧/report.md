# issue #3100 处理报告（hunt56-c-signin-race）

日期：2026-10-20。worktree：`/tmp/magpie-h72`（分支 `hunt56-c-signin-race`，base `62a1df80` = upstream/main）。全程本地，未 push、未发帖、未碰主 clone。

## 产物

- 提交：`47f78b99`（完整 `47f78b9900c96d0282683600882b7f6001d4595a`），单文件 `internal/provider/signin_removed_test.go`，+13/−2，仅测试侧。
- patch：`/Users/ggbdpq/cc/guahub/fork/magpie-hub/docs/issues/hunt56/3100-signin-race/3100-signin-race.patch`，sha256 前 16 = `aef1af7a425c0614`。已在 base `62a1df80` 上 `git am` 实测：干净应用，所得树与 `47f78b99` 完全一致（临时分支 am-test 已删）。
- 英文帖：同目录 `issue-body.md`（五段 + 严格模板尾部；零中文已校验、围栏 4 个成对、模型名仅出现在内嵌 patch 的 Generated-by、验证表行间无空行、内嵌 patch 与 patch 文件逐字节一致已断言）。
- 过程日志：`red-30.log`、`red-fakeco-only-30.log`、`green-60.log`、`ablation-red-60.log`、`matrix-tests.log`、`fix.patch`、`commit-msg.txt`。

## 假设与 goroutine 来源链（核验后的事实）

1. 维护者说"更早的测试遗留 goroutine"。实测**只跑 fakeco 一个 subtest（`-run '.../fakeco' -count=30`）也复现同签名 race**——竞争 goroutine 来自 fakeco subtest 自己的 plugin 活动，不是跨测试遗留；但违反的规则与维护者命名的一致：测试启动的 plugin 后台工作越过测试的观察窗口边界还活着。
2. 完整来源链（race 报告 created-at 逐帧）：
   - `internal/provider/hold.go:98-99` 包级 init 注册 `plugin.OnChange(catalog.Touched)` / `plugin.OnListed(catalog.Touched)`（跨测试存续）。
   - fakeco subtest 装插件、签到后，`plugin.Cached()`（`internal/plugin/providers.go:649`）起后台 `refreshProvidersInBackground`（`!provGood && !provTried && !provSettling` 且插件列表非空时）。
   - refresh 完成 → `commitProviders` → `listed()`（`providers.go:287`，列表有变化时）→ `tell()`（`host.go:663`）起 goroutine 跑 hook（`host.go:671`）→ `catalog.Touched()` 读全局 `catalog.Changed`（`catalog/live.go:202`）。
   - 同刻 subtest body 在 `signin_removed_test.go:112` 写 `catalog.Changed` → race。
3. 为什么既有清理没兜住：fakeco 的 `t.Cleanup(plugin.Settle)` 注册在 setUp（LIFO 最后跑），而恢复 `catalog.Changed` 的 cleanup 注册在后（先跑）——交换窗口（:112 写入与 ：120 恢复）完全暴露在 plugin 后台工作之下；codex/claude 两个 subtest 各自新 HOME 无插件、`UseCached(nil)` 已重置 provGood，起不了 refresh，不是来源。
4. 修法（测试侧，最小）：交换点前后用包内既有导出屏障 `plugin.Refreshed()`（等后台 refresh，host 保持运行）+ `plugin.Told()`（等被 tell 的 hook；refresh 结束前其 tell 已计数，顺序 Refreshed→Told 闭合）。已验证闭合前提：told hook（`catalog.Touched`→`Forget`=`provider.Changed`）只丢缓存（`hold.go:144-153`），不会再派生新 refresh，故两道屏障之间无漏网 refresh。未给 `catalog.Changed`/`Touched` 加锁，未动测试断言，未动产品代码。

## RED 分布

| 参数 | 结果 |
|---|---|
| `-race -count=30`（issue 原命令） | 红，1/30（red-30.log） |
| `-race -count=30`，仅 fakeco subtest | 红，1/30（red-fakeco-only-30.log，同签名：write :112 / read live.go:202 ← host.go:671 ← providers.go:287 ← :649 Cached） |
| `-race -count=60`，还原修复（消融） | 红，1/60（ablation-red-60.log，同签名） |

race 报告 write 侧属 fakeco subtest（`--- FAIL: .../fakeco`），read goroutine 创建链如上。

## GREEN

- 修复后 `-race -count=60`：ok（green-60.log，17.9s，0 DATA RACE）。
- 消融还原修复 → 红（见上）；`git apply fix.patch` 恢复 → 矩阵 M1 再次 `-count=60` ok。

## Watched 三查

- (a) 打破：还原修复同参数跑 → 红 → 已恢复（即消融，同一步）。
- (b) 同模式清单：包内约 20 处测试交换 `catalog.Changed`，同时启动 plugin 工作的只有 fakeco 这一处（唯一两侧兼备）；`TestSignInCanceledWhileTheAccountComesBack` 也交换但不碰 plugin。Left（启动 plugin 工作且无 Settle/Refreshed/Told 的 17 个测试文件，均不交换 `catalog.Changed`，无一具备 race 两侧，按 issue 范围未动）：account_order_plugin、factory_key、plugin_fetch_lapse、pluginsignin_paste、account_names、plugin_usage、migrate_lapse、docker_signin、forget_account、migrate_handover、plugin_checkin、migrate_ux、plugin_id_reserved、plugin_id_custom、migrate、signin_proxy、pluginsignin（均 `*_test.go`，internal/provider/）。
- (c) 等待惯例：`Refreshed`/`Told` 就是包内既有形态（`Settle` 内部同样先 `refreshing.Wait()` 再 `Told()`；多个测试以 `t.Cleanup(plugin.Settle)` 依赖同一等待）；所等工作的耗时由产品侧截止时间兜底（`refreshDeadline` 30s × 3 次重试），未另加超时。

## 矩阵（逐项）

| 项 | 命令 | 结果 |
|---|---|---|
| M1 定向 race | `go test -race -run TestSignInDoneOnceTheAccountIsBack -count=60 ./internal/provider/` | ok 17.1s |
| M2 全包 race | `go test -race ./internal/provider/ -count=1` | ok 89.3s |
| M3 provider 无 race | `go test ./internal/provider/... -count=1` | ok 66.3s |
| M4 plugin 无 race | `go test ./internal/plugin/... -count=1` | ok 49.5s |
| gofmt | `gofmt -l internal/provider/` | 空 |
| vet | `go vet ./internal/provider/... ./internal/plugin/...` | 干净 |
| build darwin/arm64 | `GOOS=darwin GOARCH=arm64 go build ./...` | 过（仅预存 cgo/ld warning，与 test-only 改动无关） |
| build linux/amd64 | `GOOS=linux GOARCH=amd64 go build -tags nogui ./...` | 过 |
| build windows/amd64 | `GOOS=windows GOARCH=amd64 go build -tags nogui ./...` | 过 |

## 提交与身份

- `git config user.name/user.email` = `ggbdpq` / `ggbdpq@gmail.com`，核过。
- commit 首行：`provider: the sign-in test swaps catalog.Changed only once the plugins' background ask and telling are over (#3100)`；正文 What changed / Run；`Fixes #3100`；尾注 `Generated-by: GLM-5.3-Flash (ZCode)`（仅出现在 patch 内）。

## 不确定项

1. race 是概率性的：绿 60 次是窗口关闭的检测器证据，不证明无其他窗口（帖内 Not verified 已如实写）。
2. 触发那次 refresh 的确切 `Cached()` 调用行未钉死（race 报告只给到 `Cached.gowrip1` 的 go 语句，`Cached` 的调用方不在栈上；推断是 body 早期 `Delete`/`All()` 路径或 setUp 内 plugin 活动期间 provGood 尚未置位/被签到保存失效的窗口）。不影响修法：两道屏障不依赖具体起因。
3. 未在 Linux/Windows 实跑；Left 的 17 个文件未逐一 race 定性（无一具备 race 两侧，静态判定）。
4. issue-body.md 中 race 摘录去掉了各帧 `/tmp/magpie-h72/` 路径前缀和 toolchain 绝对路径帧（标为摘录；两栈 + created-at 链保留）。
