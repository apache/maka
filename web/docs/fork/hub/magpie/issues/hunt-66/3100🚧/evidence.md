# #3100 验证证据（Lane E，hunt66）

基线 tip：63be4771（worktree magpie-hunt66-e，分支 hunt66/e）。对象 commit：skygunner f85bd1664b489e411c295643da1a28dbacfa0bbc（test-only）。

## 1. attribution 实查（git show --format=fuller f85bd166）

- Author: vincent <webmaster@palmit.com.au>
- CommitDate: Fri Oct 23 07:33:40 2026 +1000
- trailer 逐字摘录：`Co-authored-by: ggbdpq <ggbdpq@gmail.com>`（命中）
- commit message 内声明：`Adapt ggbdpq/magpie 47f78b9900c96d0282683600882b7f6001d4595a.`

## 2. 保真对比

`git diff 47f78b99 f85bd166 -- internal/provider/signin_removed_test.go`：

- 同有：swap 前 `plugin.Refreshed()` + `plugin.Told()`、cleanup 内同两行再回写 `catalog.Changed = was`（功能性等价）。
- 对方多出：setUp 里 `writeFile(t, catalog.CachePath(), json.RawMessage(...))` 本地 catalog fixture（我方没有）——防测试拉 models.dev（消融日志实测确认回退版确实触发 `testenv: a test asked models.dev:443, refused`）。
- 对方把六行注释缩成一行。
- 结论：**适配**（核心 waits 同源同形，另加 fixture 面与注释缩写）。

## 3. 漂移与落地

- f85bd166^ = 665af242（10-23），merge-base(665af242, 63be4771) = 63be4771，`git rev-list --count 63be4771..665af242` = 481（对方基点领先 tip 481 提交）。
- `git cherry-pick f85bd166` 于 tip：**零冲突**落地 → 本地 commit 2061f195（比 format-patch|apply --3way --check 更强的落地证据）。

## 4. GREEN（修复在场）

- 命令：`go test -race -run '^TestSignInDoneOnceTheAccountIsBack$' -count=5 ./internal/provider/`
- 环境：Go 1.26.8 windows/amd64，CGO_ENABLED=1，gcc=D:\DevTools\Env\mingw64\bin（临时 PATH），GOPATH/GOMODCACHE/GOCACHE 显式固定。
- 结果 1：`ok github.com/yetone/magpie/internal/provider 10.071s`，exit=0
- 结果 2（消融恢复后复跑）：`ok ... 8.223s`，exit=0

## 5. 消融回红（回退其测试改动，即摘掉 waits）

`git checkout f85bd166^ -- internal/provider/signin_removed_test.go`（等价于摘掉 Refreshed/Told 两处等待）：

| 尝试 | 命令 | 结果 |
|---|---|---|
| 1 | `-race -count=100 ./internal/provider/`（全测试） | ok 117.227s，exit=0，无竞态 |
| 2 | `-race -run '.../fakeco' -count=600` | 撞默认 10m timeout 中断（panic: test timed out after 10m0s），非竞态非绿 |
| 3 | `-race -run '.../fakeco' -count=300 -timeout=25m` | ok 286.694s，exit=0，无竞态 |
| 4 | `-race -cpu=1,8 -run '.../fakeco' -count=150 -timeout=30m` | **RED** 386.867s，exit=1，1 次 DATA RACE / 300 次执行 |

RED 原文（ablation-red-cpu18-count150.log 头 40 行，节选）：

```
==================
WARNING: DATA RACE
Write at 0x000142a66a20 by goroutine 1160:
  github.com/yetone/magpie/internal/provider.TestSignInDoneOnceTheAccountIsBack.func9()
      .../internal/provider/signin_removed_test.go:112 +0x564
Previous read at 0x000142a66a20 by goroutine 1175:
  github.com/yetone/magpie/internal/catalog.Touched()
      .../internal/catalog/live.go:180 +0x52
  github.com/yetone/magpie/internal/plugin.tell.func1()
      .../internal/plugin/host.go:665 +0x44
Goroutine 1175 (finished) created at:
  github.com/yetone/magpie/internal/plugin.tell() ... host.go:657
  github.com/yetone/magpie/internal/plugin.listed() ... host.go:628
  github.com/yetone/magpie/internal/plugin.commitProviders() ... providers.go:280
  github.com/yetone/magpie/internal/plugin.init.func7() ... providers.go:316
  github.com/yetone/magpie/internal/plugin.refreshProvidersWithRetry() ... providers.go:335
  github.com/yetone/magpie/internal/plugin.refreshProvidersInBackground() ... providers.go:357
==================
--- FAIL: TestSignInDoneOnceTheAccountIsBack/fakeco (1.62s)
    testing.go:1712: race detected during execution of test
```

与 issue 报告同形（写 signin_removed_test.go:112，读 catalog.Touched 经 plugin.tell 链；行号漂移=tip 较旧：live.go:202→180、host.go:671→665）。

## 6. 质量门

- `gofmt -l internal/provider/signin_removed_test.go` → 空，exit=0
- `go vet ./internal/provider/ ./internal/plugin/` → 净，exit=0

## 7. 未跑/未验

- Linux/macOS 运行未验（本机 Windows）。
- 竞态概率性：本机默认 GOMAXPROCS 下 ~500 次执行未复现，-cpu=1,8 下 1/300 复现；复现率远低于维护者报告的 1/30 与我方 10-20 帖的 1/60，如实记录。
