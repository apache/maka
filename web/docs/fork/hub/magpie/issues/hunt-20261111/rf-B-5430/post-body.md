Refreshed on current `main` (`6a3f162f0`) — refreshed, not redesigned: same change as before, cherry-picked clean.

**Red without the fix** (bare base + the tests from this branch): ten concurrent Desktop titles while the catalog verdict runs — the lock still held:

```
--- FAIL: TestDesktopPickedLockKeepsCatalogWorkOut
    10 concurrent titles took 634.30325ms: the catalog work still holds desktopPicked's lock
```

(TestClaudeScienceTurn is protective: green before the fix too, pinning the science turn's pick behaviour as the scope narrows.)

With the fix: `ok`; the same ten titles clear while the verdict runs.

**Verification** (all on `6a3f162f0`, darwin/arm64):
| What | Result |
| --- | --- |
| `go test ./internal/gateway -run 'TestClaudeScienceTurn|TestDesktopPickedLockKeepsCatalogWorkOut'` | ok 1.2s |
| full `go test -timeout 25m ./internal/gateway` | ok 936.8s, zero failures |
| `go test -race` (both tests, `-count=2`) | ok 14.7s |
| `gofmt` / `go vet` | clean |
| ablation (the lock-narrowing hunks reverse-applied, tests kept) | red again (`…the catalog work still holds desktopPicked's lock`); restored, green |
| `git am` on detached `6a3f162f0^` | applies as is; tree identical to the branch head |

**Siblings**: `desktopPicked` is read and written only inside `desktop.go` (`loadPicked` under the lock, `desktopMoveTo`'s two spans); `sciencePicked` only inside `science.go`'s `scienceTurn` — both rewritten alike: the picked fields under the lock, the catalog verdict beside it, the write briefly under it. Each turn has one caller (`gateway.go:2537`, `desktop.go:603`).

**Branch with the commit**: [hunt-20261111-rf-5430](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5430) (head `f46c7380dfc1527e`).

**Not verified**: the reporter's Windows box (their verification of both halves at #5430 stands in the record; this refresh adds no platform leg).

**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Patch**: <details><summary>patch: gateway: desktopTurn's catalog work queues no more on the picked model's lock (#5430) — git am applies it as is; SHA-256 first 16: 62cdbf38db23be33</summary>

```patch
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 8 Nov 2026 23:03:41 +0800
Subject: [PATCH] gateway: desktopTurn's catalog work queues no more on the
 picked model's lock
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

A Claude Desktop request's verdict (desktopTurn, the picked model it
serves a turn on) read the catalog under desktopPicked's lock: the
tiers' picks (a file read and parsed per ask), unserved and
servedBeside and claudeOwnID (a catalog rebuilt per ask), desktopDefault
(the list to Desktop, and the stand-in), and a turn's write of the pick
to disk. Concurrent Desktop requests queued behind all of it — held for
30s "in no wait magpie knows of", claude-desktop alone (#5430,
dongsheng123132). The lock keeps the picked fields alone now; the
catalog's work reads beside it, and the write takes the lock briefly,
to keep the fields and the file one.

Claude Science's pick (scienceTurn) is the same shape and steps out
with it.

Tests: TestDesktopPickedLockKeepsCatalogWorkOut (ten concurrent titles
against a stand-in asleep 60ms: 624ms serialized before, 0.1s after)
fails without the change; TestClaudeScienceTurn notes scienceTurn's
verdict, which no test held before.

Attribution: 分析与补丁由 GLM-5.3-Flash (ZCode) 协助完成
Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/gateway/desktop.go                  | 12 +++-
 internal/gateway/desktop_picked_lock_test.go | 65 ++++++++++++++++++++
 internal/gateway/science.go                  |  8 ++-
 internal/gateway/science_turn_test.go        | 58 +++++++++++++++++
 4 files changed, 141 insertions(+), 2 deletions(-)
 create mode 100644 internal/gateway/desktop_picked_lock_test.go
 create mode 100644 internal/gateway/science_turn_test.go

diff --git a/internal/gateway/desktop.go b/internal/gateway/desktop.go
index a956c06b5..3bc0e6475 100644
--- a/internal/gateway/desktop.go
+++ b/internal/gateway/desktop.go
@@ -630,7 +630,6 @@ func desktopMoveTo(asked string, body []byte, byClaudeCode, bySubagent bool) (st
 	}
 	tools := hasTools(body)
 	desktopPicked.Lock()
-	defer desktopPicked.Unlock()
 	loadPicked()
 	picked := desktopPicked.model
 	if asked == picked {
@@ -638,8 +637,17 @@ func desktopMoveTo(asked string, body []byte, byClaudeCode, bySubagent bool) (st
 			// the session goes on on it: newer than a menu changed meanwhile
 			desktopPicked.at = time.Now()
 		}
+		desktopPicked.Unlock()
 		return asked, ""
 	}
+	desktopPicked.Unlock()
+	// The picked fields are all desktopPicked's lock keeps. The ask's
+	// verdict below reads the catalog (the tiers' picks, unserved,
+	// servedBeside, desktopDefault) and a turn's write goes to disk, and
+	// either of those under the lock held every other Desktop request
+	// behind it — 30s of held with no wait magpie knows of (#5430). They
+	// run beside the lock now; the write takes it briefly, to keep the
+	// fields and the file one.
 	aside := small(body)
 	if byClaudeCode {
 		aside = desktopTitle(body)
@@ -685,10 +693,12 @@ func desktopMoveTo(asked string, body []byte, byClaudeCode, bySubagent bool) (st
 		return asked, ""
 	}
 	if tools && !bySubagent {
+		desktopPicked.Lock()
 		desktopPicked.model, desktopPicked.at = asked, time.Now()
 		if os.MkdirAll(settings.Dir(), 0o755) == nil {
 			os.WriteFile(desktopPickedPath(), []byte(asked+"\n"), 0o600)
 		}
+		desktopPicked.Unlock()
 	}
 	return asked, ""
 }
diff --git a/internal/gateway/desktop_picked_lock_test.go b/internal/gateway/desktop_picked_lock_test.go
new file mode 100644
index 000000000..20094f465
--- /dev/null
+++ b/internal/gateway/desktop_picked_lock_test.go
@@ -0,0 +1,65 @@
+package gateway
+
+import (
+	"sync"
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// #5430 (dongsheng123132): desktopMoveTo's catalog work — desktopDefault's
+// stand-in here, asleep for 60ms — ran under desktopPicked's lock, so
+// concurrent Desktop requests were served one by one ("held Ns, 30s of it
+// in no wait magpie knows of"). The lock keeps the picked fields alone
+// now: the sleeps overlap and the requests don't queue.
+func TestDesktopPickedLockKeepsCatalogWorkOut(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	desktopPicked.Lock()
+	desktopPicked.model, desktopPicked.from, desktopPicked.at = "", "", time.Time{}
+	desktopPicked.Unlock()
+	t.Cleanup(func() {
+		desktopPicked.Lock()
+		desktopPicked.model, desktopPicked.from, desktopPicked.at = "", "", time.Time{}
+		desktopPicked.Unlock()
+	})
+	if err := provider.Save(provider.Provider{ID: "fake", Name: "Fake", Key: "k", Anthropic: "http://127.0.0.1:1",
+		Models: []string{"m1", "claude-opus-4-8"}}); err != nil {
+		t.Fatal(err)
+	}
+	StandIn = func(agent, model string) string {
+		if agent == "claude-desktop" {
+			time.Sleep(60 * time.Millisecond) // the catalog's work, as a stand-in
+			return "fake/m1"
+		}
+		return ""
+	}
+	t.Cleanup(func() { StandIn = nil })
+	title := []byte(`{"max_tokens":200,"messages":[{"role":"user","content":"hi"}]}`)
+	const n = 10
+	bad := make(chan string, 1)
+	var wg sync.WaitGroup
+	start := time.Now()
+	for i := 0; i < n; i++ {
+		wg.Add(1)
+		go func() {
+			defer wg.Done()
+			if got := desktopTurn("claude-haiku-4-5", title, false, false); got != "fake/m1" {
+				bad <- got
+			}
+		}()
+	}
+	wg.Wait()
+	took := time.Since(start)
+	select {
+	case got := <-bad:
+		t.Fatalf("title = %q, want fake/m1", got)
+	default:
+	}
+	// serialized, the ten 60ms reads stack to ~600ms; beside the lock they
+	// overlap to about one
+	if took > 300*time.Millisecond {
+		t.Fatalf("%d concurrent titles took %s: the catalog work still holds desktopPicked's lock", n, took)
+	}
+}
diff --git a/internal/gateway/science.go b/internal/gateway/science.go
index a641f8a49..f29ab8006 100644
--- a/internal/gateway/science.go
+++ b/internal/gateway/science.go
@@ -108,12 +108,16 @@ func sciencePickedPath() string { return filepath.Join(settings.Dir(), "claude-s
 // to it.
 func scienceTurn(asked string, body []byte) string {
 	sciencePicked.Lock()
-	defer sciencePicked.Unlock()
 	if path := sciencePickedPath(); sciencePicked.from != path {
 		b, _ := os.ReadFile(path)
 		sciencePicked.model, sciencePicked.from = strings.TrimSpace(string(b)), path
 	}
 	picked := sciencePicked.model
+	sciencePicked.Unlock()
+	// as desktopTurn's (#5430): the verdict reads the catalog (unserved,
+	// the list to Science) beside the lock, which keeps the picked fields
+	// alone; a turn's write takes it briefly, to keep the field and the
+	// file one
 	if unserved(asked) {
 		if picked != "" && !unserved(picked) {
 			return picked
@@ -124,10 +128,12 @@ func scienceTurn(asked string, body []byte) string {
 		return asked
 	}
 	if asked != picked && hasTools(body) {
+		sciencePicked.Lock()
 		sciencePicked.model = asked
 		if os.MkdirAll(settings.Dir(), 0o755) == nil {
 			os.WriteFile(sciencePickedPath(), []byte(asked+"\n"), 0o600)
 		}
+		sciencePicked.Unlock()
 	}
 	return asked
 }
diff --git a/internal/gateway/science_turn_test.go b/internal/gateway/science_turn_test.go
new file mode 100644
index 000000000..6b3ef851c
--- /dev/null
+++ b/internal/gateway/science_turn_test.go
@@ -0,0 +1,58 @@
+package gateway
+
+import (
+	"os"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/provider"
+)
+
+// scienceTurn's verdict: nothing picked, an unserved ask goes to the first
+// model listed to Science; a turn notes its model, kept on disk; an
+// unserved ask then goes to the session's model; a served ask is as asked.
+func TestClaudeScienceTurn(t *testing.T) {
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t.Setenv("XDG_CACHE_HOME", t.TempDir())
+	sciencePicked.Lock()
+	sciencePicked.model, sciencePicked.from = "", ""
+	sciencePicked.Unlock()
+	t.Cleanup(func() {
+		sciencePicked.Lock()
+		sciencePicked.model, sciencePicked.from = "", ""
+		sciencePicked.Unlock()
+	})
+	if err := provider.Save(provider.Provider{ID: "fake", Name: "Fake", Key: "k", Anthropic: "http://127.0.0.1:1",
+		Models: []string{"m1", "claude-opus-4-8"}}); err != nil {
+		t.Fatal(err)
+	}
+	turn := []byte(`{"max_tokens":32000,"tools":[{"name":"Bash"}],"messages":[{"role":"user","content":"hi"}]}`)
+	title := []byte(`{"max_tokens":200,"messages":[{"role":"user","content":"hi"}]}`)
+	if got := scienceTurn("gpt-9", title); got != "fake/m1" {
+		t.Fatalf("unserved with nothing picked = %q, want fake/m1", got)
+	}
+	if _, err := os.Stat(sciencePickedPath()); err == nil {
+		t.Fatal("an unserved ask picked a model")
+	}
+	if got := scienceTurn("fake/m1", turn); got != "fake/m1" {
+		t.Fatalf("turn = %q, want fake/m1", got)
+	}
+	if b, err := os.ReadFile(sciencePickedPath()); err != nil || strings.TrimSpace(string(b)) != "fake/m1" {
+		t.Fatalf("picked %q (%v), want fake/m1", b, err)
+	}
+	if got := scienceTurn("gpt-9", title); got != "fake/m1" {
+		t.Fatalf("unserved after a turn = %q, want the session's fake/m1", got)
+	}
+	if got := scienceTurn("fake/claude-opus-4-8", title); got != "fake/claude-opus-4-8" {
+		t.Fatalf("served ask = %q, want it as asked", got)
+	}
+	if b, _ := os.ReadFile(sciencePickedPath()); strings.TrimSpace(string(b)) != "fake/m1" {
+		t.Fatalf("a title for a served ask kept %q", b)
+	}
+	if got := scienceTurn("fake/claude-opus-4-8", turn); got != "fake/claude-opus-4-8" {
+		t.Fatalf("turn on opus = %q, want fake/claude-opus-4-8", got)
+	}
+	if b, _ := os.ReadFile(sciencePickedPath()); strings.TrimSpace(string(b)) != "fake/claude-opus-4-8" {
+		t.Fatalf("kept %q, want fake/claude-opus-4-8", b)
+	}
+}
-- 
2.50.1 (Apple Git-155)

```
</details>
