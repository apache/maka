## Summary

The red is a stale global credential cache answering a test with what an earlier test's leftover run read. `claudeCredential` (internal/provider/account.go:578) serves reads from one global slot by age alone (`claudeCacheTTL`, 10s, internal/provider/account.go:359; the serve is at :593). A test's setup has a milliseconds-wide window — `claudeHome` forgets that cache (via `isolate`, internal/provider/account_test.go:71, and again at :274), then `claudeSignIn` (internal/provider/account_test.go:252) writes the sign-in — and a run let go by an earlier test that reads the sign-in inside that window finds no credential in the fresh temp home and caches `ok=false` (the store at internal/provider/account.go:596). Every later read in the test is served that miss: `claudeAccount` (internal/provider/account.go:745) falls to `claudeStandInAccount` (internal/provider/claude_dirs.go:384), `claudeListed` (internal/provider/claude_dirs.go:316) finds no saved Claude account in the temp logins.json, no provider is made, and `find(All(), "claude")` at internal/provider/claude_models_test.go:50 returns false. That is the issue's output, byte for byte, including the 0.00s.

The two candidates in the issue are timing, not cause. 1bd99194e added `TestClaudeAllSignedOutStaysListed` — the test that runs immediately before this one in file order, and one whose own mid-test credential removal ends with a cached miss (which the next test's `claudeHome` does forget) — so it shifts the schedule the flake rides on; c087834d6 changed when logins.json's lock is taken. Neither leaves state that survives the victim's own `claudeHome`; the state that does the damage is written inside the window.

## Cause

A leftover run of an earlier test lands `claudeCredential()` between the test's forget and its write. The cache is one slot, keyed by nothing, invalidated only by age or an explicit forget: the miss it caches there is then served to the test's own first read for the rest of the TTL, whatever the file on disk says. Nothing in the test's own flow reads the credential before the write, so the poison always comes from across a test boundary — the same class the sign-in machinery guards against with `endClaudeSignIns` and `claudeLogins` (internal/provider/signin_claude_test.go, internal/provider/claude_signin.go:289, added for #1802: "what that run does — add the account, read claudeKeychain, forget the account caches — would land in a later test"). Which specific run landed it in the maintainer's loaded run can't be told from here; that a reader in the window produces the exact failure is what the pinned repro below shows.

## Fix

`claudeSignIn` now calls `forgetClaudeCredential` after it writes the sign-in, so what a read serves is what the test wrote (internal/provider/account_test.go, the helper every Claude Code sign-in in the package goes through — the fix covers all of them at once). The writers that bypass the helper don't have the hole: `saveClaudeCredential` caches what it just wrote (internal/provider/account.go:600), and the one test that writes the file by hand already forgets the cache itself (`TestClaudeUsageUnavailableAfterAccountSwitch`, internal/provider/claude_usage_fallback_test.go:224). No product code changed, and 1bd99194e's listing behavior is untouched.

## Verification

| Run | Result |
|---|---|
| pinned pair (throwaway reader in a tight loop + `TestClaudeAccountServesModelsListedSinceItsFetch`), `-count=3`, reader since deleted | green x8 with the fix |
| the same pair with the fix removed (ablation), under load | red on the 1st try, `claude_models_test.go:52`, the issue's output; fix restored, green x4 |
| `go test ./internal/provider -count=1 -timeout 45m` | ok 74.0s |
| `go test ./internal/provider -run Claude -count=5` | ok 65.8s |
| `gofmt -l` on the changed file | clean |
| `go vet ./internal/provider` darwin; `GOOS=linux go vet -tags nogui`; `GOOS=windows go vet` | clean |
| `go build ./...` darwin/arm64, linux/amd64 `-tags nogui`, windows/amd64 | ok (pre-existing linker/cgo warnings only) |

## Not verified

The natural full-package red did not reproduce here: three unloaded full-package runs without the fix stayed green on this machine, matching the issue's "went red once" — the flake rode load from other sessions' suites. The pinned pair above uses a stand-in reader, not one caught in the act; which run of which earlier test landed the read in the maintainer's window is unknown.

---

**Source**: the maintainer's issue #3174; the failing order is pinned by `TestHunt3174Straggler|TestClaudeAccountServesModelsListedSinceItsFetch` — a throwaway reader (a tight `claudeCredential()` loop, registered ahead of claude_models_test.go and deleted before the commit) standing in for a run let go by an earlier test, run beside the test under load.

**Red without the fix** (base `f5b01574`):

```
--- FAIL: TestClaudeAccountServesModelsListedSinceItsFetch (0.09s)
    claude_models_test.go:52: claude: {ID: Name: ... Account:<nil>} false
FAIL
FAIL	github.com/yetone/magpie/internal/provider	0.944s
```

(struct elided as in the issue; the full dump is the same `Provider` struct print.)

**Siblings**: every test that signs Claude Code in goes through `claudeSignIn` — account_test.go, claude_logout_test.go, claude_models_test.go, claude_proxy_env_test.go, claude_seats_test.go, claude_switch_fresh_test.go, claude_usage_test.go, claude_usage_fallback_test.go, claude_usage_switched_test.go, claude_crossed_test.go, allowance_renewed_test.go, left_alone_test.go, signedout_test.go, signin_claude_test.go and the rest of the helper's callers — all covered by the one helper change. The credential writers that bypass it cache what they wrote (`saveClaudeCredential`) or already forget (`TestClaudeUsageUnavailableAfterAccountSwitch`). Nothing of the same shape was left unfixed; cleanup order is unaffected — the drop is a plain call on the helper's path, not a `t.Cleanup`, so it runs before any later assertion and registers nothing.

**When the read fails**: the drop only forgets a cache entry. A genuine absence of a sign-in still reads as one — the account then goes through `claudeStandInAccount` (listed signed out, per 1bd99194e) or is absent, exactly as each path behaves today; nothing is masked by the fix.

**Not verified**: which earlier test's run landed the read in the window on the maintainer's machine; the natural red under a loaded full-package run (three tries here stayed green — see Not verified above); nothing under internal/product code was exercised beyond the suite rows in the table.

Branch with the commit: [hunt57-a-claude-models-race](https://github.com/ggbdpq/magpie/tree/hunt57-a-claude-models-race) (head `128cd937`).

**Attribution**: AI-written; reviewed and posted by ggbdpq. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: 1 file changed, 6 insertions(+). SHA-256 first 16: `6fabf660ee533745`.

```patch
From 128cd9371f67337c5abf4a2f2f270211a3111fc3 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Wed, 21 Oct 2026 21:46:58 +0800
Subject: [PATCH] provider: claudeSignIn drops the credential cache it wrote
 over, so a straggler's stale miss can't unlist the account (#3174)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

TestClaudeAccountServesModelsListedSinceItsFetch went red in a full
internal/provider run, green alone: find(All(), "claude") right after
claudeSignIn found no Claude row (claude_models_test.go:52).

What changed: claudeSignIn now calls forgetClaudeCredential after it
writes the sign-in. claudeHome forgets the credential cache before the
test runs, and the cache is one global slot served by age alone
(claudeCacheTTL, 10s): a run let go by an earlier test that reads the
sign-in between that forget and this write — the window is the test's
own setup, milliseconds — reads the home before the credential is in
it, caches that there is none, and every later read in the test is
served that miss. claudeAccount then falls to claudeStandInAccount,
logins.json has no saved Claude account, and the provider is not made.
A reader run to a tight loop as a stand-in for that straggler makes the
test fail at :52 with the issue's exact output; with the drop it stays
green beside it, and removing the drop brings the red back.

The other writers of a credential don't have the hole: saveClaudeCredential
caches what it wrote, and the tests that write the file by hand
(TestClaudeUsageUnavailableAfterAccountSwitch) already forget the cache
themselves. The helper was the one writer left serving reads a stale
cache answers for; every test that signs Claude Code in through it is
covered at once.

Run: triggered pair go test -run 'TestHunt3174Straggler|TestClaudeAccountServesModelsListedSinceItsFetch'
(count=3, the straggler being a throwaway reader since deleted) green
x8 with the fix, red without it under load; go test ./internal/provider
-count=1 -timeout 45m ok 74.0s; -run Claude -count=5 ok 65.8s; gofmt -l
clean; go vet of the package on darwin, GOOS=linux vet -tags nogui and
GOOS=windows vet clean; go build ./... for darwin/arm64, linux/amd64
(-tags nogui) and windows/amd64. A full-package run without the fix
under load on this machine stayed green in three tries, as the issue's
red is a once-flake; the triggered pair is the pinned repro.

Fixes #3174

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/account_test.go | 6 ++++++
 1 file changed, 6 insertions(+)

diff --git a/internal/provider/account_test.go b/internal/provider/account_test.go
index af677c91..df4d2d0d 100644
--- a/internal/provider/account_test.go
+++ b/internal/provider/account_test.go
@@ -261,6 +261,12 @@ func claudeSignIn(t *testing.T, home string, expiry time.Time) string {
 		// what magpie must not clobber when it writes a refreshed token back
 		"mcpOAuth": map[string]any{"plugin:slack:slack|x": map[string]any{"serverName": "Slack"}},
 	})
+	// A run let go by an earlier test that reads the sign-in between this
+	// test's forget (claudeHome) and this write caches that there is none,
+	// and that miss is served for the cache's TTL: the account went
+	// unlisted mid-package (#3174). What this test wrote is what a read
+	// serves.
+	forgetClaudeCredential()
 	return path
 }
 
-- 
2.50.1 (Apple Git-155)

```
