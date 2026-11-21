# hunt50/c — yetone/magpie#2954（git 插件更新假成功，旧提交不换）

日期：2026-10-19 · 工作树：`/tmp/magpie-h27`（分支 `hunt50-c-git-plugin-lock`，基于 upstream/main `7916045591c318c84fa894022516a7ebffc9a91e`）

## 结论

已完成修复并验证。根因不在 magpie 的更新流程本身，而在 Bun 解析 git 依赖的方式：Bun 把仓库克隆成自己 install cache 里的裸仓（`<16位hash>.git`），解析 spec 时读的是这个克隆的本地 refs；Bun 自己的 fetch 只更新 `FETCH_HEAD`、不动 `refs/heads/*`，所以远端分支前进后，之后每一次解析——`bun update <name>`（`reinstall` 跑的）和卸载重装路径的 `bun add`——都重新解析回旧提交，`bun.lock` 再把这个旧提交记一遍（`name@git+…#bb961b2…`），bun 退出码 0，界面报"更新成功"。**bun.lock 是解析结果的记录，不是原因**；报告者"lock 钉住"的判断对现象，修复方向按任务指引落在"让解析重新看到远端"。

## 本地复现（无需内网）

用本机 bun 1.4.2（= magpie 的 `BunVersion`）+ 本地裸仓（`git+file://` 可用，代码的 `gitSpec` 正则本来就接受）逐步实测：

| 实验 | 结果 |
| --- | --- |
| 加装未固定 spec，远端前进后 `bun update my-plugin` | "no changes"、退出码 0、版本与 lock 的 `#sha` 不变（= bug） |
| 删掉 bun.lock 里该包条目再 `bun install` | 重新解析仍落旧提交，lock 被写回旧 sha |
| `bun update --force` / `bun install --force` | 同样旧提交（与报告者系统 bun 对照一致） |
| 卸载再 `bun add` | 经同一个过期克隆，旧提交（报告者的"重装也不更新"） |
| 手动 `git fetch origin "+refs/heads/*:refs/heads/*" "+refs/tags/*:refs/tags/*"` 刷新缓存克隆后，同一条 `bun update my-plugin` | 装到分支当前提交，lock 更新为新 sha |
| `#<sha>` 固定 spec：刷新 refs + bun update | 钉住不动（Bun 以 spec 里的 commit 为准） |
| `#<tag>` 固定 spec：强移 tag + 刷新 refs + bun update | 仍不重解析（lock 已记解析值）——本修复不改变此行为 |

Bun 缓存目录名是内部 hash（sha1/sha256 均对不上），因此按克隆 `config` 里的 `remote.origin.url` 匹配，不猜命名。

## 改动（commit `009ba8037f7b009ccdffb860a7a062a30bbd675b`，6 文件 +369/−7）

- `internal/plugin/gitrev.go`：新增 `refFixed`（`#<sha>` 判定）、`gitURLs`/`sameRepo`/`cloneOrigin`（按 URL 匹配缓存克隆）、`refreshGitCache`（对匹配的缓存克隆执行 `git fetch origin +refs/heads/*:refs/heads/* +refs/tags/*:refs/tags/*`，60s 上限；无克隆=无事可做，返回 nil）。
- `internal/plugin/store.go`：
  - `install`（`bun add`，覆盖卸载重装与 `InstallMissing`）调 `refreshGitCache`，**best-effort**（远端不可达时照旧用缓存装，缺插件重装不因远端宕机而失败）；
  - `reinstall`（`bun update`，Update/Update all/Upgrade/CLI 共用）先 `refreshGitCache`，**严格**（fetch 失败即报错，不假成功）；bun update 退出 0 后，用 `GitHeadCached`（页面检查时已缓存的远端头）比较，仍落后则报"left it at …, though its repository is at …"（要报错时才再问一次远端，正常路径零额外请求）——回应 issue 的"明确提示"诉求；
  - `#<sha>` 固定 spec 完全不动。
- `internal/plugin/bun.go`：抽出 `bunCacheDir()`（`bunCommand` 与刷新共用同一缓存路径）。
- `internal/plugin/plugin_git_test.go`：fake bun 增加 `MAGPIE_FAKE_BUN_STUCK=1`（update 保留 lock 提交，模拟过期缓存 Bun）；`gitFileURL` 提取复用。
- `internal/plugin/plugin_gitupdate_test.go`（新）：真 bun 端到端两用例 + 假 bun 守卫用例 + 单元表。
- `docs/subsystems/provider-plugins.md`：新增一段 git 更新路径说明（AGENTS 要求的文档同步）。

## RED → GREEN

RED（修前）：`TestGitUpdateInstallsTheBranchsCommitNow` → `the update said it is done, the plugin is still at 1.0.0, want 2.0.0`（真 machinery + 真 bun，Update 返回 nil 但版本不动 = 报告者的假成功）。修后 GREEN，并扩展覆盖卸载重装（remove + add → 3.0.0）。

## 消融与变异（均手工精确还原，diff stat 与内容核对）

- 消融（撤掉 store.go 全部接线，测试保留）：两个 update 用例 RED，pin 用例仍 GREEN（bun 自身语义保钉）。
- 变异 a（只删 reinstall 的刷新）：`TestGitUpdateInstallsTheBranchsCommitNow` RED。
- 变异 b（只删守卫）：`TestGitUpdateSaysWhenItDidnt` RED。
- 变异 c（固定 spec 也刷新）：全部 GREEN——如实记录：commit pin 由 Bun 的 spec 语义保证，跳过的意义是固定插件不花 fetch、远端宕机不致其更新报错。

## 验证矩阵

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| plugin 全套 | `go test ./internal/plugin/ -count=1` | ok（164.5s / 161.4s / 51.4s 三次，最后一次在最终 head），exit 0 |
| 邻包（驱动 install/CLI） | `go test ./internal/cli/ ./internal/provider/ -count=1` | ok（95s / 131s） |
| 格式 | `gofmt -l`（全仓） | 干净 |
| vet | `go vet ./internal/plugin/`（darwin/linux/windows） | 全过 |
| 构建 | darwin app；windows app（`CGO_ENABLED=0 GOOS=windows go build -tags production`，同 Makefile）；linux 79 个无需 GTK cgo 的包 | 全过 |
| `git am` | 共享 clone 检出基线 `79160455` 后 `git am` | 成功（树形状一致：6 文件 +369/−7） |

预存限制（非本改动引入）：Linux 全量 app 在 macOS 上交叉编译不可行——Makefile 明言 Linux 走 GTK/WebKitGTK cgo、每机原生构建；`internal/gui`、`internal/cli` 因此只能在 darwin 跑测试（已跑）。darwin 构建中的 CGImage/ld 警告为预存。

## 产物

目录：`/Users/ggbdpq/cc/guahub/fork/magpie-hub/docs/issues/hunt50/c-2954/`

- `0001-plugins-an-update-of-an-unfixed-git-source-re-resolv.patch`（`git format-patch -1`，默认上下文）——sha256 前 16：`3972138b17f75897`
- `2954-comment.body.md`——英文可贴正文（补丁全文嵌入 `<details>`；零中文已 grep 验证；分支行、What changed / Red before the fix / Verification / Siblings / Not verified、AI 与 Attribution 尾注齐备）
- `RESULT.md`（本文件）

## 不确定项 / 未验证

1. 报告者的内网 HTTPS git 主机未复现；全部证据来自本地 `git+file://` + bun 1.4.2。https 路径走的是同一个 Bun 内部 git fetch，报告者 issue §3 的隔离实验也指向同一机制，但内网服务器的 ref 通告差异无法在本机核实。
2. Bun 新版本若改变缓存克隆布局：`refreshGitCache` 找不到克隆即静默跳过，行为退回今天，不会更糟。
3. `#<tag>` 固定 spec 的更新仍不重解析（lock 记解析值）；本修复使"新 tag 找不到"（报告者系统 bun 对照里出现过）在全新解析时受益，tag 随 lock 不动是现状保持。
4. 未实测大仓库首次 fetch 的耗时上限体验（每次克隆 60s 封顶）。
5. GUI "更新成功"提示文案未改（错误会经 `Update`/`Upgrade` 的返回值如实呈现）；未跑 GUI/JS 层测试（本次未触及 `app.js`/`plugins.js`）。
