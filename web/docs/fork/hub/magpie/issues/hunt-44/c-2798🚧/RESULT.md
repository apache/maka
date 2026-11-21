# #2798 — Claude Code 更新后残留 shebang-less stub，`runsBroken` 判成 unknown

## 结论

报告者的诊断正确。`runsBroken` 的 `code <= 0` 把「exec 根本没跑起来」和「跑起来但失败」混成一个「unknown」；真实 Claude Code stub 没有 shebang，`execve` 返回 `ENOEXEC`，`runCheck` 得到 `code = -1`、无输出、无 `*exec.ExitError`，于是 #2128 的修复分支从不触发。

修复：把 `code <= 0` 拆开——`ENOEXEC` **且** 该 npm 包属于「bin 是 shebang-less 原生二进制 stub」的包（claude、opencode）时算 broken，其余「没跑到退出码」的情况仍然算 unknown。`code == 127`（命令找不到）与 `parseVersion(out) != ""`（能报版本）两个原有 guard 原样保留。

- 分支：`hunt44-c-agent-broken-stub`（worktree `/tmp/magpie-h3`）
- base：`95ef45fda4b3978e94f12954a27d41e5ef1dca85`（upstream/main）
- commit：`d9afa165cff446ab4008417bd1444a05b8bcc7f5`
- patch：`0001-agent-a-Claude-Code-stub-that-cannot-be-exec-d-is-a-.patch`
  sha256 前 16 位：`b2de1911a62b0b0b`（全量 `b2de1911a62b0b0ba3c1528fcc75da0ed25064497ad40b7868334d617fc5eb17`）

## 真实 stub 的取证

`npm pack @anthropic-ai/claude-code@2.1.302` 解出的 `package/bin/claude.exe`：

- 500 字节、`ASCII text`、首字节 `echo "Error: claude native binary not installed." >&2`，无 `#!`
- `package.json` 的 `bin` 指向 `bin/claude.exe`，`optionalDependencies` 里是 `@anthropic-ai/claude-code-<platform>`
- 直接 exec 的结果（本机 darwin/arm64，Go 1.26.8）：

```text
out=""
code=-1 (no ExitError)
err=fork/exec ./claude.exe: exec format error
ENOEXEC=true
```

测试里嵌入的就是这 500 字节的原文（`claudeStub`），不是 `#!/bin/sh` 版本。

## 改动

`internal/agent/cliupdate.go`

- 新增 `stubShims = []string{"@anthropic-ai/claude-code", "opencode-ai"}`（:1030-1035），注释写明这是「bin 是无 shebang 文本 stub、靠 postinstall 拉原生可选包」的包。
- `runsBroken`（:1045）：原来的单行 guard 拆成

```go
if err == nil || ctx.Err() != nil || code == 127 || parseVersion(out) != "" {
    return ""
}
if code <= 0 {
    if errors.Is(err, syscall.ENOEXEC) && contains(stubShims, u.pkg) {
        return "exec format error"
    }
    return ""
}
```

即：`code <= 0` 仍是「没跑到退出码」的总类，只有 `ENOEXEC` + stub 包才升级为 broken；其余仍返回 ""。

`internal/agent/cliupdate_runs_test.go`

- `claudeStub`（:135）：真实 500 字节 stub 原文。
- `TestRunsBrokenSeesAShebanglessStub`（:151）：把 stub 写进临时目录（带执行位、无 shebang），走**真实** `runCheck`（不是 fake），断言 claude 与 opencode 两个包都返回含 `exec format error` 的非空消息；再断言同一文件配 `pkg: "some-other-cli"` 仍返回 ""（负例：不是 stub 包就不能升级为 broken）。

## RED / GREEN

RED（base 产品代码 + 新测试）：

```text
=== RUN   TestRunsBrokenSeesAShebanglessStub
    cliupdate_runs_test.go:159: @anthropic-ai/claude-code: a stub the kernel won't run: "", want it said as broken
    cliupdate_runs_test.go:159: opencode-ai: a stub the kernel won't run: "", want it said as broken
--- FAIL: TestRunsBrokenSeesAShebanglessStub (0.01s)
FAIL	github.com/yetone/magpie/internal/agent	1.051s
```

GREEN（恢复产品改动）：

```text
=== RUN   TestRunsBrokenSeesAShebanglessStub
--- PASS: TestRunsBrokenSeesAShebanglessStub (0.01s)
PASS
ok  	github.com/yetone/magpie/internal/agent	1.032s
```

## Ablation（改动文件备份 → 还原 base → 同断言 RED → 恢复 GREEN）

备份：`/tmp/h3-keep/cliupdate.go`（sha256 `3f9bc056a38d6bac…`）、`/tmp/h3-keep/cliupdate_runs_test.go`。

```text
$ git show upstream/main:internal/agent/cliupdate.go > internal/agent/cliupdate.go
$ go test -tags nogui -count=1 -run TestRunsBrokenSeesAShebanglessStub -v ./internal/agent/
--- FAIL: TestRunsBrokenSeesAShebanglessStub (0.01s)
    cliupdate_runs_test.go:159: @anthropic-ai/claude-code: a stub the kernel won't run: "", want it said as broken
    cliupdate_runs_test.go:159: opencode-ai: a stub the kernel won't run: "", want it said as broken
$ cp /tmp/h3-keep/cliupdate.go internal/agent/cliupdate.go
$ go test ... 
--- PASS: TestRunsBrokenSeesAShebanglessStub (0.01s)
```

## Mutation

A. 把新 exec-error 分支关掉（`if false && errors.Is(...)`）：

```text
--- FAIL: TestRunsBrokenSeesAShebanglessStub (0.01s)
    cliupdate_runs_test.go:159: @anthropic-ai/claude-code: a stub the kernel won't run: "", want it said as broken
    cliupdate_runs_test.go:159: opencode-ai: a stub the kernel won't run: "", want it said as broken
```

（第一次尝试直接删分支，编译报 `"syscall" imported and not used`——这是编译错误，不算 RED，所以改用 `if false &&` 保留 import。）

B. 让新分支也吃 `code == 127`（把 `code == 127` 从 guard 移到 exec 分支里）：

```text
--- FAIL: TestRunsBrokenOnlyWhenSure (1.08s)
    cliupdate_runs_test.go:124: "#!/bin/sh\necho 'env: node: No such file or directory' >&2\nexit 127\n": broken "env: node: No such file or directory", want false
```

即「命令找不到不是 broken」的既有负例仍在守门。

C. 去掉「能报版本就不算 broken」的 guard：

```text
--- FAIL: TestRunsBrokenOnlyWhenSure (1.12s)
    cliupdate_runs_test.go:124: "#!/bin/sh\necho 'tool 1.2.3'\nexit 2\n": broken "tool 1.2.3", want false
```

三次变异后均从 `/tmp/h3-keep` 恢复，`shasum` 回到 `3f9bc056a38d6bac…`。

## 验证矩阵（本机 darwin/arm64，Go 1.26.8）

| 命令 | 结果 |
| --- | --- |
| `go test -tags nogui -count=1 -run 'TestUpdateCLI\|TestRunsBroken\|TestHowInstalled' ./internal/agent/` | ok 3.009s |
| `go test -tags nogui -count=1 ./internal/agent/` | 199.426s，仅 `TestMothX` 红（见下） |
| `go test -race -tags nogui -count=1 -run 'TestRunsBroken\|TestUpdateCLI' ./internal/agent/` | ok 2.923s |
| `gofmt -l internal/agent/` | 空输出 |
| `go vet -tags nogui ./internal/agent/` | exit 0 |
| `GOOS=linux go vet -tags nogui ./internal/agent/` | exit 0 |
| `GOOS=windows go vet -tags nogui ./internal/agent/` | exit 0 |
| `go build -tags nogui ./...`（darwin） | exit 0（仅 internal/gui 的既有 cgo enum 警告） |
| `GOOS=linux go build -tags nogui ./...` | exit 0 |
| `GOOS=windows go build -o /dev/null .` | exit 0 |

`TestMothX` 是环境性的、预先存在的红：本机 PATH 上有真实 `mothx`（`~/.local/state/fnm_multishells/.../bin/mothx`），测试断言「未检测到」被真身破坏。证据：

```text
# base 代码（未含本次改动）
$ go test -run 'TestMothX$' ./internal/agent/      → --- FAIL: TestMothX
# 本次代码 + 把 mothx 移出 PATH
$ PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin /usr/local/go/bin/go test -run 'TestMothX$' ./internal/agent/
ok  	github.com/yetone/magpie/internal/agent	1.295s
```

## Siblings 调查（哪些 CLI 的 bin 可能是 shebang-less stub）

用 `npm view <pkg> bin` + `npm pack` 逐个看了 `cliSpecs` 里的 npm 包（2026-10-18 版本）：

| 包 | bin | 形态 | 受影响 |
| --- | --- | --- | --- |
| `@anthropic-ai/claude-code` | `bin/claude.exe` | 500B 无 shebang 文本 stub | **是** |
| `opencode-ai` | `bin/opencode.exe` | 479B 无 shebang 文本 stub | **是** |
| `@openai/codex` | `bin/codex.js` | `#!/usr/bin/env node` | 否 |
| `@deveco/deveco-code` | `bin/deveco` | `#!/usr/bin/env node` | 否 |
| `@oh-my-pi/pi-coding-agent` | `dist/cli.js` | `#!/usr/bin/env bun` | 否 |
| `omo-ai` | `bin/omo.js` | `#!/usr/bin/env node` | 否 |
| `@google/gemini-cli` | `bundle/gemini.js` | `#!` 脚本 | 否 |
| `@earendil-works/pi-coding-agent` / `@mariozechner/pi-coding-agent` | `dist/**/cli.js` | `#!` 脚本 | 否 |
| `@github/copilot` | `npm-loader.js` | `#!` 脚本 | 否 |
| `@charmland/crush` | `run-crush.js` | `#!` 脚本 | 否 |
| `cline` | `bin/cline` | `#!/usr/bin/env node` | 否 |
| `@deepseek-ai/dsh` | `lib/bin.js` | `#!/usr/bin/env node` | 否 |
| `@tencent-ai/codebuddy-code` | `./bin/codebuddy` | `#!/usr/bin/env node` | 否 |
| `@atomgit.com/atomcode` | `bin/atomcode.js` | `#!/usr/bin/env node` | 否 |
| `snow-ai` | `bundle/cli.mjs` | `#!` 脚本 | 否 |
| `mothx-installer` | `bin/mothx` | `#!/usr/bin/env node` | 否 |

所以只把 claude 与 opencode 放进 `stubShims`，其余未改。

为什么不在 claude 之外无条件把 `ENOEXEC` 当 broken：`TestGrokInstalled` 等既有测试用 `MZ` 这种不可执行的文本文件当原生二进制替身，无条件判断会误伤（本机实测：裸 `ENOEXEC` 版本让 `TestGrokInstalled` 变红）。用包名白名单同时守住「非 stub 包不升级」的语义。

## 未验证 / 不确定

- **没有在本机端到端复现一次真实的 npm 更新坏掉**（真去装 `@anthropic-ai/claude-code` 再断网丢可选包）。stub 的字节形状取自 `npm pack` 的真实产物，exec 行为用真实 `runCheck` 路径验证，但「npm 更新→UpdateCLI 自动修复」这条完整链路只由既有 `TestUpdateCLIChecksItRuns` 覆盖（它用的是 `#!/bin/sh` stub，本次没有改它）。
- **Windows 未实测**：`TestRunsBrokenSeesAShebanglessStub` 在 Windows 跳过。Windows 上 `syscall.ENOEXEC` 的值与 Unix 不同（`APPLICATION_ERROR + n`，不等于 Win32 的 `ERROR_BAD_EXE_FORMAT = 193`），因此该分支在 Windows 上基本不会触发——但 Windows 的 npm shim 用 `cmd.exe` 跑 `.exe`，本来也不会走 `ENOEXEC` 这条路。只做了 `GOOS=windows go vet/build`。
- `stubShims` 是包名硬编码；如果将来某个 CLI 也改成 shebang-less stub，需要加进去（注释里已写明这一约定）。
- 全量包测试 199s 内只跑了 `./internal/agent/`，未跑整个仓库 `./...`（按任务给定的矩阵执行）。
