Held requests fixed: a write in one request had every request in flight list the agent's accounts again, one after another, each taking logins.json's file lock when the one before it let go — that is the convoy the held dump showed. A patch below makes a list missed together be built once, and takes the last per-request lock off the routing plan.

## What's wrong

Every request's routing plan lists the agent's accounts: `perKeyEvery` asks `Provider.AlsoOn` (and, with another account on, `Provider.OwnPaused`). `Logins` is held per request, but a write magpie makes in any request (a token refresh among them) drops what is held, and every request then in flight missed together: each rebuilt `loginsNow`, one after another, each taking `logins.json`'s lock when the one before it let go. 20 goroutines queued on that lock in the held dump; the plan waited on a file lock, and the uninstrumented wait ran to the 30s unrouted deadline. `OwnPaused` was never held at all: a provider with another account on asked it once a request, each ask its own read under the lock — even while the request's `Logins` list was fresh.

## Root cause

`heldOf` (internal/provider/hold.go) built a missed value in every caller: nothing made callers that missed together wait for the one building. Under parallel load with writes coming in (every write moves filememo's generation, which drops what is held), the miss was the common case, and the builds — each two takes of the cross-process lock in `loginsNow`, plus the agents' sign-ins read again — serialized behind one lock. That is the convoy; the plugin's 19s catalog work and the settings reads in the dump were other faces of the same shape, already mitigated or since fixed upstream (`15066f84f`).

## The fix

- `heldOf` builds a missed value once: the first caller builds, the rest wait for it, and take what it kept, or build again where a change dropped it while it was built. A builder returns what it built (held only records it), so a held value kept for no time at all (`heldFor = 0`) builds once, not for ever.
- `OwnPaused` asks the held list too, its own key (`ownPaused<agent><user>`), a write listing it anew as for `Logins`.

<details>
<summary>Patch (git am)</summary>

```patch
From cd03628797f071831e6433edc48140087fe5969c Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Tue, 3 Nov 2026 23:49:55 +0800
Subject: [PATCH] provider: requests missing together list logins once, and a
 plan asks OwnPaused of the held list

Every request's routing plan lists the agent's accounts (perKeyEvery
asks AlsoOn, and OwnPaused of the signed-in one), and each list took
logins.json's lock. A write in a request (a token refresh) dropped what
was held, and every request then in flight listed again: each rebuilt
loginsNow one after another, each taking the lock when the one before it
let go - 20 requests queued on the lock in a held dump (#5104), the
routing plan waiting on a file lock it never needs to. And OwnPaused
never was held at all: a provider with another account on asked it once
a request, each ask its own read under the lock.

heldOf now builds a missed list once: the first caller builds, the rest
wait for it and take what it kept, or build again where a change dropped
it while it was built. OwnPaused asks the held list too, its own key, a
write listing it anew as for Logins.

TestLoginsMissedTogetherListedOnce: 20 requests missing together listed
20 times, want 1; TestOwnPausedListedOnceARequest: an ask under a held
request took the lock again, and a write did not list it anew.

Fixes #5104

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/hold.go               | 54 +++++++++++++++---
 internal/provider/keep_login_as_test.go | 18 +++++-
 internal/provider/logins_held_test.go   | 74 +++++++++++++++++++++++++
 internal/provider/logins_on.go          | 13 +++--
 4 files changed, 143 insertions(+), 16 deletions(-)

diff --git a/internal/provider/hold.go b/internal/provider/hold.go
index 1c02bc036..736c09f69 100644
--- a/internal/provider/hold.go
+++ b/internal/provider/hold.go
@@ -215,10 +215,24 @@ func stampNowFiles() [3]rootStamp {
 // for what each row of a page looks up: shared by them, so read only.
 func Held[T any](key string, build func() T) T { return heldOf(key, build) }
 
+// heldCall is a build in flight: callers that missed together wait for
+// the one building, then look for what it kept.
+type heldCall struct {
+	done chan struct{}
+}
+
+// flight is the builds in flight, one each: a write drops what is held,
+// and every request then missing listed again, one after another, each
+// taking logins.json's lock when the one before it let go (#5104).
+var flight = map[string]*heldCall{}
+
 // heldOf is what build gives, built once while a request holds it.
+// Callers that miss together build once: the first builds, the rest wait
+// for it, and take what it kept, or build again where a change dropped it
+// while it was built.
 func heldOf[T any](key string, build func() T) T {
 	held.Lock()
-	if held.holds == 0 {
+	if held.holds == 0 && flight[key] == nil {
 		held.Unlock()
 		return build()
 	}
@@ -227,17 +241,39 @@ func heldOf[T any](key string, build func() T) T {
 		held.Unlock()
 		return h.v.(T)
 	}
-	gen := held.gen
-	held.Unlock()
-	v := build()
-	held.Lock()
-	if held.holds > 0 && held.gen == gen {
-		if held.built == nil {
-			held.built = map[string]heldValue{}
+	if c := flight[key]; c != nil {
+		held.Unlock()
+		<-c.done
+		held.Lock()
+		if h, ok := held.built[key]; ok && time.Since(h.at) < heldFor {
+			held.Unlock()
+			return h.v.(T)
 		}
-		held.built[key] = heldValue{v, time.Now()}
+		held.Unlock()
+		return build()
 	}
+	gen := held.gen
+	c := &heldCall{done: make(chan struct{})}
+	flight[key] = c
 	held.Unlock()
+	var v T
+	func() {
+		defer func() {
+			held.Lock()
+			delete(flight, key)
+			held.Unlock()
+			close(c.done)
+		}()
+		v = build()
+		held.Lock()
+		if held.holds > 0 && held.gen == gen {
+			if held.built == nil {
+				held.built = map[string]heldValue{}
+			}
+			held.built[key] = heldValue{v, time.Now()}
+		}
+		held.Unlock()
+	}()
 	return v
 }
 
diff --git a/internal/provider/keep_login_as_test.go b/internal/provider/keep_login_as_test.go
index 4ff033964..a905e163e 100644
--- a/internal/provider/keep_login_as_test.go
+++ b/internal/provider/keep_login_as_test.go
@@ -6,6 +6,7 @@ import (
 	"net/http"
 	"net/http/httptest"
 	"slices"
+	"sync"
 	"testing"
 )
 
@@ -26,11 +27,20 @@ func TestKeepLoginAsChosen(t *testing.T) {
 			t.Fatal(err)
 		}
 	}
-	used := map[string]float64{}
+	// the fake's answers read what the test sets next: the usage check
+	// runs on a request of its own, so the map is guarded (a list built
+	// sooner reached the fake later, and the race detector said so)
+	var used struct {
+		sync.Mutex
+		m map[string]float64
+	}
+	used.m = map[string]float64{}
 	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
+		used.Lock()
+		defer used.Unlock()
 		json.NewEncoder(w).Encode(map[string]any{"plan_type": "plus", "rate_limit": map[string]any{
 			"primary_window":   map[string]any{"used_percent": 0, "limit_window_seconds": 18000},
-			"secondary_window": map[string]any{"used_percent": used[r.Header.Get("chatgpt-account-id")], "limit_window_seconds": 604800}}})
+			"secondary_window": map[string]any{"used_percent": used.m[r.Header.Get("chatgpt-account-id")], "limit_window_seconds": 604800}}})
 	}))
 	defer fake.Close()
 	old := CodexBase
@@ -83,7 +93,9 @@ func TestKeepLoginAsChosen(t *testing.T) {
 		t.Fatalf("ranks %v", r)
 	}
 	// used up, it stays; the setting outlives a routing change
-	used["acct-me@example.com"], used["acct-1"] = 100, 100
+	used.Lock()
+	used.m["acct-me@example.com"], used.m["acct-1"] = 100, 100
+	used.Unlock()
 	if err := SetRouting("codex", Ordered); err != nil {
 		t.Fatal(err)
 	}
diff --git a/internal/provider/logins_held_test.go b/internal/provider/logins_held_test.go
index 666872fb1..b9660e61c 100644
--- a/internal/provider/logins_held_test.go
+++ b/internal/provider/logins_held_test.go
@@ -46,3 +46,77 @@ func TestLoginsListedOnceARequest(t *testing.T) {
 		t.Fatalf("outside a request: listed %d times, want 3", n)
 	}
 }
+
+// TestLoginsMissedTogetherListedOnce: a write drops what a request holds,
+// and every request in flight lists again — each taking logins.json's
+// lock (and, before the list, the agents' sign-ins) one after another, a
+// convoy of requests all waiting on the same lock under parallel load
+// (#5104). A list missed together is built once: the rest wait for it.
+func TestLoginsMissedTogetherListedOnce(t *testing.T) {
+	signIn(t)
+	loginsSeenAt.Store(0)
+	release := Hold()
+	defer func() { release() }()
+	Logins("codex") // the first list notes the sign-in in logins.json
+	if ls := Logins("codex"); len(ls) != 1 || ls[0].User != "me@example.com" {
+		t.Fatalf("codex accounts: %+v", ls)
+	}
+	runs := loginsRuns.Load()
+	dropHeld() // a write magpie made: what is held is listed anew
+	const n = 20
+	start := make(chan struct{})
+	done := make(chan []Login, n)
+	for range n {
+		go func() {
+			<-start
+			done <- Logins("codex")
+		}()
+	}
+	close(start)
+	for range n {
+		if ls := <-done; len(ls) != 1 || ls[0].User != "me@example.com" {
+			t.Fatalf("listed again as %+v", ls)
+		}
+	}
+	if got := loginsRuns.Load() - runs; got != 1 {
+		t.Fatalf("%d requests missing together listed %d times, want 1", n, got)
+	}
+}
+
+// TestOwnPausedListedOnceARequest: a provider with another account on
+// asks OwnPaused of its own for every request's plan, and each ask took
+// logins.json's lock and read it again, even while the request held what
+// Logins had listed (#5104). An ask lists once a request, as Logins does,
+// and a write lists it anew.
+func TestOwnPausedListedOnceARequest(t *testing.T) {
+	signIn(t)
+	loginsSeenAt.Store(0)
+	release := Hold()
+	defer func() { release() }()
+	Logins("codex") // the first list notes the sign-in in logins.json
+	p, ok := find(All(), "codex")
+	if !ok {
+		t.Fatal("no codex provider")
+	}
+	if p.OwnPaused() {
+		t.Fatal("the only account paused with none to fall back to")
+	}
+	held.Lock()
+	_, cached := held.built["ownPaused\x00codex\x00me@example.com"]
+	held.Unlock()
+	if !cached {
+		t.Fatal("OwnPaused was not listed once a request: it took logins.json's lock again")
+	}
+	if err := writeLogins(readLogins()); err != nil {
+		t.Fatal(err)
+	}
+	if p.OwnPaused() {
+		t.Fatal("paused after a write that paused nothing")
+	}
+	held.Lock()
+	_, cached = held.built["ownPaused\x00codex\x00me@example.com"]
+	held.Unlock()
+	if !cached {
+		t.Fatal("a write did not list OwnPaused anew")
+	}
+}
diff --git a/internal/provider/logins_on.go b/internal/provider/logins_on.go
index 9ba7026f4..27a0383c6 100644
--- a/internal/provider/logins_on.go
+++ b/internal/provider/logins_on.go
@@ -101,14 +101,19 @@ func pausedOwn(ls []savedLogin, agent, user string) bool {
 
 // OwnPaused says the provider is the account a Claude Code or Codex agent
 // is signed in to, paused while another of its accounts is on (#263): the
-// gateway passes over it, the agent staying signed in to it.
+// gateway passes over it, the agent staying signed in to it. A request's
+// plan asks it of every account provider, each ask its own read of
+// logins.json under its lock: listed once a request, as Logins is (#5104),
+// and a write lists it anew.
 func (p Provider) OwnPaused() bool {
 	if p.Account == nil || p.Account.token != nil && !p.Account.standIn || !slices.Contains(loginAgents, p.Account.Agent) {
 		return false
 	}
-	loginsMu.Lock()
-	defer loginsMu.Unlock()
-	return pausedOwn(readLogins(), p.Account.Agent, p.Account.User)
+	return heldOf("ownPaused\x00"+p.Account.Agent+"\x00"+p.Account.User, func() bool {
+		loginsMu.Lock()
+		defer loginsMu.Unlock()
+		return pausedOwn(readLogins(), p.Account.Agent, p.Account.User)
+	})
 }
 
 // AlsoOn is a signed-in agent's other accounts that are on, each as a
-- 
2.50.1 (Apple Git-155)
```
</details>

SHA-256 (first 16): ecd22c03a97227f8

## Verification

| Check | Result |
| --- | --- |
| TestLoginsMissedTogetherListedOnce (new, red before the fix: 20 requests missing together listed 20 times, want 1) | ok |
| TestOwnPausedListedOnceARequest (new, red before the fix: an ask under a held request took the lock again) | ok |
| Ablation: product files reverted to parent, tests kept | both new tests fail |
| Ablation: fix restored | both pass |
| internal/provider full suite (`-tags nogui`) | ok |
| internal/gateway full suite (`-tags nogui`) | ok |
| `go test -race` full internal/provider | TestPluginCheckinAsksAgainAtUntil fails, and TestSignInDoneOnceTheAccountIsBack failed in one of two runs: both race in the tests' own fake-server closures on the unpatched parent too (stacks name no product frame), left as they are |
| `gofmt -l`, `go vet`, `go build ./...` | clean |

TestKeepLoginAsChosen, whose fake-server closure read a plain map the test wrote later, raced under `-race` on this branch's timing (the unpatched parent passed five straight runs); the patch guards that map with a mutex, included above.

## Siblings read, none changed

- `Logins`/`AlsoOn` callers on the request path (gateway/fallback.go perKeyEvery, codex_backend, codex_search, native_compaction, video, cap_careful; agent/route.go OwnPaused; the GUI's provider pages): unchanged, they go through the same held list and inherit the single build.
- Other `heldOf` consumers (provider.go "all", models.go, group.go, disabled.go, groupeffort.go, plugins.go, migrate.go): unchanged; the same one-build-per-miss now covers their concurrent misses. A builder returns what it built, so none of them builds twice where it built once before.
- Writers (`writeLogins`, `Changed`, `dropHeld`): unchanged; a write still drops what is held, and the next list is built again from the files.
- Failure semantics: builds still answer what the files say now (an empty list, `false`); nothing reads a half-built value.

Hot-path cost: a held hit takes the held lock once and answers from the map, as before; a miss adds one small allocation and two map steps under the lock, and the last per-request lock (`OwnPaused`) is gone from the plan. Waiters wait one build, which is what the fix buys; the wait is bounded by the build's own duration.

## Not verified

- Not reproduced against a live gateway under parallel Claude Code load (the reporter's environment); the convoy is pinned by the concurrent-miss test, not by a 30s-scale reproduction.
- The settings-mutex face of the dump (21 goroutines on `appdir.JoinFile`) predates `15066f84f`, which joins a folder and file name once; not re-measured here.
- Cross-magpie contention (two magpies holding `logins.json`'s lock across processes) still waits up to `filelock.Wait` (10s); unchanged by this patch.

Branch with the commit: https://github.com/ggbdpq/magpie/tree/fix/5104-login-lock-convoy (head cd03628797f071831e6433edc48140087fe5969c)

AI use: written by GLM-5.3-Flash (ZCode) from a trace of the held dump's call chains; please keep the author (ggbdpq) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
