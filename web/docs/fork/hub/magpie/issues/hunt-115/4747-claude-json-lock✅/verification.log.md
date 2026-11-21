# 4747 验证日志（hunt-115 / 2026-11-01）

Issue: https://github.com/yetone/magpie/issues/4747（yetone 亲单，2026-11-01）
Comment: https://github.com/yetone/magpie/issues/4747#issuecomment-6557203677
Branch: https://github.com/ggbdpq/magpie/tree/fix/4747-claude-json-lock head `b7a5a8f13e2b7c51f9aa0e2bd6fa248c76720d72`
Patch SHA-256 first 16: `7de2c043551a0823`
基线：upstream/main `d1a94f5792136c2a666ddf13cd5210168c69635e`（开工 SHA，POST 前门禁复查无自修、5 新提交零触及域）

## 修复面

- `internal/claudelock/claudelock.go`（新）：锁原语自 provider 迁出（issue 指定方向之一）；`Config(path)` = realpath+".lock" mkdir 锁、stale 10s、触碰 2s、wait 20s；`ErrHeld` 哨兵。
- `internal/provider/claude_lock.go`：瘦身为 `claudelock` 包装；`claudeRefreshLocks` 顺序与 `errClaudeLocked` 文案原样保留（#4532 行为零变）；`claudeHeld` 翻译 ErrHeld→errClaudeLocked。
- `internal/library/mcp.go`：`mcpFile.putEntry`/`del` 的 JSON 分支在 `edit.Atomically` 前取 `claudeLock()`；`f.Format==fmtClaude && Clean(f.Path)==Clean(claudeJSON())` 才取锁（WSL/其它文件天然排除）。
- 测试：`internal/library/claude_json_lock_test.go`（新）；`internal/provider/claude_lock_test.go` 仅 `claudeLockWait`→`claudelock.Wait`。

## 锁语义信源

- 仓内：#4532 提交 `0b7d5f3a2`（正文尾句点名本单；语义读自 Claude Code 2.1.316 bundled source：`gi` config save lock）。
- 公开：npm proper-lockfile 文档 —— mkdir 目录锁（任意 FS 原子）、`<file>.lock` 后缀、mtime 判 stale（默认 10000ms）、update 定期刷新 mtime（默认 stale/2）。与 landed 实现一致，零虚构。

## RED（修前，d1a94f579 基线）

```
--- FAIL: TestClaudeJSONMCPWaitsForClaudeCodesLock (1.92s)
    claude_json_lock_test.go:39: saved while Claude Code held its lock
--- FAIL: TestClaudeJSONMCPTakesAStaleLock (0.03s)
    claude_json_lock_test.go:90: the lock left behind: <nil>
```

## GREEN（b7a5a8f13）

```
=== RUN   TestClaudeJSONMCPWaitsForClaudeCodesLock
--- PASS: TestClaudeJSONMCPWaitsForClaudeCodesLock (2.45s)
=== RUN   TestClaudeJSONMCPTakesAStaleLock
--- PASS: TestClaudeJSONMCPTakesAStaleLock (0.05s)
ok  	github.com/yetone/magpie/internal/library	2.861s
```

Provider 锁回归（迁出代码）：`go test ./internal/provider -run TestClaudeSwitch` 14/14 PASS（含 TestClaudeSwitchWaitsForClaudeCodesRefresh 的 refresh/legacy/config 三分支、TestClaudeSwitchStaleAndHeldLocks 的 stale/held）。

## 消融（先提交后消融；只回退 internal/library/mcp.go 至父提交，测试保留）

```
--- FAIL: TestClaudeJSONMCPWaitsForClaudeCodesLock (1.92s)
--- FAIL: TestClaudeJSONMCPTakesAStaleLock (0.04s)
FAIL
```
恢复（git checkout HEAD --）后同测试 `ok`。

## 矩阵

- 定向：上两项 GREEN ✓
- 改动包全量 `-tags nogui`：`internal/library` ok 84s；`internal/provider` ok 110s；`internal/claudelock`（无测试文件，编译过）
- race：library 两个锁测试 + provider 两个锁测试 `ok`
- `gofmt -l` 触及文件：无输出（mcp.go 一次 import 排序已修）
- `go vet` 三包 × darwin/linux/windows：exit 0
- build `-tags nogui`：darwin/linux/windows 全过；darwin 无 tag build 过（预存 cgo warning）；linux 无 tag build 失败于 wails v3 依赖自身 linux GUI 文件（`undefined: pointer`，预存，与本单无关）
- 兄弟面结论：settings.json（mcp_tools_off.go 写）无 Claude Code 锁协议证据，不改；Codex config.toml、Cursor mcp.json、Desktop manifest 等同理；账号目录 .claude.json 写入是 magpie 新建目录的创建性写入（IsNotExist 守卫），无并发对象，不改
- 热路径代价：每次 .claude.json 写入一次 mkdir + 2s ticker goroutine，即写即放；等待仅发生在 Claude Code 真持锁时（亚秒级）

## Not verified

- 真实 Claude Code 并存保存场景（其保存亚秒级、无法按需复现）
- WSL distro 内 Claude Code 与 distro 副本写入（锁在 distro 文件系内，路径比较天然跳过）
