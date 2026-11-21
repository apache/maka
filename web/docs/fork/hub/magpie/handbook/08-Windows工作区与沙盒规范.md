# Windows 工作区与沙盒规范

> **历史（2026-11-07 校注）**：Windows 工作区已于 10 月撤除，当前为 macOS /tmp worktree 制，见 [05](05-缺陷狩猎经验.md) 文首「Mac 侧」段与 §5.3；本文的目录与 PowerShell 命令不再作为新建目标。§4 的隔离原则（固定 Go 缓存、进程级重定向 HOME、独立沙盒、不读真实账号）仍适用。

2026-10-13 实查并经用户确认。本文是 Windows 本机的目录与创建命令入口；旧 Mac 路径和迁移记录只作历史参考。本次只修改文档，没有移动、删除或新建运行目录。

## 1. 目录与用途

| 用途 | 固定位置 | 约束 |
| --- | --- | --- |
| 项目根 | `E:\cc\guahub\fork\magpie-hub` | 不是 `magpie-hubc` |
| 主 clone | `E:\cc\guahub\fork\magpie-hub\magpie` | 不切换、重置或 stash 主线程/用户的工作 |
| 三个并行目录 | `E:\cc\guahub\fork\magpie-hub\magpie-pr1`、`magpie-pr2`、`magpie-pr3` | 当前是三个独立 clone，不是主仓注册的 linked worktree；每路独占一个 |
| 补丁、日志、复现证据 | `E:\cc\guahub\fork\magpie-hub\docs\issues\<任务>` | 不把临时 HOME、缓存、账号文件或 exe 混入上游提交 |
| 项目文档 | `E:\cc\guahub\fork\magpie-hub\docs` | 历史台账只追加，不批量重写旧证据路径 |
| 新运行沙盒统一根 | `E:\magpie-sandboxes` | 每次使用 `<任务>-<UUID>` 子目录，不再直接创建 `E:\magpie-<任务>-<UUID>` |

`E:\cc\.git` 确实存在。hub 内的目录有 Git 祖先，不能用于声称“完全不在任何 Git 仓库内”的测试。运行沙盒应在 `E:\magpie-sandboxes` 下；证据收口时另存到 hub 内，并记下原运行路径。不要为了清理目录而删除真实 `.git`。

截图中已有的 `E:\magpie-1702-*`、`magpie-gateway-*`、`magpie-claude-*`、`magpie-mcp-*` 等多数是运行沙盒，不是 worktree。本次不移动它们；旧日志和脚本仍可引用原位置。旧脚本不在本次修改范围内，再次运行前须检查并按本页调整其沙盒根，不能因文档更新就假定脚本已更新。

## 2. 默认复用独立 clone，不自动增建 worktree

开工先读 `git status --short`、当前分支和 `git worktree list --porcelain`。`magpie-prN` 有 `.git` 并不表示它共享主仓；用 `git rev-parse --path-format=absolute --git-common-dir` 核对，不能对独立 clone 使用主仓的 `worktree repair/remove`。

每个独立 clone 要单独 fetch；主仓 fetch 不会更新另外三个 clone 的 refs。origin 的地址须实查，不能默认是用户 fork。下面使用明确的上游 URL：

```powershell
$Hub = 'E:\cc\guahub\fork\magpie-hub'
$Repo = Join-Path $Hub 'magpie-pr1' # 按分配改成 pr2 或 pr3
$Branch = 'hunt/issue-xxxx'        # 每次选未被占用的新分支名
if (!(Test-Path -LiteralPath (Join-Path $Repo '.git'))) { throw '并行 clone 不存在，先报告，不自动重建' }
$dirty = git -C $Repo status --porcelain
if ($LASTEXITCODE -ne 0) { throw '无法读取仓库状态' }
if ($dirty) { throw '有已有修改或未跟踪文件；保留并报告，不覆盖或清理' }
git -C $Repo fetch https://github.com/yetone/magpie.git +refs/heads/main:refs/remotes/upstream/main
if ($LASTEXITCODE -ne 0) { throw 'fetch 失败' }
git -C $Repo switch -c $Branch upstream/main
if ($LASTEXITCODE -ne 0) { throw '分支创建失败；不使用 -B 覆盖已有分支' }
```

收口先保存补丁和验证证据、确认修复分支已安全保留，再核对干净状态。已有 `prN` 分支可 `switch prN` 后 `merge --ff-only upstream/main`；没有 `prN` 时才 `switch -c prN upstream/main`。有独有提交、分叉、未提交或未跟踪文件就停止复位，不用 `reset --hard`、`checkout -B`、`git clean` 或自动 stash 解决。分支清理与目录迁移另行确认。

## 3. 确实需要 linked worktree 时

仅在用户明确要求增建时执行，目标必须在 hub 内且尚不存在，不能复用已经是独立 clone 的 `magpie-pr1/2/3`。先查看主仓的注册清单：

```powershell
$Hub = 'E:\cc\guahub\fork\magpie-hub'
$Main = Join-Path $Hub 'magpie'
git -C $Main worktree list --porcelain
if ($LASTEXITCODE -ne 0) { throw '无法读取 worktree 清单' }
# 示例路径与分支需按已批准的任务命名；不要原样反复执行。
$Target = Join-Path $Hub 'magpie-extra-issue-xxxx'
if (Test-Path -LiteralPath $Target) { throw '目标已存在；不覆盖、不删除、不 repair' }
git -C $Main fetch https://github.com/yetone/magpie.git +refs/heads/main:refs/remotes/upstream/main
if ($LASTEXITCODE -ne 0) { throw 'fetch 失败' }
git -C $Main worktree add -b hunt/extra-issue-xxxx $Target upstream/main
if ($LASTEXITCODE -ne 0) { throw 'worktree 创建失败；检查目录/分支占用，不加 --force' }
```

这是新建流程示例，不是将现有四个独立 clone 转为 worktree 的迁移方案。所有 Git 命令用 `-C` 绝对路径；PowerShell 5.1 不使用 Bash 的 `&&`、heredoc 或 `env -u`。

## 4. 沙盒与证据收口

- 只在需要运行测试时创建 `E:\magpie-sandboxes\<任务>-<UUID>`；使用前检查根目录及祖先没有 `.git`，出现 Git 祖先时停止并选择其他经确认的非仓库位置。
- 在替换 HOME 前固定既有 `GOPATH`、`GOMODCACHE`、`GOCACHE`。进程级重定向 HOME、USERPROFILE、TEMP、TMP、APPDATA、LOCALAPPDATA、XDG_CONFIG_HOME、XDG_CACHE_HOME、XDG_DATA_HOME、XDG_STATE_HOME，并按项目 `testenv`/`agentenv` 规则处理 agent 专用环境变量；仅有 portable 标记不能保证账号发现隔离。
- `go test`、浏览器、假厂商及 exe 各自使用独立沙盒；只监听回环且避开用户正在使用的端口。不读取真实账号、不发真实付费请求。
- 每路结束时等待或停止自己启动的进程，再将必要且已脱敏的日志/复现资料保存到 `docs\issues\<任务>`。目录清理须明确区分运行数据和保留证据，未经授权不移动或删除旧目录。
