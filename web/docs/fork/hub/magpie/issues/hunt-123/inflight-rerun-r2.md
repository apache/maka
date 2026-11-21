# hunt-123 R2 车道补跑台账（RERUN-PENDING → 复跑，2026-11-05）

> 车道：R2（#4972-#5111 列表内 17 支）；冻结 tip `2488532257daeb79605567d44898925bf47942f2`；worktree `C:\Users\802165\AppData\Local\Temp\r123-rr-r2`；GOCACHE `%TEMP%\r123-rr-r2-gocache`。
> 平台：Windows（win32, go1.26.5）——POSIX-only harness（`testenv.Program` 写 `#!/bin/sh` 脚本、`runtime.GOOS=="windows"` 硬 SKIP）的定向测试本机不可实跑；WSL 无发行版、Docker daemon 不在，无 Linux 执行面。
> 消融口径：产品面回退、测试保留；产品文件父提交 blob 撞 tip 漂移（编译即断）时，改做**等价外科回退**（只回退该 fix 的产品改动块），效果同"基线=父提交"。

| 单号 | 定向命令 | 消融红 | 复绿 | 判定 |
| --- | --- | --- | --- | --- |
| #4972 | `go test -tags nogui -run 'TestPlainItemIDsOpaqueKinds\|TestCopilotTakesAnotherVendorsOverlongItemIDs' ./internal/gateway/` | 红：boundItemID 前缀推导回退为裸 digest（外科）→ `TestPlainItemIDsOpaqueKinds` 各 kind "lacks its kind's prefix"，整包 FAIL | 恢复后 ok（2.3s） | **RERUN-OK** |
| #4978 | `go test -tags nogui -run 'TestClaudeTUISafeguardsOverOneEnvEntryRefused' ./internal/gateway/` | 不可判红：定向测试在 Windows 被 harness 硬 SKIP（"a shell script stands in for Claude Code"，claude_tui_extra_body_test.go:93）；`--- SKIP`，无红→绿可跑 | （SKIP，无从复绿） | **RERUN-BLOCKED（平台）**——详见备注 1 |
| #4980 | `go test -tags nogui -run 'TestRescanAsksLatestAgain\|TestRescanLooksAgain' ./internal/agent/` | 红：`latests.forgetAll()` 调用回退（外科）→ `rescan_test.go:106: after the refresh npm was asked 1 times, not once more`（与帖逐字同） | 恢复后 ok | **RERUN-OK** |
| #5006 | `go test -tags nogui -run 'TestRateLimitIsNotQuota' ./internal/gateway/` | 红：routing.go credit case 去掉 `!minuteRate(body)` 门 + minuteRate 回退 minuteLimit（外科）→ `ratewords_test.go:34: ...insufficient_quota...: credit, want rate`（与帖声称逐字同） | 恢复后 ok | **RERUN-OK** |
| #5012 | `go test -tags nogui -run 'TestTapTellsLimits\|TestTapLimitsUnsaid' ./internal/claudetui/` | 红：limitsInfo 置恒 nil（作者自述同款 `&& false` 手工打断）→ TestTapTellsLimits "told []" + TestTapLimitsUnsaid "a refusal told map[]" | 恢复后 ok | **RERUN-OK** |
| #5020 | `go test -tags nogui -run 'TestWorkBuddyCheckinDarkWakeFailsNotStacked\|TestWorkBuddyCheckinOfflineRetriesSoon' ./internal/provider/` | 红：checkin.go 回父提交 blob（该文件无 tip 漂移，编译过）→ `workbuddy_checkin_test.go:330: DarkWake at 07:51: [...Tries:1...], want the day's first offline try` | 恢复后 ok（TestWorkBuddyCheckinOfflineRetriesSoon 两态均绿，同帖） | **RERUN-OK** |
| #5024 | `go test -tags nogui -run 'TestCodexListedLevelsSayDescription' ./internal/codexcat/` | 红：codexcat.go 回父提交 blob → `relay/glm-5.3: level high says description "", want "High"` 等 3 行 | 恢复后 ok | **RERUN-OK** |
| #5064 | `go test -tags nogui -run 'TestOpenCode2sConfigPutsNoV1ProviderBack\|TestOpenChamberProvidersKeptCurrent\|TestOpenCodeProvidersKeptCurrent' ./internal/agent/` | 红：agents.go/openchamber.go/opencode_providers.go 回父提交 blob → v1 provider.magpie 被放回（"the v1 provider.magpie put back" 面），TestOpenCode2sConfigPutsNoV1ProviderBack/TestOpenChamberProvidersKeptCurrent FAIL | 恢复后 ok | **RERUN-OK** |
| #5065 | `go test -tags nogui -run 'TestOmpRemoteCompaction\|TestOmpTriggerUncarriedIsAnError' ./internal/agent/ ./internal/gateway/` | 红（两侧）：omp.go 的 ompKept 不再写块 → agent 侧 `native compaction on: map[]`；gateway.go 的 omp 错误分支回退 → gateway 侧照答 `magpie1:` compaction item（与帖声称红同） | 恢复后两包 ok | **RERUN-OK** |
| #5067 | （未跑） | （未跑） | （未跑） | **REWORK-CONFLICT**——详见备注 2 |
| #5082 | `go test -tags nogui -run 'TestSilentlyIgnoredFormatToldInWords\|TestRefusedFormatToldInWords' ./internal/gateway/` | 红：passthrough 的 else 分支（formatToldInBody）回退（外科）→ 三子测试全 "format not told in words" | 恢复后 ok | **RERUN-OK** |
| #5083 | `go test -run 'TestProviderSaveKeepsWhatItLeavesOut' ./internal/gui/`（gui 包无 tag 实跑） | 红：providers.go 的 headers-keep 块回退（外科）→ user/preset 两子测试 "left out, not kept: ... headers map[]" | 恢复后 ok | **RERUN-OK** |
| #5084 | `go test -tags nogui -run 'TestTapTellsReplyLimits\|TestTapLimitsOfMessageToldWhole\|TestTapErrorLimitsLast\|TestShimTellsTapLimits\|TestTapKeptLimitsNotAfterNewer' ./internal/claudetui/` | 红：rateLimitInfo 置恒 nil（外科）→ 5/5 全 FAIL（含 shim 面实跑 30.12s） | 恢复后 ok | **RERUN-OK** |
| #5086 | `go test -tags nogui -run 'TestCodexCatalogAcrossHomes' ./internal/agent/`（双提交 2c4343397+aaeb9f4dd 均 cherry-pick） | 红：catalogRef/deskRef 回父提交的相对拼写（外科，含 runtime import 还原）→ provider/desktop 两子测试 "catalog ... cannot be read from a private CODEX_HOME"（与帖逐字同） | 恢复后 ok | **RERUN-OK** |
| #5100 | `go test -tags nogui -run 'TestClaudeDriftOwnSessions' ./internal/agent/`；`-run 'TestWarmClaudeSaysItsOwnSession\|TestClaudeHelperSessionIsMagpiesOwn\|TestClaudeBridgeSessionIsMagpiesOwn' ./internal/gateway/` | 红：usage.IsOwnSession 置恒 false（外科）→ TestClaudeDriftOwnSessions "Claude Code was used at ... but none of its requests reached magpie" + TestClaudeHelperSessionIsMagpiesOwn "the helper's session is not kept as magpie's own" | 恢复后两包 ok | **RERUN-OK（部分）**——4 支定向测试中 2 支（TestWarmClaudeSaysItsOwnSession、TestClaudeBridgeSessionIsMagpiesOwn）Windows 硬 SKIP（POSIX harness），2 支实跑红→绿 |
| #5101 | `go test -tags nogui -run 'TestGroupIntentSure' ./internal/gateway/`（5 支族） | 红：sureNeeded 置恒 jevSure 0.4（组自设 sure 忽略）→ Threshold / ZeroTakesTheArgmax / IsPerGroup 三支 FAIL（语义核心面）；Range 两态均绿（其 SaveGroup 报错来自不存在 classifier，与 range 校验无关）、LeavesLevels 两态均绿（levels 面本就不改） | 恢复后 ok | **RERUN-OK** |
| #5111 | `go test -tags nogui -run 'TestChineseNotTooLong\|TestOutOfBudgetIsntRetriedInPlace\|TestOwnQuotaRest' ./internal/gateway/` | 红：usedUpWords 回 `budget (exceeded\|exhausted)` 相邻二元组（外科）→ 4 行 FAIL，JSON 信封与裸句两 body 均 "is a rate failure"/"is asked again in place"（与帖"红 4 行"逐字同） | 恢复后 ok | **RERUN-OK** |

## 备注

1. **#4978 平台受阻**：其唯一新测试 `TestClaudeTUISafeguardsOverOneEnvEntryRefused` 依赖 `tuiScriptHarness`→`testenv.Program` 写 `#!/bin/sh` 替身进程，测试及其 harness 全家族对 `runtime.GOOS=="windows"` 硬 `t.Skip`；本机 win32 实跑输出 `--- SKIP`。guard 逻辑本身平台无关（长度判在 exec 前），但红→绿在本机无法实证。同族父提交 blob 消融也不可用（父版 claude_subscription.go 缺 tip 的 `cutReply`，编译即断，非测试红）。**建议**：该单交由 POSIX 车道（macOS/Linux）补跑，或以本行为准记平台受限。
2. **#5067 REWORK-CONFLICT**：`git cherry-pick b39eb4f0c` 在 `internal/gateway/codex_backend.go` 内容冲突（非空合并，重试复核同果）。冲突根因：冻结 tip 已落 #5275（compactWithin 迟到摘要块 `late()`/`lateSummary()`），与 #5067 改的同一 `if first := rec.status; ...` 条件行及 text-fallback/`ask(r, plainCompact(body))` 三处同区相撞。与总表所记 merge-tree AM-OK 不符（该 merge-tree 早于 tip 漂移窗口）。需作者 rebase（把 systemRefused 分支并到 #5275 之后的阶梯上）。

## 总账

**RERUN-OK 15 / REWORK-CONFLICT 1 / RERUN-BLOCKED(平台) 1（合 17）**。worktree `r123-rr-r2` 已 `worktree remove --force` 删净（`Test-Path` = False），GOCACHE `%TEMP%\r123-rr-r2-gocache` 保留供其他车道复用。零 issue 评论、零帖修改、零 push、未触碰 journal/ 与总表 inflight-recheck-2026-11-05.md。
