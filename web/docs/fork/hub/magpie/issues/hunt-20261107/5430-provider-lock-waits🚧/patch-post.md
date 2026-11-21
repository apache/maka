@yetone Following up on #5430 by @yunwang2442-creator: after #5104, the held dumps still show two ways `logins.json`'s lock queues a request's routing plan — the Claude stand-in taking the lock once per catalog build (peak 47 goroutines parked on it), and `pluginSignInAt` taking the same lock to read one counter (7–14 plugin usage polls parked behind the build). Both shapes queue every request's plan behind whatever holds the lock, so the unrouted watchdog still sees "no wait magpie knows of" and kills the request at 30s. This patch takes the two smallest items off the reporter's own list.

**Root cause**: `claudeStandInAccount` (internal/provider/claude_dirs.go:570 at v0.1.3070) takes `loginsMu` and re-reads `logins.json` on every build, and every catalog build falls to it while Claude Code has no sign-in — #5104's `heldOf` lets waiters share one build, but each build (and each re-build after a 5s `heldWait` timeout) re-took the lock, so a slow pass re-multiplied the convoy instead of closing it. And `pluginSignInAt` (internal/provider/plugin_accounts.go:458) took `loginsMu` to read the single counter `pluginSignInTold`, which put every plugin account's usage poll in the same queue (its `Locked` hook re-stats the file on every take, so the takes also pile work on the file).

**The fix**: two smallest items, following the reporter's own analysis. The stand-in is now held under one `heldOf` key, `claudeStandIn`, exactly as `Logins` and `OwnPaused` have been since #5104: the asks of a request share one build, the `Locked` hook runs once per window instead of once per build, and a write lists it anew (`writeLogins` ends in `Changed`). `pluginSignInTold` is an `atomic.Uint64` read without the lock; tells still happen under `loginsMu` (`pluginSignInSaid` stays there), and a tell that said itself before the note takes the lock still stands over a reading begun before it — the count only moves forward, so the comparison `pluginSignInSaid[said] > began` skips no more and no less than before. The other two items of the reporter's list are real but not in this patch (see Not verified).

<details><summary>patch: provider: the Claude stand-in and a plugin counter read logins.json's lock once, not once a build — git am applies it as is; SHA-256 first 16: af409857a16db9f6</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 01:30:14 +0800
Subject: [PATCH] provider: the Claude stand-in and a plugin counter read
 logins.json's lock once, not once a build

Every request's routing plan lists the agent's accounts, and with no
Claude Code sign-in each list fell to claudeStandInAccount, which took
logins.json's lock and read the file again: 47 goroutines parked on the
lock in #5430's dump, one build after another re-multiplying as #5104's
held waiters timed out at 5s. The stand-in is held under one key, as
Logins and OwnPaused are, so the asks of a request share one build, and
a write lists it anew.

And pluginSignInAt, which reads one counter, took the same lock: every
plugin account's usage poll queued on it behind the catalog build (7
goroutines parked there in the same dump). The count is atomic, read
without the lock; a tell that said itself before the note takes the
lock still stands over a reading begun before it, by the count as
before.

Tests: TestClaudeStandInListedOnceARequest (modelled on
TestOwnPausedListedOnceARequest) and TestPluginSignInAtNeedsNoLock fail
without the change; go test -tags nogui ./... passes with it.
---
 internal/provider/claude_dirs.go      | 27 ++++++++--
 internal/provider/logins_held_test.go | 74 +++++++++++++++++++++++++++
 internal/provider/plugin_accounts.go  | 25 +++++----
 3 files changed, 112 insertions(+), 14 deletions(-)

diff --git a/internal/provider/claude_dirs.go b/internal/provider/claude_dirs.go
index 7c3815a01..ea4347a81 100644
--- a/internal/provider/claude_dirs.go
+++ b/internal/provider/claude_dirs.go
@@ -565,15 +565,36 @@ func claudeSignedOut(l savedLogin) string {
 	return claudeGoneLapse
 }
 
+// standInBuilds counts the stand-in's builds (a test reads it): with no
+// Claude Code sign-in every catalog build made one, and each took
+// logins.json's lock (#5430).
+var standInBuilds atomic.Int64
+
+// claudeStandInOf is what the stand-in's build gives.
+type claudeStandInOf struct {
+	p  Provider
+	ok bool
+}
+
 // claudeStandInAccount is the Claude Code provider while Claude Code is
-// signed out, on claudeListed's account; false with no account saved.
+// signed out, on claudeListed's account; false with no account saved. It
+// is held under one key, as Logins is: with no sign-in every catalog
+// build asked for it, and each took logins.json's lock — 47 goroutines
+// parked there in #5430's dump. A write lists it anew, as Logins does.
 func claudeStandInAccount() (Provider, bool) {
+	st := heldOf("claudeStandIn", claudeStandInBuild)
+	return st.p, st.ok
+}
+
+// claudeStandInBuild is the stand-in's build.
+func claudeStandInBuild() claudeStandInOf {
+	standInBuilds.Add(1)
 	loginsMu.Lock()
 	ls := readLogins()
 	loginsMu.Unlock()
 	user := claudeListed(ls)
 	if user == "" {
-		return Provider{}, false
+		return claudeStandInOf{}
 	}
 	acct := &Account{Agent: "claude", User: user, standIn: true}
 	for _, l := range ls {
@@ -582,7 +603,7 @@ func claudeStandInAccount() (Provider, bool) {
 		}
 	}
 	acct.token = func(context.Context) (string, error) { return claudeSavedDir(user) }
-	return claudeProvider(acct), true
+	return claudeStandInOf{claudeProvider(acct), true}
 }
 
 // AgentsOwn says the account is the one the agent itself is signed in to,
diff --git a/internal/provider/logins_held_test.go b/internal/provider/logins_held_test.go
index e2975b56f..198499e37 100644
--- a/internal/provider/logins_held_test.go
+++ b/internal/provider/logins_held_test.go
@@ -133,3 +133,77 @@ func TestOwnPausedListedOnceARequest(t *testing.T) {
 		t.Fatal("a write did not list OwnPaused anew")
 	}
 }
+
+// TestClaudeStandInListedOnceARequest: with no Claude Code sign-in, every
+// catalog build fell to claudeStandInAccount, and each took logins.json's
+// lock and read the file again — 47 goroutines parked on the lock in
+// #5430's dump, one build after another re-multiplying as #5104's held
+// waiters timed out at 5s. The stand-in is listed once a request, as
+// Logins is, and a write lists it anew.
+func TestClaudeStandInListedOnceARequest(t *testing.T) {
+	claudeHome(t)
+	t.Setenv("CLAUDE_CONFIG_DIR", "")
+	if err := writeLogins([]savedLogin{
+		{Agent: "claude", User: "a@x.com", Auth: []byte(`{"claudeAiOauth":{"accessToken":"tok-a","refreshToken":"r-a"}}`)},
+	}); err != nil {
+		t.Fatal(err)
+	}
+	defer func(d time.Duration) { heldFor = d }(heldFor)
+	heldFor = time.Hour // a loaded machine's pause isn't the bound
+	release := Hold()
+	defer func() { release() }()
+	if _, ok := claudeStandInAccount(); !ok {
+		t.Fatal("no stand-in account")
+	}
+	runs := standInBuilds.Load()
+	const n = 20
+	start := make(chan struct{})
+	done := make(chan struct{}, n)
+	for range n {
+		go func() {
+			<-start
+			claudeStandInAccount()
+			done <- struct{}{}
+		}()
+	}
+	close(start)
+	for range n {
+		<-done
+	}
+	if got := standInBuilds.Load() - runs; got != 0 {
+		t.Fatalf("%d asks in one request built the stand-in %d times again, want 0 (each took logins.json's lock: #5430)", n, got)
+	}
+	if err := writeLogins(readLogins()); err != nil {
+		t.Fatal(err)
+	}
+	if _, ok := claudeStandInAccount(); !ok {
+		t.Fatal("no stand-in account after a write")
+	}
+	if got := standInBuilds.Load() - runs; got != 1 {
+		t.Fatalf("after a write: built the stand-in %d times, want 1", got)
+	}
+	release()
+	release = func() {}
+	claudeStandInAccount()
+	claudeStandInAccount()
+	if got := standInBuilds.Load() - runs; got != 3 {
+		t.Fatalf("outside a request: built the stand-in %d times, want 3", got)
+	}
+}
+
+// TestPluginSignInAtNeedsNoLock: pluginSignInAt reads one counter, and
+// taking logins.json's lock for it put every plugin account's usage poll
+// in the queue on that lock — 7 goroutines parked in it behind the
+// catalog build in #5430's dump. The counter is read without the lock.
+func TestPluginSignInAtNeedsNoLock(t *testing.T) {
+	signIn(t)
+	loginsMu.Lock()
+	done := make(chan uint64, 1)
+	go func() { done <- pluginSignInAt() }()
+	select {
+	case <-done:
+	case <-time.After(5 * time.Second):
+		t.Fatal("pluginSignInAt waited for loginsMu: a counter read queued on logins.json's lock (#5430)")
+	}
+	loginsMu.Unlock()
+}
diff --git a/internal/provider/plugin_accounts.go b/internal/provider/plugin_accounts.go
index 92cd32f6d..f9ce69367 100644
--- a/internal/provider/plugin_accounts.go
+++ b/internal/provider/plugin_accounts.go
@@ -440,13 +440,19 @@ func notePluginLapse(pp plugin.Provider, key string, status int) {
 }
 
 // What plugin accounts' sign-ins were told of (a request's answer, a usage
-// reading, a sign-in) is counted, under loginsMu: pluginSignInTold
-// counts it all, and pluginSignInSaid has the count each account was last
-// told of at. A count, not a time: Windows' clock moves in ticks of up to
-// 15.6ms, and a reading begun just after an answer would read as begun
-// with it.
+// reading, a sign-in) is counted: pluginSignInTold counts it all, and
+// pluginSignInSaid has the count each account was last told of at. A
+// count, not a time: Windows' clock moves in ticks of up to 15.6ms, and a
+// reading begun just after an answer would read as begun with it.
+// pluginSignInSaid is told under loginsMu; the count is read without it,
+// which every plugin account's usage poll asks of it — the lock put them
+// all in the queue on logins.json's lock (7 goroutines parked there in
+// #5430's dump). A read sees the count as it is made, a step past a tell
+// still saying itself, which the lock would have waited out: a tell that
+// said itself before the note takes the lock still stands over the
+// reading, by the count as before.
 var (
-	pluginSignInTold uint64
+	pluginSignInTold atomic.Uint64
 	pluginSignInSaid = map[string]uint64{}
 )
 
@@ -455,9 +461,7 @@ const toldNow = ^uint64(0)
 
 // pluginSignInAt is the count a usage reading beginning now goes by.
 func pluginSignInAt() uint64 {
-	loginsMu.Lock()
-	defer loginsMu.Unlock()
-	return pluginSignInTold
+	return pluginSignInTold.Load()
 }
 
 // notePluginLapseSince is notePluginLapse for what a usage reading begun
@@ -483,8 +487,7 @@ func notePluginLapseOf(agent, key string, status int, began uint64, text func(us
 		return
 	}
 	if began == toldNow {
-		pluginSignInTold++
-		began = pluginSignInTold
+		began = pluginSignInTold.Add(1)
 	}
 	pluginSignInSaid[said] = began
 	ls := readLogins()
-- 
2.50.1 (Apple Git-155)
```

</details>

**Branch with the commit**: [`fix/5430-provider-lock-waits`](https://github.com/ggbdpq/magpie/tree/fix/5430-provider-lock-waits) (head `9beb98f1b96638d7fa96773915751c03a02ef1ac`), cut directly at current `upstream/main` (`c7810ea5cc5a`); on a fresh checkout `git am` applies clean (verified: the ammed tree is identical to the branch's).

| Check | Result |
| --- | --- |
| `TestClaudeStandInListedOnceARequest` (new) | red before the fix (20 asks in one request built the stand-in 20 times, each taking the lock), pass after |
| `TestPluginSignInAtNeedsNoLock` (new) | red before the fix (the counter read queued on the lock 5s), pass after |
| `TestLoginsListedOnceARequest`, `TestLoginsMissedTogetherListedOnce`, `TestOwnPausedListedOnceARequest` (#5104's family) | pass |
| `go test ./internal/provider/ -tags nogui -timeout 25m -count=1` | ok (110s), zero failures |
| `go test -tags nogui ./...` (pinned Go cache) | one provider failure in a first full run whose per-test identity was lost to output truncation; the package passed the immediate standalone rerun and the next full run. Remaining failures of the final full run are this machine's, not the patch's: `TestMothX` (internal/agent) and `TestProxyCheckSaysAProxyPassedBy` (internal/gui) fail behind this box's proxy, and `TestHostToldTheGatewayAddress` (internal/plugin) fails identically on the parent commit `c7810ea5cc5a` |
| targeted `-race` (provider, gateway, filelock) | gateway ok (1416s), filelock ok; provider reports 3 data races, all one pre-existing shape — a leaked `plugin.Cached` background refresher racing a test's hook (`plugin.tell.func1` → `catalog.Touched` vs `TestSignInDoneOnceTheAccountIsBack.func9`, and two kin of it). The same race reproduces on the parent commit `c7810ea5cc5a` with identical stacks; no race stack references the changed code |
| `gofmt -l` changed files | prints nothing |
| `go vet -tags nogui ./internal/provider` (darwin); same with `GOOS=linux`, `GOOS=windows` | clean |
| `go build -tags nogui ./...` (darwin); `GOOS=linux go build -tags nogui ./...`; `GOOS=windows go build -tags nogui ./...` | clean |
| Ablation | unwrapping `claudeStandInAccount` from `heldOf` turns `TestClaudeStandInListedOnceARequest` red (20 builds again) while `TestPluginSignInAtNeedsNoLock` stays green; restoring the locked read in `pluginSignInAt` turns `TestPluginSignInAtNeedsNoLock` red while the stand-in test stays green |
| Re-verified on upstream/main `c7810ea5cc5a` | the branch is the commit applied directly at the tip; the clean-checkout `git am` tree is identical to the branch's |

**Not verified**: The Windows face of the storm — file syscalls under an antivirus filter driver, and the 30s unrouted stalls themselves — stays with @yunwang2442-creator's machine (NOT-RUNNABLE here); what is reproduced here is the lock-contention shape at the unit layer. The reporter's two larger items are evaluated, not taken: moving `rememberLogins`' discovery I/O out of `loginsMu` re-opens a window the lock closes — another magpie's write (a terminal run, #1674) landing between the discovery and the merge would meet upserts resolved against the older list (`liveLogin("claude")` resolves its owner against `readLogins()`, logins.go:764), so keeping the write serialized needs the merge re-validated against a fresh read under the lock; that is a design of its own and I'd rather not fold it into this patch — happy to draft it separately. And surfacing provider-layer waits to the watchdog needs per-request wait accounting plumbed from `heldOf` waiters and `loginsMu` contenders into the unrouted report (internal/gateway/unrouted.go:696) — report-only, cross-package, not attempted here. Same-family read-under-the-lock sites left as they are, with the judgment that none shows the reported convoy shape: `keepPluginPlan` (takes the lock per usage poll, writes only on a plan change), `savedGoogleProject` (one conditional take per gemini build), `siwcLookup`/`claudeSavedDir`/`Account.Token` (per-request token work).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
