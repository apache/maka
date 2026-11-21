# #3049 proc: TestAskShellProfileExecsOrHangs fails under load — 完成记录

- 分支 `hunt53-e-proc-shellask`，审计 base `318697dc`（=upstream/main），commit `2edbff0a`（单文件 `internal/proc/path_other_test.go`，+12/-3，test-only）。
- patch：`0001-proc-the-shell-ask-test-asks-with-production-s-budge.patch`，SHA-256 前 16 `5afe342a7271b9b1`。
- 帖草稿：`issue-body.md`（已核：内嵌 patch 与 format-patch 逐字节一致；零中文；围栏配对；GLM 仅在 patch 内 Generated-by）。

## 假设与证据

1. **第二次 ask 预算独立、不共享**：`askShell` 循环 `["-ilc","-lc"]` 各调一次 `askShellAs`，每次新建 `context.WithTimeout(context.Background(), shellAsk)`（`internal/proc/path_other.go:366`）。引入提交 `cc8eb5a7`（2026-10-10）message 明说 "with the same 5s limit"，有意设计。
2. **负载红机制**：测试把预算压到 1s（原 `path_other_test.go:461`）；每 case ask1 按设计挂满（`exec /bin/cat` 在 `Stdin=nil` 下立即 EOF 无输出、`sleep 4` 超 1s 预算被杀），ask2 拿自己的 1s——load ~440 下 spawn（sh fixture → `/bin/sh -c printf`）到打印超 1s，也超时 → `parseShellEnv` 返回 `("", nil)` → Fatalf。issue 的 `(2.16s)` ≈ exec case 两次完整 1s 超时（slow case 未跑），吻合。
3. **修法落点**：测试侧。维护者「用户拿不到 login PATH」对应产品 5s 边界（cc8eb5a7 已接受并有兜底：UserPath 的 `shellWait=2s` 后台答案晚到仍采纳、LoginPath 一分钟重问、termShells 并发问）；产品 5s 默认无依据可改，不动。

## RED / GREEN / 消融

- **RED（注入）**：base 上 fixture login 路径注入 `-l*) sleep 2`、预算保持 1s：
  `path_other_test.go:473: exec: PATH = "", vars false: the login shell wasn't asked again`（`--- FAIL ... (1.73s)`）。
- **GREEN**：预算 `5 * time.Second`（=生产默认）+ interactive `sleep 4`→`sleep 6`（保持慢于预算语义）+ 注入 sleep 2 保留为永久确定性延迟测试：`--- PASS (9.89s)`。
- **消融**：`git diff --name-status upstream/main` 仅 `internal/proc/path_other_test.go`（产品零 diff）。预算还原 1s、注入保留 → `path_other_test.go:482: exec: PATH = "", vars false: the login shell wasn't asked again`；恢复 5s → `ok 9.962s`。

## Watched 三查

(a) 打破修复核心：把 `askShellAs` 临时改成共享单一 ctx（实验，已还原）→ `path_other_test.go:482: slow: PATH = "", vars false: ...`（slow case 必红：ask1 挂满共享 5s，ask2 拿已死的 ctx）→ 新测试锁住「每次 ask 独立预算」的产品属性 → 还原复绿 `ok 10.019s`。
(b) `rg -n 'askShell|shellAsk' internal/ --type go`：产品调用方 `shellEnv`(path_other.go:227)、`ShellPath`(:379) 行为不变不改；Windows 兄弟 `path_windows.go` 读注册表不经 askShell 不改；`TestAskShellRealFishAutostart`(:498, 2s) 有 fish skip 守卫、维护者未点名，不顺带改。
(c) 超时兜底：两次 ask 都超时 → `("", nil)`；UserPath 2s 后继续（静态 userDirs 保留、晚到答案仍采纳）、LoginPath 返回 nil（调用方按 not found 折叠）+ 一分钟后重问；LoginEnv 对 nil vars 读安全返回 ""。修后产品行为零变化。

## 矩阵

| 项 | 命令 | 结果 |
| --- | --- | --- |
| 定向稳定性 | `-run TestAskShellProfileExecsOrHangs -count=5` | 5/5 PASS（9.0–9.7s） |
| 全包 | `go test ./internal/proc/... -count=1 -timeout 15m`（proc-full.log） | ok 12.819s |
| 负载模拟 | `yes`×4 + `-count=20 -parallel 1` | 20/20 PASS；1-min load ~7（issue 的 ~440 本机未复现） |
| race | `-race` 定向 | ok 11.425s |
| gofmt | `gofmt -l internal/proc` | 空（中途修过一处 `} {` 缩进） |
| vet | `go vet ./internal/proc` | clean |
| build | darwin/arm64；linux/amd64 `-tags nogui`；windows/amd64 | 三者 ok（darwin 仅预存 ld warning） |

## 不确定项

- load ~440 真机未复现（本机峰值 1-min load ~7）；注入延迟是机制的确定性证明，负载红与注入红是同一断言、同一超时路径。
- gofmt 缩进修正发生在全包后台运行的窗口内（纯空白改动）；修后由负载模拟 20 连跑覆盖验证。
- commit message 内嵌了消融 FAIL 原文（行号 482），与 patch 后文件行号一致。

## 产物

- `commit-msg.txt`、`0001-*.patch`、`issue-body.md`、`proc-full.log`、本文件。
- 未 push、未发帖、未碰主 clone、未动其他 /tmp/magpie-h*。
