# #2954 rebase 报告（2026-10-20）

## 结果
- 新 head：`298be6db01a394ac8294067f5a41cc686c82d775`（/tmp/magpie-h43，分支 `hunt53-r3-git-plugin-lock`，父 `318697dc`=upstream/main，树 `7ca8fa90`）。commit message 与 Generated-by 尾注原样保留，未追加。
- Patch：`docs/issues/hunt53/2954-git-plugin-lock/0001-plugins-an-update-of-an-unfixed-git-source-re-resolv.patch`，sha256 前 16 = `a919403d0138a990`。已在干净 `318697dc` worktree 上 `git am` 验证（exit 0，套用后 commit `d0b0ec43`），worktree 已删。
- 回帖草稿：`docs/issues/hunt53/2954-git-plugin-lock/comment.md`（零中文已验、围栏 2 对、模型名只在 patch 围栏内）。
- 改动面：5 文件（bun.go 已退出补丁）：docs/subsystems/provider-plugins.md +2、gitrev.go +124、plugin_git_test.go ±8、plugin_gitupdate_test.go +200（新）、store.go +31/-2。

## 冲突解法
`a2573199` 把 bun.go 内联的 `BUN_INSTALL_CACHE_DIR` 路径抽成 `installCacheDir()`（新建 installcache.go）并删掉 bun.go 的 catalog import；原补丁同区域加了自备 `bunCacheDir()`。解法：bun.go 整体取上游（原补丁的 bun.go 改动整体放弃，diff 归零），gitrev.go 的 `refreshGitCache` 改调上游 `installCacheDir()`；docs 段落的 `bunCacheDir`/bun.go 悬空引用同步改为 `installCacheDir`/installcache.go。store.go、docs 其余、两个测试文件全部自动合并，合并后段落位置与前后文核对无误（157 行 missing-plugins 段之后）。

## 版本清理 × git 克隆缓存交互结论：正交，无处理需要
`pruneCached` 只删目录名能切成 `name@version@@…` 且版本 ≠ node_modules 已装版本的条目，外加悬空 symlink。git 克隆目录名 `<16hex>.git` 不含 `@`，走 folders 分支只做悬空 symlink 检查（bare clone 内无 symlink）；git 依赖的已提取条目（`name@<sha>` 形态）在 `Cut(rest,"@@")` 不含 `@@` 时被 continue 跳过。清理不会误删 git 克隆或其提取内容，refreshGitCache 的发现逻辑与 GitHeadCached 比对不受影响。

## 步骤 2 RED（新 main 318697dc，仅取测试 + 最小桥接）
```
--- FAIL: TestGitUpdateInstallsTheBranchsCommitNow (0.28s)
    plugin_gitupdate_test.go:79: the update said it is done, the plugin is still at 1.0.0, want 2.0.0
--- FAIL: TestGitUpdateSaysWhenItDidnt (0.21s)
    plugin_gitupdate_test.go:121: the update said it is done, though the plugin is still at the commit it was at
```
上游未自修，不「让位」。桥接=仅拷贝测试直接引用的纯函数 refFixed/sameRepo/cloneOrigin，不接线产品代码（cherry-pick 前已删）。

## GREEN（cherry-pick 后定向）
`go test ./internal/plugin/ -run Git -count=1 -v`：全部 PASS（三个新测试 + 既有 git 测试），`ok ... 5.211s`（另一次 4.813s），exit 0。

## 消融（每次后 `git checkout HEAD -- <file>` 恢复，最终复绿）
- A 摘 store.go 全部接线（gitrev.go 按「符号依赖闭包」保留不接线）：两个 update 测试回红（断言原文同上），`TestGitUpdateKeepsACommitPin` 保持绿——与原帖结论一致。
- B 只摘 fetch（refreshGitCache 顶部 return nil）：只红 `TestGitUpdateInstallsTheBranchsCommitNow`。
- C 只摘 still-behind 报告：第一次摘法（`if false && head := ...`）build failed（`non-name false && head on left side of :=`），按预案改为整块删除后：只红 `TestGitUpdateSaysWhenItDidnt`。
- D refFixed 恒 false（pin 当未固定）：`-run Git` 全绿——pin 是 Bun 自身语义，skip 只是省一次 fetch。
- bun.go：新补丁无 diff，无可摘。

## 三查
- (a) 打破核心判定：消融 B（不 fetch）与 C（摘比对）即此，均已回红并还原。
- (b) 兄弟面：接线仅 install（best-effort；覆盖 Add/InstallMissing/provider migrate 的 keepMovedCurrent→installPlugin→Add）与 reinstall（严格 + 比对；覆盖 Update 的 git 分支、Upgrade、页面 Update）。不改的：github.go/market.go 的 IsGit 分类（不读缓存）、updates.go 的 Pinned（git 永不 pinned）与页面 GitBehind 比对（补丁让 update 真装上比对所见）、GitCommit/GitHeads 的 bun.lock 读取（lock 现在记真实 resolve 的 commit，答案更真）。
- (c) 失败路径：无匹配克隆（GitHub tarball、首装）或缓存目录不可读 → ReadDir/无循环 → 返回 nil=今天的行为；fetch 失败 → install 忽略（尽力而为）、reinstall 报错（不谎报成功）；git 不在 PATH → 只在存在匹配克隆时暴露，而该类 spec 本就需 git 才能 bun install。

## 矩阵（全部在 /tmp/magpie-h43）
| 项 | 命令 | 结果 |
| --- | --- | --- |
| 定向 | `GOTOOLCHAIN=auto go test ./internal/plugin/ -run 'Git' -count=1 -v` | ok 5.211s，全 PASS |
| 全包 | `GOTOOLCHAIN=auto go test ./internal/plugin/... -count=1 -timeout 20m`（日志 plugin-full.log） | ok 171.287s，exit 0，无预存红 |
| race | `GOTOOLCHAIN=auto go test -race ./internal/plugin/ -run 'Git' -count=1` | ok 32.645s，exit 0 |
| gofmt | `gofmt -l $(git diff --name-only upstream/main -- '*.go')` | 空输出，exit 0 |
| vet | `GOTOOLCHAIN=auto go vet ./internal/plugin/` | 无输出，exit 0 |
| build darwin/arm64 | `GOOS=darwin GOARCH=arm64 go build ./...` | exit 0（仅 wails/链接器 warning） |
| build linux/amd64 | 裸 `go build ./...` 挂在 wails Linux GUI 层（`undefined: pointer`，第三方模块缓存，预存、与本单无关）；按 Makefile 自带配方 `CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags nogui ./...` | exit 0 |
| build windows/amd64 | `GOOS=windows GOARCH=amd64 go build ./...` | exit 0 |
| git am | 干净 318697dc worktree 上 `git am <patch>` | exit 0（d0b0ec43），worktree 已删 |

## 不确定项
- 未复现报告者的内网 HTTPS host（全部本地 git+file://，bun 1.4.2=magpie 运行版本）；GUI 流程与 bundled bun 下载路径未走（测试用 MAGPIE_BUN 指向本地 bun）。
- 大仓库首更耗时未测（fetch 单克隆上限 1 分钟）。
- 裸 linux `go build ./...` 的 wails 失败未深挖（第三方代码，非本单范围），以 Makefile nogui 配方为 linux 信号。
- comment.md 尚未发帖；分支未推送（head `298be6db0` 需主线程 force-push 到 `hunt50-c-git-plugin-lock`）。

## 环境备注
- bun 1.4.2、git 2.50.1（Apple）、go 1.26.8 均在 PATH。
- zsh 配置噪音：每次命令报 `setValueForKeyFakeAssocArray:27: command not found: _encode/_decode`，与任务无关，已过滤。
