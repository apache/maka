# hunt67 Lane C — #3095 验证证据索引（worktree: magpie-hunt67-c, 分支 hunt67/c）

基线: origin/main = be002aca050f01fce83f58728961614d3b987a63（开工时 fetch 复核一致；会话中途 origin/main 前进到 da6fd87edeb08bf56e90e1c0fc1cce68a4ce4e9a，已二次 fetch 复核）。
环境: Windows/amd64, Go 1.26.8, CGO_ENABLED=1（-race 可用），GOPATH/GOMODCACHE/GOCACHE 固定为 go env 默认值，GOTOOLCHAIN=auto。

## 文件清单
- issue-body.json / issue-comments.json — gh api 拉取的正文与全部评论（开工 c=2，发稿前终复 c=2，state=open）
- skygunner-665af242.txt — `git show --format=fuller 665af242` 全文（Author: vincent <webmaster@palmit.com.au>；消息体含 "Adapt ggbdpq/magpie de90e3ea…"；trailer 逐字 `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`）
- 665af242.patch — `git format-patch -1 665af242 --stdout`
- hold_test.fixed.after-cherry-pick.go — cherry-pick 后（修复版）hold_test.go 备份
- red-ablation-no-fix-injected.log — RED ①
- red-settings-sibling-injected-base.log — RED ②
- red-holdbuildsonce-count5-base.log — RED ③
- green-fixed-injected.log — GREEN ①
- green-holdbuildsonce-count20-fixed.log — GREEN ③
- green-four-tests-race-count3.log — 竞争矩阵
- green-full-package.log — 全包（含预存失败，见下）
- base-codex-isolated.log — 基线 detach 对照（预存失败定性）

## 命令与退出码（cwd=worktree；go 命令均带上述环境前缀）

| # | 命令 | exit | 摘录 |
|---|---|---|---|
| 0 | `go test ./internal/provider -run TestHoldReadsMigrationsOnce -count=1`（cherry-pick 后裸跑） | 0 | ok 0.847s |
| R1 | 基线 hold_test.go + 注入 `time.Sleep(1200*time.Millisecond)` 于两次读之间 → `go test ./internal/provider -run TestHoldReadsMigrationsOnce -count=3 -cpu=1,8 -v` | 1 | 6/6 FAIL，每次 1.23s，`hold_test.go:317: migrations.json read again while held`（注入行把 :316 顶到 :317，同一断言） |
| G1 | cherry-pick 修复版 + 同一注入 → 同命令 | 0 | 6/6 PASS，每次 ~1.24s（停顿在跑、小时 hold 不过期） |
| R2 | 基线 + 同注入（TestHoldReadsSettingsOnce 两次读之间）→ `-run '^TestHoldReadsSettingsOnce$' -count=2 -v` | 1 | 2/2 FAIL，`hold_test.go:182: settings.json read again while held` |
| R3 | 基线（无注入）→ `-run '^TestHoldBuildsOnce$' -count=5 -v` | 1 | 1 PASS + 4 FAIL：`hold_test.go:34: held: built 2 times, want 3` → 此后 `hold_test.go:28: not held: built 0 times, want 2`（Fatal 泄漏 hold 毒化后续重复）——基线预存的 -count 敏感 |
| G3 | 修复版 → `-run '^TestHoldBuildsOnce$' -count=20 -v` | 0 | 20/20 PASS |
| M1 | `-run '^(TestHoldBuildsOnce|TestHoldReadsSettingsOnce|TestHoldBuildsProvidersOnce|TestHoldReadsMigrationsOnce)$' -count=3 -race -v` | 0 | 12/12 PASS，无 DATA RACE |
| F1 | `go test ./internal/provider/... -count=1 -timeout 20m` | 1 | 9 个失败全在 codex keychain/list-tag；hold 四测试过 |
| F2 | `git checkout --detach be002aca` → `-run '^(TestCodexListTagKeptWhileNothingChanged\|TestCodexSignedInInKeychain\|TestSavedButSignedOut)$' -count=1` | 1 | 3/3 同样 FAIL → F1 失败为基线预存（Windows keyring 环境），与本补丁无关；已切回 hunt67/c |
| L1 | `gofmt -l internal/provider/` | 0 | 空 |
| L2 | `go vet ./internal/provider/...` | 0 | 干净 |
| D1 | `git apply --3way --check 665af242.patch`（工作树 hold_test.go=be002aca 版） | 0 | "Applied patch to 'internal/provider/hold_test.go' cleanly."（已还原工作树） |
| D2 | `git ls-tree origin/main -- internal/provider/hold_test.go`（origin/main=da6fd87e） | — | blob 仍为 6b5c415e → 最新 main 同样可落 |
| D3 | `git merge-base --is-ancestor 665af242 4671590d` | 0 | 批量分支头 4671590d 含补丁；其 hold_test.go blob=790283ef（补丁后） |

## 谱系
- 665af242 父提交 a0b3c8f6；与 be002aca 的 merge-base=7aad6a50；其支线领先 51 提交、我方主线领先 19 提交（非快进关系，落地靠 cherry-pick/PR）。
- cherry-pick 本地落在 hunt67/c = eb64720c（保留作证据，未推送）。

## 兄弟面（heldFor 测试消费方，修复树 eb64720c 现状）
- 本补丁新抬 TTL：hold_test.go:24-25（TestHoldBuildsOnce，另加 Changed() 清 held）、:174-175（TestHoldReadsSettingsOnce）、:232-233（TestHoldBuildsProvidersOnce）、:315-316（TestHoldReadsMigrationsOnce）——均 time.Hour。
- 原有已抬：hold_test.go:59-60、:98-99（Minute）；group_held_test.go:289-290（Hour）。
- 有意不抬：entries_kept_test.go:24（heldFor=0，测的正是过期）；hold_test.go:402+ TestAllReadsNoSettingsPerLookWhileHeld（预算显式容忍一次重建，"the held catalog is kept 1s"——生产 heldFor 若改值此处注释/预算会漂）；TestHoldSeesWrites / TestHeldGoesWithAPluginChange / TestHeldGroupsAreTheCallers（断言欢迎重建）；TestCursorKeychainReadOnce（自有 memo）。
- 生产消费点：hold.go:109（var heldFor = time.Second）、:134（release 清扫）、:190 与 :316（heldOf/entries 复用判定）——补丁未触碰。

## 未跑/未做（如实）
- 未复现真实负载（load 25–57）；回红全部用 1.2s 注入（确定性机理代理），未跑 yes 类加压。
- 未交叉编译（darwin/linux/windows 构建矩阵未做，其帖声称三平台构建过）。
- TestHoldBuildsProvidersOnce 未独立注入回红（仅修复版 GREEN + 其帖声称）。
- 未整仓 go test ./...（禁令）；其余包未动。
