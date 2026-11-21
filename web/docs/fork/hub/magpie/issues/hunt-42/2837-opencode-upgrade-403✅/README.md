# #2837 opencode 自更新 403：Agent 页更新被 GitHub 未认证限流挡住

## 状态

- **issue 已发**：https://github.com/yetone/magpie/issues/2837 （2026-10-18，OPEN）
- **patch 已作为评论发出**：https://github.com/yetone/magpie/issues/2837#issuecomment-6250304231 （2026-10-18，英文，含 `git am` patch、证据尾部、署名请求）
- **分支已推**：`fix/2837-opencode-upgrade` → https://github.com/ggbdpq/magpie/tree/fix/2837-opencode-upgrade
- **commit**：`68d29137e43c7108730e16edc7f5c1c8414f2b07`，作者 `ggbdpq <ggbdpq@gmail.com>`，尾注 `Generated-by: deepseek-flash (DeepSeek Harness)`
- **base**：`upstream/main` `d783df46cbac9021e26a6bd71ca0b55544552eb2`（发帖前重 fetch 确认未动）
- **patch sha256**：`c5a803b17a0fc9c0f302d4c6b1b02693f65a2b9ddda9b182453b3e106335c136`
- **未开 PR（有意）**：10-08 之后新开的 PR 无一合入（open PR 全部停在 10-07/10-08），维护者现行合入链路是 issue 内 `git am`；同题 patch 不重复投两处。用户若坚持要 PR，`gh pr create --head fix/2837-opencode-upgrade` 即可。
- 主 clone `magpie/` 已还原干净，改动只在 `magpie-pr2` 的分支上。

## 现场

macOS arm64，Magpie 0.1.1285，Agents 页「全部更新」5 个 Agent：4 个更新成功，opencode 失败。行内日志：

```
opencode upgrade: ● Using method: curl · Error: Unexpected error · StatusCode: non 2xx status code (403 GET https://api.github.com/repos/anomalyco/opencode/releases/latest)
```

本机 opencode 为 1.19.0（`~/.opencode/bin/opencode --version`，installer 装法，即 magpie 的 `self` 更新器：`[bin, "upgrade"]`）。

## 根因

opencode 1.19.0 的 `Installation.latest(method)` 按装法取最新版：

| method | 来源 |
| --- | --- |
| brew | `brew info` / formulae.brew.sh |
| npm/bun/pnpm | npm registry `opencode-ai/<tag>` |
| choco/scoop | 各自 registry |
| **其余（curl）** | `GET https://api.github.com/repos/anomalyco/opencode/releases/latest`，**不带 token** |

该请求吃本机 IP 未认证的 60 次/小时额度（与同网络其它 GitHub 客户端共享），用完后 403，更新在进入 installer 前就失败。1.19.3 已把该分支改成 npm registry，但用户必须先更新到 1.19.3——正是失败的那一步。

opencode 的 `upgrade [target]` 接受版本：`let C = D.target ? D.target.replace(/^v/,"") : await Cu.latest(F)`，给了 target 就不发那次 API 请求，installer 直接按 `releases/download/v<version>` 下载。magpie 本来就知道这个版本（行里显示的 `latest`，来自 npm `opencode-ai`），但 `howInstalled` 给的是不带版本的 `opencode upgrade`。

## 修法（commit 68d29137）

- `cliSpec` 加 `target bool`：其自带更新器接受目标版本。
- `"opencode"` spec 置 `target: true`。
- `UpdateCLI` 运行前：`if spec.target { if v := latestVersion(u); Newer(v, before) { u.cmd = append(u.cmd, v) } }` —— 即 `opencode upgrade 1.19.3`。
- `Newer` 防 npm 旧答案造成降级；npm 查不到或并不更新时不追加，保持今天的行为。
- 行上显示的 `Command`/`Update` 不变（版本只在真正执行时追加）。

## 验证（在分支 head 重跑）

- 红（去掉 `UpdateCLI` 追加块、保留新测试）：

  ```
  --- FAIL: TestUpdateCLIOpenCodeTakesVersion (0.81s)
      cliupdate_test.go:411: ran [["…/bin/opencode" "upgrade"]]
  ```

- 绿（临时 HOME + GOCACHE）：

  ```
  go test -tags nogui ./internal/agent -run 'TestUpdateCLIOpenCodeTakesVersion|TestUpdateCLI$|TestHowInstalled$'
  ok  github.com/yetone/magpie/internal/agent  1.808s
  ```

- `gofmt -l` 两文件无输出；`go vet -tags nogui ./internal/agent`、`GOOS=linux go vet -tags nogui ./internal/agent`、`GOOS=windows go vet -tags nogui ./internal/agent` 全清。
- `go build ./...`、`GOOS=linux go build -tags nogui ./...`、`GOOS=windows go build ./...` 全 ok。

## 未做 / 已知

- 未跑 `go test -tags nogui ./...`。`./internal/agent` 整包唯一红是 **`TestMothX`**：本机 PATH 上有真 `mothx`（`which mothx`），`Detected()` 因此为真，属测试读真机，与本改动无关（可另立一单）。
- 没有在限额再次用尽时做修复版的端到端点击验证；失败路径是从本机 1.19.0 bundle 读出来并逐字引用的。
- 兄弟面：其它 6 个 `self` 更新器（claude/codex/deveco/grok/omp/omo）未确认接受版本参数，未改；npm/bun/pnpm/brew 走 registry/formula，不经 GitHub API。

## 相关外部事实

- 本机 API 额度用尽时实测 `curl https://api.github.com/repos/sst/opencode/releases/latest` → `403 {"message":"API rate limit exceeded for 203.175.14.58…"}`；一小时后恢复 200。
- opencode 自身也有同类报告（其 upgrade 不读 GITHUB_TOKEN）：anomalyco/opencode#23461、#36260（1.19.3 改走 npm 只是绕开 curl 分支）。
