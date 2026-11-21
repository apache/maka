# #3174 处理报告（hunt57-a-claude-models-race）

日期：2026-10-21。worktree：`/tmp/magpie-h82`，base `f5b01574` = upstream/main。

## 结果

- **head SHA**：`128cd9371f67337c5abf4a2f2f270211a3111fc3`（分支 `hunt57-a-claude-models-race`，1 个提交，+6 行，纯测试侧）。
- **patch**：`0001-provider-claudeSignIn-drops-the-credential-cache-it-.patch`，SHA-256 前 16 = `6fabf660ee533745`。
- **英文帖**：`issue-body.md`（五段 + 严格尾部模板，零中文，未发布）。
- 未 push、未发评论、主 clone 未动、无 stash。

## 假设与污染链（证据）

**假设**：`claudeCredential`（internal/provider/account.go:578）是**全局单槽缓存**（`claudeCacheC/claudeCacheOK/claudeCacheAt`），只按年龄服务（`claudeCacheTTL` 10s，:359；新鲜即服务 :593）。受害测试的时序窗口 = 自己 `claudeHome`（isolate→`forgetClaudeCredential`，account.go:608）之后、`claudeSignIn`（account_test.go:252）写凭据之前。**任何**在这几毫秒窗口内读凭据的前一测试遗留运行（goroutine），在还没写入的 HOME 上读到 `ok=false` 并连同时间戳写入缓存（:596-597）；随后测试自己的读取在 TTL 内命中这份 miss → `claudeAccount`（account.go:745）→ `claudeStandInAccount`（claude_dirs.go:384）→ `claudeListed`（claude_dirs.go:316）在临时 logins.json（空）找不到账号 → 不建 provider → `find(All(), "claude")` 返回 false → :52 红。**验证**：诊断 goroutine 按此窗口投毒，得到与维护者逐字相同的失败（含 0.00s）；对照无投毒则绿。

**对维护者两个候选的定性**：均为时序促成而非根因。`1bd99194e` 新增的 `TestClaudeAllSignedOutStaysListed` 按文件序紧贴在受害测试之前（且其测试中途删除凭据也以缓存 miss 结尾——但会被下一测试的 `claudeHome` forget，不跨界），改变了 flake 所乘的调度；`c087834d6` 只改了拿锁时机。两者都不会有状态穿过受害测试自己的 `claudeHome`；真正穿越边界的是窗口内写入缓存的那份 miss。哪条具体遗留运行落进了维护者那次窗口**未能定位**（见"不确定项"）。

## RED（断言级）

自然复现：全包 3 次（含 1 次加 6 路 yes 负载）未红——与 issue「went red once」一致；本机另有其他会话的 gateway 套件提供真实负载。**钉死组合**：一次性诊断测试 `TestHunt3174Straggler`（`aa_` 前缀文件，紧密循环调 `claudeCredential()` 模拟遗留运行，已删）+ `TestClaudeAccountServesModelsListedSinceItsFetch`，在 2 路 yes 负载下红：

```
--- FAIL: TestClaudeAccountServesModelsListedSinceItsFetch (0.09s)
    claude_models_test.go:52: claude: {ID: Name: ... Account:<nil>} false
```

全文见 `red-combo-full.log`（结构体省略同 issue 写法）。机制证明（窗口内同步投毒→同文失败→对照组绿）在会话记录中。

## GREEN

修 `claudeSignIn`：写完凭据后 `forgetClaudeCredential()`——「测试写下的凭据就是读取所服务的」成为 helper 不变量。同组合修复后绿 ×8（含负载下、count=3 多次）；全包 `-count=1 -timeout 45m` ok 74.044s（`provider-full-green.log`）。

## 消融

`git checkout -- account_test.go` 还原修复 → 同组合**第 1 试即红**（`ablation-red.log`，:52 同文）→ `git apply` 恢复修复 → 组合 ×4 各 count=3 全绿。

## Watched 三查

- **(a) 打破**：即消融（打破=删掉 forget），红→还原绿。
- **(b) 同 helper 清单**：`rg -ln 'claudeSignIn'` ≈40 个文件全部由 helper 一处修复覆盖；绕过 helper 的凭据写入者无同形缺口——`saveClaudeCredential` 写时即缓存新值（account.go:600），手写文件的 `TestClaudeUsageUnavailableAfterAccountSwitch` 已自带 `forgetClaudeCredential()`（claude_usage_fallback_test.go:224）。无可顺手补项，无 Left。
- **(c) 清理顺序/异常路径**：forget 是 helper 路径上的普通同步调用，非 `t.Cleanup`，断言失败前必已执行，不注册任何清理，无 LIFO 顺序问题。

## 矩阵

| 项 | 结果 |
|---|---|
| 触发组合 count=3（锤子在场） | ok ×8（修复后） |
| 全包 `-count=1 -timeout 45m` | ok 74.044s |
| `-run Claude -count=5` | ok 65.849s（run-claude-count5.log） |
| `gofmt -l`（改动文件） | 空 |
| `go vet` darwin / linux `-tags nogui` / windows（provider 包） | 全过 |
| `go build ./...` darwin/arm64、linux/amd64 `-tags nogui`、windows/amd64 | 全过（仅预存 cgo/链接警告） |

## 不确定项

1. **真实的遗留 goroutine 未定位**：候选类别已列（#1802 的 `endClaudeSignIns`/`claudeLogins` 机制、signin 流、usage 读取等），但未在自然运行中当场抓到；钉死组合用的是替身读取器，已如实写进英文帖 Not verified。
2. **负载下自然全包红未在本机复现**（3 试全绿）；issue 的红发生在其他会话套件负载下。
3. 一次加 6 路负载的全包跑（`provider-full-loaded.log`）出现 20 个无关失败——当时锤子诊断文件还在包内，属**诊断自污染**，不可作证据（报告在此声明，避免误导）。
4. 修复选择 helper 侧（写后清缓存）而非等待定位具体污染测试：证据只支持「窗口内任何读取都致红」，helper 是该测试家族的共享根；产品代码零改动。

## 产物清单

`/Users/ggbdpq/cc/guahub/fork/magpie-hub/docs/issues/hunt57/3174-claude-models-race/`
- `0001-provider-claudeSignIn-drops-the-credential-cache-it-.patch`（format-patch）
- `issue-body.md`（英文帖草稿）
- `red-combo-full.log`、`ablation-red.log`（RED/消融原文）
- `provider-full-baseline.log`（修复前全包绿，74.108s）、`provider-full-green.log`（修复后 74.044s）、`provider-full-count2.log`、`provider-full-loaded.log`（污染，仅存档）、`run-claude-count5.log`
