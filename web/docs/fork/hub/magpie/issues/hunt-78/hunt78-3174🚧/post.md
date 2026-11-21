## Summary

The red at 344d114 is the original hole, not a second path: no fix ever landed upstream. I fetched `344d11484e411...` — its `claudeSignIn` is byte-identical to main's, and `account.go` / `account_test.go` / `claude_models_test.go` have a zero diff between main (`b9950956`) and that head. The October 21 drop (mine) and the fork regression (`873c5dfd`) live only in forks; main still writes the fixture's login without touching the one global credential cache. This patch re-offers the two-line drop plus a deterministic regression, and — new since October 21 — names the natural stragglers with stack evidence, so the "how" no longer rests on a stand-in reader.

## The stragglers, caught in the act

An instrumented run (a throwaway patch logging every cache store's stack; since reverted) over the full provider suite: 652 stores, **27 of them from non-test goroutines** — `startClaudeSignIn`'s letting-go goroutine (the drain after `claude auth login` exits, before its own `forgetAccountCaches` lands), `ImportLogins`' background read, a provider `TestModels` goroutine, a saved-usage refresh. One store is exactly this issue's red waiting for a bad schedule: `startClaudeSignIn`'s goroutine stored `ok=false` — a miss — during the logout/models stretch of a green run. The window it has to land in is the fixture's own setup: `claudeHome` forgets the cache, `claudeSignIn` writes the file. A miss stored inside it is served to the test's first read for the cache's whole TTL (10s): `claudeAccount` falls to `claudeStandInAccount`, the fresh home holds no saved login, no provider is made, `claude_models_test.go:52`. Under load ~300 the window widens (temp dir, env, the write) and the stragglers' wakeups drift into it — the issue's 649s reds; on a fast machine the window stays closed, as the green-alone `-count=10` says.

## What changed

`claudeSignIn` (internal/provider/account_test.go) calls `forgetClaudeCredential()` after it writes the login: whatever a straggler cached in the window is dropped, and a reader after the write sees the credential that is there — airtight regardless of who straggles, and every Claude Code sign-in in the package goes through this helper. The hand-written live-home credential (`TestClaudeUsageUnavailableAfterAccountSwitch`, claude_usage_fallback_test.go:223) already forgets the cache itself; the other `.credentials.json` writers assert through explicit paths or logins.json, not the global cache, so they need nothing. Plus `TestClaudeSignInServesWhatItWrote`: it reads the empty fixture home once (caching a miss, as any straggler does — no goroutines, no timing), then signs in and requires the credential visible. No product code changed.

## Verification

| Run | Result |
|---|---|
| `TestClaudeSignInServesWhatItWrote` on base `b9950956`, before the drop | red: "the fixture's sign-in read as the cached miss" (account_test.go:281) |
| regression + victim + sibling, with the drop, `-count=10` | ok |
| ablation: the drop removed, same injection | red again at account_test.go:281 |
| `go test -tags nogui ./internal/provider/ ./internal/cli/ -count=1` (the issue's combination) | ok 81.1s, ok 37.0s |
| `gofmt -l` on the changed file | clean |
| `go vet ./...` darwin; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build ./...` darwin/arm64, linux/amd64 `-tags nogui`, windows/amd64 | ok (pre-existing cgo warnings on darwin only) |
| instrumented full run, every store's stack on file | 652 stores, 27 from non-test goroutines; the `startClaudeSignIn` miss store above |

## Not verified

The natural red did not reproduce here — an unloaded full run stays green, and the red needs the loaded schedule the issue describes; the instrumented run is a green-run observation of the stores that produce it, and the injected pair is the pinned repro. Which straggler landed it in your 649s run can't be told from a log that wasn't running there. If you'd still rather not take the drop, the regression test alone pins the mechanism in-repo either way.

---

**Source**: issue #3174, your October 24 comment; the maintainer head `344d11484e41...` compared against main `b995095637af...` (zero diff on the three files in play; `873c5dfd59af...` is not an ancestor of either).

**Injection**: `TestClaudeSignInServesWhatItWrote` caches the miss itself with one read of the empty fixture home — the deterministic stand-in for a straggler, green-run proven by the instrumented log above.

**Siblings**: all 25 callers of `claudeSignIn` are covered by the one helper change; the sign-in drain goroutines end with their own `forgetAccountCaches` (which drops the credential cache and the status), so the fix only closes the fixture's side of the window; writers that bypass the helper either cache what they wrote (`saveClaudeCredential`) or forget it themselves (`TestClaudeUsageUnavailableAfterAccountSwitch`). Nothing of the same shape is left unguarded; no cleanup order changed — the drop is a plain call on the helper's path, not a `t.Cleanup`.

**When the read fails**: the drop only forgets a cache entry. A genuine absence of a sign-in still reads as one — stand-in listing and sign-out behavior are exactly as today; nothing is masked.

Branch with the commit: [hunt78-3174-flaky-root](https://github.com/ggbdpq/magpie/tree/hunt78-3174-flaky-root) (head `49b93b697f9292fd601b61a4ad90b7c93b7789a0`).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: hunt78-3174-flaky-root (#3174) — git am applies it as is; SHA-256 first 16: 8af0ed15969756a0</summary>

```text
From 49b93b697f9292fd601b61a4ad90b7c93b7789a0 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sat, 24 Oct 2026 20:16:48 +0800
Subject: [PATCH] provider: a Claude fixture's sign-in serves what it wrote,
 not a miss a straggler read of the empty home cached (#3174)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

TestClaudeAccountServesModelsListedSinceItsFetch went red in loaded full
runs and green alone, again (claude_models_test.go:52, find(All(),
"claude") found no Account), and no fix is in: the drop-here patch from
October 21 lives only in forks — main's claudeSignIn still writes without
touching the credential cache.

What changed: claudeSignIn now calls forgetClaudeCredential after it
writes the login, and a deterministic regression pins the mechanism.
claudeHome forgets the one global credential cache, then the fixture
writes the sign-in — and in that window any straggler reader of
claudeCredential sees the home still empty and caches ok=false. The cache
is one slot served by age alone (claudeCacheTTL, 10s), so the test's own
first read is answered by that miss: claudeAccount falls to
claudeStandInAccount, the fresh home holds no saved login, no provider is
made, and find returns false. An instrumented run (every cache store's
stack on file) caught the stragglers in the act: the letting-go goroutine
of `claude auth login` (startClaudeSignIn) stored an ok=false during the
logout/models stretch of a green run, and ImportLogins' background read
and a provider TestModels goroutine store the same way from their tests.
Under load the window (temp dir, env, the write) widens and those
goroutines' wakeups drift into it — the issue's load ~300, 649s reds; a
fast machine runs the window closed and stays green, as the green-alone
-count=10 says. The forget after the write drops whatever a straggler
cached in the window, and a reader after it sees the credential that is
there: airtight regardless of who straggles. Every Claude Code sign-in in
the package goes through this helper, so one change covers them all; the
hand-written credential file (TestClaudeUsageUnavailableAfterAccountSwitch)
already forgets the cache itself. No product code changed.

Run: TestClaudeSignInServesWhatItWrote red on the base (account_test.go:
"the fixture's sign-in read as the cached miss"), green with the drop
-count=10 beside the victim and its sibling; go test -tags nogui
./internal/provider/ -count=1 ok; go test -tags nogui ./internal/cli/ ok;
gofmt -l clean; go vet ./... darwin, GOOS=linux vet -tags nogui and
GOOS=windows vet clean; go build ./... darwin/arm64, linux/amd64 -tags
nogui, windows/amd64 ok.

Fixes #3174

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/account_test.go | 28 ++++++++++++++++++++++++++++
 1 file changed, 28 insertions(+)

diff --git a/internal/provider/account_test.go b/internal/provider/account_test.go
index af677c91..32578ad3 100644
--- a/internal/provider/account_test.go
+++ b/internal/provider/account_test.go
@@ -261,9 +261,37 @@ func claudeSignIn(t *testing.T, home string, expiry time.Time) string {
 		// what magpie must not clobber when it writes a refreshed token back
 		"mcpOAuth": map[string]any{"plugin:slack:slack|x": map[string]any{"serverName": "Slack"}},
 	})
+	// A run let go by an earlier test that reads the home in the window
+	// between claudeHome's forget and this write — a sign-in's letting-go,
+	// an import's background read, a provider probe — caches that there is
+	// none, and the miss is served for the cache's TTL: the account went
+	// unlisted mid-package, under load only (#3174). What this test wrote
+	// is what a read serves.
+	forgetClaudeCredential()
 	return path
 }
 
+// A read of the fixture's home while it is still empty — a run let go by an
+// earlier test makes one: a sign-in's letting-go (claudeLogins), an import's
+// background read, a provider probe — caches that there is no credential,
+// and the cache is one global slot served by age alone. What claudeSignIn
+// wrote must be what a read serves after it, whatever landed in the cache
+// meanwhile: served the miss, the account goes unlisted mid-package, under
+// load only (#3174).
+func TestClaudeSignInServesWhatItWrote(t *testing.T) {
+	home := claudeHome(t)
+	if _, _, ok := claudeCredential(); ok {
+		t.Fatal("the empty home read as signed in")
+	}
+	claudeSignIn(t, home, time.Now().Add(time.Hour))
+	if _, _, ok := claudeCredential(); !ok {
+		t.Fatal("the fixture's sign-in read as the cached miss")
+	}
+	if p, ok := find(All(), "claude"); !ok || p.Account == nil {
+		t.Fatalf("claude: %+v %v", p, ok)
+	}
+}
+
 // claudeHome sets up a temp home with the usual env; the caller adds credentials.
 func claudeHome(t *testing.T) string {
 	t.Helper()
-- 
2.50.1 (Apple Git-155)
```

</details>
