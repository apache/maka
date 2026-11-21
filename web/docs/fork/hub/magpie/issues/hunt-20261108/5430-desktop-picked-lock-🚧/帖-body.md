@yetone @dongsheng123132 has pinpointed a third way into #5430's convoy, on macOS and confined to `agent == "claude-desktop"`: the same "held Ns, 30s of it in no wait magpie knows of" dumps, while dsh, hermes, codex and terminal Claude Code on the same machine show none — "a second way into the same convoy", as the comment puts it. Yesterday's patch ([above](https://github.com/yetone/magpie/issues/5430#issuecomment-6711388405)) took the two `logins.json` halves off @yunwang2442-creator's list; this one takes the path the held dump points at now — `desktopPicked`'s lock, which one Desktop request's whole verdict holds across, catalog reads included.

**Root cause**: `desktopMoveTo` (internal/gateway/desktop.go:631 at v0.1.3335) took `desktopPicked`'s mutex and kept it until the verdict was in: the tiers' pick file read and JSON-parsed on the way (`desktopTierAsked`, and `DesktopTiers()` again on the elsewhere path — a file read each time), `unserved` (the catalog's names, then `provider.Find`), `claudeOwnID` and `servedBeside` (each rebuilding `provider.Catalog()`), `desktopDefault` (the list shown to Desktop, and the agent's stand-in), and, when a turn changes the pick, its write to disk (`os.MkdirAll` + `os.WriteFile`). Every concurrent Desktop request queued behind all of that on one lock — held time the watchdog sees with no wait it knows of.

**The fix**: the lock keeps the picked fields alone: the short take loads the pick (its cold file read stays there — it happens once, cached by the file it came from) and snapshots it, and the verdict reads the catalog beside the lock. A turn's write takes the lock briefly around the fields and the file together, so memory and disk stay one; it runs only when a turn changes the pick, not per request. Locks guard shared fields; disk and catalog work belongs beside them — the same discipline as yesterday's counter made atomic. Claude Science's pick (`scienceTurn`, internal/gateway/science.go:109) is the same shape, found in the same sweep, and steps out with it.

<details><summary>patch: gateway: desktopTurn's catalog work queues no more on the picked model's lock — git am applies it as is; SHA-256 first 16: ef58c55adea190f1; also as [`​.patch`](https://github.com/ggbdpq/magpie/commit/fcfb6c3326d5b18b450d93661308d9a8c25346b2.patch)</summary>

```text
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
index 26296507b..54656a5b8 100644
--- a/internal/gateway/desktop.go
+++ b/internal/gateway/desktop.go
@@ -629,7 +629,6 @@ func desktopMoveTo(asked string, body []byte, byClaudeCode, bySubagent bool) (st
 	}
 	tools := hasTools(body)
 	desktopPicked.Lock()
-	defer desktopPicked.Unlock()
 	loadPicked()
 	picked := desktopPicked.model
 	if asked == picked {
@@ -637,8 +636,17 @@ func desktopMoveTo(asked string, body []byte, byClaudeCode, bySubagent bool) (st
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
@@ -684,10 +692,12 @@ func desktopMoveTo(asked string, body []byte, byClaudeCode, bySubagent bool) (st
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
index 539ffeb86..cca04e50c 100644
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

**Branch with the commit**: [`fix/5430-desktop-picked-lock-scope`](https://github.com/ggbdpq/magpie/tree/fix/5430-desktop-picked-lock-scope) (head `fcfb6c3326d5b18b450d93661308d9a8c25346b2`), rebased onto current `upstream/main` (`c6bdc172a`); on a fresh checkout `git am` applies clean (the ammed tree is identical to the branch's).

| Check | Result |
| --- | --- |
| `TestDesktopPickedLockKeepsCatalogWorkOut` (new) | red before the fix (ten concurrent titles against a stand-in asleep 60ms took 624ms, the sleeps stacked one behind another), pass after (0.1s, the sleeps overlap) |
| `TestClaudeScienceTurn` (new) | pass (scienceTurn's verdict held no test before; the write-back asserted through the pick file's contents) |
| `TestClaudeDesktopAuxiliaryModel`, `TestClaudeDesktopDefault`, `TestClaudeDesktopClassifierKeepsItsModel`, `TestDesktopTitle`, `TestDesktopSubagentTurnKeepsSessionPick`, `TestDesktopSubagentTurnLeavesTitleOnLead`, the `desktop_tier`/`desktop_probe`/`desktop_moved_why` families | pass (the subagent and auxiliary tests assert the pick file's contents: the write-back branch's behavior unchanged) |
| `go test ./internal/gateway/ -tags nogui -timeout 25m -count=1` | ok (761.7s on the rebased tree, zero failures) |
| `go test -tags nogui ./...` | every package ok but three, all this machine's, not the patch's: `TestMothX` (internal/agent), `TestProxyCheckSaysAProxyPassedBy` (internal/gui) and `TestHostToldTheGatewayAddress` (internal/plugin) fail identically on the parent commit `c6bdc172a`; `TestGatewayModeStatsNameTheGatewaySessions` (internal/gui) failed once under the full run's load and passes alone on both the branch's tree and the parent's |
| `go test ./internal/gateway/ -run 'Desktop|Science' -race -count=1` | pass (8.7s) |
| `go test ./internal/gateway/ -race -timeout 30m -count=1` | ok (1455.3s), zero failures |
| `gofmt -l` changed files | prints nothing |
| `go vet ./...` (darwin); same with `GOOS=linux -tags nogui` and `GOOS=windows` | clean |
| `go build ./...` (darwin); `GOOS=linux go build -tags nogui ./...`; `GOOS=windows go build ./...` | clean |
| Ablation | putting `desktopDefault`'s catalog read back under the lock turns `TestDesktopPickedLockKeepsCatalogWorkOut` red again (615ms, the same stacking); restored, green |
| Re-verified on upstream/main `c6bdc172a` | rebased from `7a56c83e7` (commit unchanged: the patch's bytes are identical, SHA-256 as above); the new tests, the desktop/science families and this table's package runs re-done on the rebased tree |

**Not verified**: the real machine's face stays with @dongsheng123132 — macOS Claude Desktop, its `claude-desktop` agent and the 30s held dumps themselves (NOT-RUNNABLE here); what is reproduced is the lock-contention shape at the unit layer, serialized before the change, parallel after, red again under ablation. `scienceTurn` has no stand-in seam to slow it, so its narrowing rides the desktop shape's timing proof, its own verdict test and the families' green, not a timing test of its own. Same-family sites the sweep found, left as they are, none showing the convoy shape: `stickOf`/`checkpointFor` (cold file reads cached by path+mtime under the shared locks — one `os.Stat` per ask, the same shape `loadPicked` keeps), `saveSticks`/`saveCheckpoints`/`writeHeld`/`saveRoute` (save-path locks whose job is serializing the writes themselves, off the routing decision path), `DiskArchive.added` (local archive pruning), the WSL key's one-time make (Windows-only), and `pmu`'s `json.Unmarshal` (in-memory bytes, no I/O).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
