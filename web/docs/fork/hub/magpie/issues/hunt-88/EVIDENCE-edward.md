# Issue #2718 community patch verification

## Base and patch

- Worktree: `C:\Users\16382\Documents\ChatGPT\magpie\worktrees\verify-2718-latest-20261026`
- Original verification base: `3b717d5e0d62a73af365a84ace0eed295809918a`.
- Final rebased base: `7499ebb5ef08704d663ec70c6be45884197cc03f` (current upstream `main`).
- Source ref: `refs/remotes/ggbdpq/hunt57-d-rest-paths`
- Source commit: `c0edbe7efef6f701cad85ddef99cd8b8f720db29`, author `ggbdpq <ggbdpq@gmail.com>`, parent `39fed471cc55ad8147fa8eb2edcfb758edae0d77`
- Replayed source commit after the final rebase: `137d1b8a`, author `ggbdpq <ggbdpq@gmail.com>`, committer Edward4226.
- Replay had no conflicts. The original and replayed patches have the same stable patch-id: `26639f5f9eaaac1760b76656c852b50d5ea2a831`.
- The source commit message, author identity, `Fixes #2718`, and co-author trailer were retained. No issue comment, push, PR, or issue close was made.

Reviewed repository guidance:

- `AGENTS.md`
- `LESSONS.md`
- `docs/code-standards.md`
- `docs/contributors.md`
- `docs/subsystems/README.md`
- `docs/subsystems/gateway-routing.md`
- `docs/subsystems/providers-accounts.md`
- `docs/subsystems/provider-plugins.md`
- `docs/subsystems/gateway-middleware.md`
- `docs/subsystems/agent-wiring.md`
- The AutoVision implementation and relevant tests in `internal/gateway`.

## Patch shape

The author's commit changes 9 files, +323/-26:

- `internal/gateway/claude_renewed_test.go`
- `internal/gateway/factory_pool_rest_test.go`
- `internal/gateway/quota_rest_test.go`
- `internal/gateway/rest_resets_read_test.go`
- `internal/gateway/routing.go`
- `internal/provider/allowance_renewed.go`
- `internal/provider/allowance_renewed_test.go`
- `internal/provider/key_allowance.go`
- `internal/provider/routing.go`

No production change outside those files was made during verification.

## State and sibling review

The gateway now has two hooks:

- `renewed` lifts `failQuota` and `window` rests for ordinary `quota`/`window` evidence.
- `restarted` lifts vendor-timed `resets`/`retry-after` rests only when a previously full window either passed its reset or shows a new later reset.
- `renewedNow` calls both hooks because a spent reset starts the window in fact.
- `Allowances` skips failed or windowless readings, retains the previous successful `seen` reading, and does not emit `OnStarted` for a failed read. A failed read therefore remains unknown, not "no window" or "recovered".
- `readKeyAllowance` skips `keep` when the read fails, retaining the prior allowance, and emits neither renewal hook on that failure.

Sibling defect fixed during verification:

- `readKeyAllowance` used `e.at` both as the last-read time and as the time from which `startedAgain` compared a reset. A failed read therefore replaced the prior successful reading time.
- `keyAllowance` now keeps `aAt` for when the current allowance was successfully read and `at` for the latest read attempt, successful or not.
- `keep` compares the supplied reading against `aAt` and updates `aAt` only when a successful reading is kept.
- `noteKeyAllowance`, which records a card reading, updates both `aAt` and `at`.

Permanent regression test:

```text
TestKeyAllowanceElapsedResetStartsAgain
```

The test seeds a successful reading whose reset is already older than the
next success, performs a failed read, then a successful read. It proves the
failed read does not move `aAt` and the final successful read emits
`OnStarted`, without depending on wall-clock sleeps.

Observed red before applying the sibling fix:

```text
--- FAIL: TestKeyAllowanceElapsedResetStartsAgain
    a failed reading moved the last successful reading
FAIL
```

Observed red under mutation, with `keep` reading `e.at` instead of `e.aAt`:

```text
--- FAIL: TestKeyAllowanceElapsedResetStartsAgain
    the reset passed since the last successful reading: OnStarted was told nothing
FAIL
```

The mutation was restored. The permanent test then passed.

## Red before green

Original base `3b717d5e` with only the new gateway tests present, under an isolated HOME:

```text
TestReadingKeepsARefusalsRest:
a reading that found the window less than full lifted the refusal's rest, due at 04:13:24
--- FAIL

TestAutoVisionKeepsOffARefusedAccount:
AutoVision = "codex/gpt-6.1-sol", back on the refused account, before its reset
--- FAIL

FAIL github.com/yetone/magpie/internal/gateway 3.167s
```

`TestStartedAgain` on old code used a temporary zero-behavior bridge where
`startedAgain` returned false:

```text
a new, later cycle: started again false
a model's own pool too: started again false
its reset gone by since it was read: not started again
--- FAIL: TestStartedAgain
FAIL github.com/yetone/magpie/internal/provider 1.909s
```

These are real assertion failures, not compile errors or skips.

## Mutation

The new `startedAgain` body was temporarily replaced with the old generalized
reading test:

```go
return a.renewedFrom(was, wasAt, share, now)
```

Relevant raw failures:

```text
TestStartedAgain:
less than full, the same reset standing: started again true
a model's pool, the same reset standing: started again true
--- FAIL

TestReadingKeepsARefusalsRest:
a reading that found the window less than full lifted the refusal's rest
--- FAIL

TestAutoVisionKeepsOffARefusedAccount:
AutoVision = "codex/gpt-6.1-sol", back on the refused account
--- FAIL
```

The mutation was restored before the green runs.

## Targeted green

Provider and related gateway tests, isolated HOME, `-p 1`:

```text
ok  	github.com/yetone/magpie/internal/provider	3.225s
ok  	github.com/yetone/magpie/internal/gateway	8.722s
```

The run included:

```text
TestKeyAllowanceElapsedResetStartsAgain
TestReadingKeepsARefusalsRest
TestAutoVisionKeepsOffARefusedAccount
TestClaudeAccountBackOnceItsWindowRenews
TestFactoryStandardOutLeavesCore
TestQuotaRestsUntilItsReset
TestAutoVisionPassesOverOneOut
TestAutoVisionTierAmongThoseWithAllowance
TestSpentModelAcrossAccounts
TestVisionDoesNotAskSpentDescriber
TestSearcherPassesOverOneOut
TestRefusedMidReadRestsByWindow
TestRoutingHoldsAWindowRestToLongestQuota
TestKeyOutOfItsWindowRestsUntilReset
TestRenewedToldToTheRoutingPage
TestStartedAgain
TestRenewedFrom
TestClaudeAccountToldRenewed
TestPluginAccountToldRenewed
TestKeyAllowanceNeverWaits
TestKeyAllowanceFailedReadKeepsLast
TestKeyAllowanceForgottenMidRead
TestKeyAllowanceStaleMidRead
TestKeyAllowanceSeededFromItsCard
TestKeyAllowanceOnlyForSub2APIKeys
TestKeyAllowancePerKeyAndForgotten
TestKeyAllowanceRenewed
TestPlanKeyAllowance
TestPlanKeyAllowanceFromItsCard
TestSeatKeptThroughAFailedRead
TestAllowancesStaleMidRead
```

Earlier focused runs also passed the same core families:

```text
TestReadingKeepsARefusalsRest
TestAutoVisionKeepsOffARefusedAccount
TestStartedAgain
```

## Formatting, vet, build

```text
gofmt -l: clean
git diff --check: clean
windows vet: ok
linux vet: ok
windows build: ok
linux build: ok
```

Commands used for the cross-platform checks:

```powershell
go vet -tags nogui ./...
$env:GOOS='linux'; go vet -tags nogui ./...
go build -tags nogui ./...
$env:GOOS='linux'; go build -tags nogui ./...
```

## Full-package runs: environment baseline only

The complete runs are not acceptance gates on this host.

`internal/provider` under isolated HOME failed in existing keychain/storage and
allocation-sensitive tests unrelated to this patch:

```text
--- FAIL: TestCodexListTagKeptWhileNothingChanged (1.04s)
--- FAIL: TestCodexSignedInInKeychain (0.06s)
--- FAIL: TestCodexKeychainRefreshWritesItem (0.03s)
--- FAIL: TestCodexKeychainSwitch (0.11s)
--- FAIL: TestCodexKeychainAskedSeldom (0.03s)
--- FAIL: TestCodexKeychainPromptWaitedFor (0.09s)
--- FAIL: TestCodexKeychainRetry (0.13s)
--- FAIL: TestCodexKeychainSignOut (0.03s)
--- FAIL: TestCodexSignInKnown (0.05s)
--- FAIL: TestSavedButSignedOut (0.06s)
FAIL
FAIL	github.com/yetone/magpie/internal/provider	177.025s
```

`internal/gateway` did not complete because the pre-existing Windows test
`TestClaudeMemRunsFromTheCgroup` blocks in `os.ReadFile`:

```text
panic: test timed out after 30m0s
running tests:
	TestClaudeMemRunsFromTheCgroup (28m57s)
FAIL	github.com/yetone/magpie/internal/gateway	1802.447s
```

The same test alone timed out on the patched tree and was reproduced on base
`3b717d5e`:

```text
patched: panic: test timed out after 2m0s
base:    panic: test timed out after 30s
```

The full provider/gateway packages are therefore recorded as environment
baseline / not tried as an acceptance gate, not as a patch regression.

## Not tried

- `go test -race`: not tried because this Windows host has no gcc.
- Real vendor accounts or credentials: not used.
- The live Magpie 3425 instance: not used.
- PID `17684` (`magpie-windows-amd64`) was left running throughout.
- No push, PR, issue comment, or issue state change.

## Verdict

- The two requested #2718 behaviors are independently reproduced red and green:
  a normal usage reading no longer clears a vendor-timed rest, and AutoVision
  no longer selects the resting account.
- The author's patch applies cleanly to current main with identical patch-id
  and author attribution.
- Verification also found and fixed a sibling defect in `readKeyAllowance`:
  elapsed-reset propagation now uses the last successful reading time rather
  than the latest failed read, and the permanent regression test is red on the
  old path and green on the completed patch.
