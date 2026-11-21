Verified the fix pintaste filed here (patch on their fork branch [`fix/4148-compact-at-min`](https://github.com/pintaste/magpie/tree/fix/4148-compact-at-min), commit 49cfa9e9, one commit on 85e37162), on macOS arm64, go1.25.5, upstream/main 43849d51.

**What's wrong**

As thedavidweng reported: "Compact at" takes sizes like `400k`, but a bare `400` is parsed as 400 tokens and saved as `"compactAt": 400`, and the agents' compaction window is written through as 400 — so Codex and Claude Code compact on every turn and burn the 5h limit in minutes. With `compact.go` and `api.go` at main I get the same: `SetCompactAt(400)` and a provider's `*:400` are accepted, and `POST /api/settings/full-context` with `{"on":false,"at":400}` answers 200 and saves `compactAt:400`.

**Root cause** (pintaste's read, confirmed)

`ParseTokens` reads the bare number correctly; the guard is missing downstream. `provider.SetCompactAt` (Settings → Compact at, `magpie model compact <size>`, tune's Long conversations) and `provider.SetModelCompacts` (a provider's own Compact at) refused only negative numbers, so 400 — or any value that cannot hold an agent's system prompt — was silently persisted and then told to the agents as the model's window.

**The fix**

- New `provider.CheckCompactAt(n)`: 0 (unset) passes, anything ≥ 2048 passes, negatives keep their old error; 1..2047 is refused with the size the user probably meant named ("…at least 2048, or 400k for 400K"). The floor is `catalog.LeastWindow`, the one magpie already uses for a vendor-listed window too small to take at its word, so there is a single policy number.
- Both doors the report names are covered: the global threshold (`SetCompactAt`) and a provider's own per-model thresholds (`SetModelCompacts`, the `*` form included). A value already saved below the floor and sent back unchanged stays, as #3305 keeps an unlisted model — nothing saved is rewritten. `POST /api/settings/full-context` checks `at` before `SetFullContext`, so a refused save leaves Full window as it was.
- On over-strictness: real chat models' windows start around 4096 (`LeastWindow`'s comment), magpie's own callers pass at least 120000 (`settings.WorkingWindow` is 272000), and internal tune values go no lower than 120000 — nothing legitimate sits between 1 and 2047, and 0 still means "unset".
- The GUI needs no change: the server's error reaches the status line through the existing `prefWrite` path.

<details><summary>patch: fix/4148-compact-at-min-verify (#4148) — git am applies it as is; SHA-256 first 16: 9cffa892037b7115</summary>

```patch
From a4478a80ea8a5b3b77d4aa4627c7556745ce8355 Mon Sep 17 00:00:00 2001
From: pintaste <7534292+pintaste@users.noreply.github.com>
Date: Thu, 29 Oct 2026 01:49:56 -0700
Subject: [PATCH] settings: Compact at refuses a size too small to hold an
 agent's system prompt (#4148)

400 typed for 400K was saved as 400 tokens: Codex and Claude Code were
told a 400-token window, compacted on every turn and spent the 5h limit.
SetCompactAt (Settings' Compact at, magpie model compact) and
SetModelCompacts (a provider's Compact at) refused only negatives.

CheckCompactAt now refuses 1..catalog.LeastWindow-1 (2048), the floor
magpie already uses for a window too small to hold an agent's system
prompt, and names the K size meant ("400k for 400K"). 0 and anything
from 2048 on are as before. A provider's or model's value saved below
the floor and sent back unchanged stays (as #3305 keeps an unlisted
model's), so nothing saved is rewritten. POST /api/settings/full-context
checks the size before SetFullContext, so a refused size leaves Full
window as it was.

Verified (macOS arm64, go1.26.8, sandbox HOME, pinned caches):
- TestCompactAtTooSmallIsRefused (provider) fails with compact.go and
  api.go from main: "SetCompactAt(400) was accepted",
  "SetModelCompacts(map[*:400]) was accepted", "a refused save changed
  them". TestCompactAtTooSmallLeavesFullWindow (gui) fails with
  "400: 200 ... compactAt:400"; with api.go alone from main, "a refused
  size changed the settings: full=false at=500000". Both pass with it.
- go test -tags nogui ./internal/provider ./internal/gui ./internal/agent
  ./internal/cli ./internal/settings: ok.
- gofmt -l clean; go vet ./...; GOOS=linux go vet -tags nogui ./...;
  GOOS=windows go vet ./...; go build; GOOS=linux go build -tags nogui;
  GOOS=windows go build: clean.
- go test -tags nogui ./... (whole suite): 77 packages ok; internal/gateway
  had TestUnroutedHeldReportSaved fail once under full-suite load. It
  passes alone -count=10 and -race -count=20 on this branch and on main;
  this change doesn't touch the gateway. Under go1.27.3 the gateway's
  TestMarshalRawIsEncodingJSON / FuzzMarshalRaw fail on main too (#3547).
Not run: the GUI Playwright suite (no asset changed); the real app.
---
 internal/gui/api.go                     |  7 +++
 internal/gui/compact_at_least_test.go   | 36 +++++++++++++
 internal/provider/compact.go            | 25 +++++++--
 internal/provider/compact_least_test.go | 67 +++++++++++++++++++++++++
 4 files changed, 131 insertions(+), 4 deletions(-)
 create mode 100644 internal/gui/compact_at_least_test.go
 create mode 100644 internal/provider/compact_least_test.go

diff --git a/internal/gui/api.go b/internal/gui/api.go
index 6df49e571..9ce32e43b 100644
--- a/internal/gui/api.go
+++ b/internal/gui/api.go
@@ -1653,6 +1653,13 @@ func Handler(w Windows, gw *gateway.Server) http.Handler {
 			fail(rw, err)
 			return
 		}
+		// a size that would be refused leaves Full window as it was
+		if !in.On && in.At != nil {
+			if err := provider.CheckCompactAt(*in.At); err != nil {
+				fail(rw, err)
+				return
+			}
+		}
 		err := provider.SetFullContext(in.On)
 		if err == nil && !in.On && in.At != nil {
 			err = provider.SetCompactAt(*in.At)
diff --git a/internal/gui/compact_at_least_test.go b/internal/gui/compact_at_least_test.go
new file mode 100644
index 000000000..bba467348
--- /dev/null
+++ b/internal/gui/compact_at_least_test.go
@@ -0,0 +1,36 @@
+package gui
+
+import (
+	"net/http"
+	"net/http/httptest"
+	"path/filepath"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/settings"
+)
+
+// Settings' Compact at refuses a size too small to hold an agent's system
+// prompt (#4148: 400 typed for 400K) before anything is saved: Full
+// window, on when the size was typed, stays on.
+func TestCompactAtTooSmallLeavesFullWindow(t *testing.T) {
+	h := t.TempDir()
+	t.Setenv("HOME", h)
+	t.Setenv("USERPROFILE", h)
+	t.Setenv("XDG_CONFIG_HOME", filepath.Join(h, ".config"))
+	t.Setenv("XDG_CACHE_HOME", filepath.Join(h, ".cache"))
+	if err := settings.Save(settings.Settings{FullContext: true, CompactAt: 500000}); err != nil {
+		t.Fatal(err)
+	}
+	srv := Handler(nil, nil)
+	rec := httptest.NewRecorder()
+	r := httptest.NewRequest("POST", "/api/settings/full-context", strings.NewReader(`{"on":false,"at":400}`))
+	r.RemoteAddr = "127.0.0.1:50000"
+	srv.ServeHTTP(rec, r)
+	if rec.Code == http.StatusOK || !strings.Contains(rec.Body.String(), "400k") {
+		t.Errorf("400: %d %.200s", rec.Code, rec.Body)
+	}
+	if s := settings.Load(); !s.FullContext || s.CompactAt != 500000 {
+		t.Errorf("a refused size changed the settings: full=%v at=%d", s.FullContext, s.CompactAt)
+	}
+}
diff --git a/internal/provider/compact.go b/internal/provider/compact.go
index 805764d29..c510c8f33 100644
--- a/internal/provider/compact.go
+++ b/internal/provider/compact.go
@@ -187,8 +187,10 @@ func SetModelCompacts(providerID string, cs map[string]int) error {
 	}
 	s := settings.Load()
 	for model, n := range cs {
-		if n < 0 {
-			return errorf("a compaction threshold is a number of tokens, not %d", n)
+		if s.ModelCompacts[p.ID+"/"+model] != n {
+			if err := CheckCompactAt(n); err != nil {
+				return err
+			}
 		}
 		if err := settings.CheckModelKey("a compaction threshold", p.ID+"/"+model); err != nil {
 			return err
@@ -263,12 +265,27 @@ func SetAgentCompact(agent string, c *settings.AgentCompact) error {
 	return nil
 }
 
+// CheckCompactAt says whether n can be a compaction threshold: 0 (none
+// set) or at least catalog.LeastWindow tokens. Less can't hold an agent's
+// system prompt, so Codex and Claude Code told it compact on every turn
+// and spend the account's limit doing it (#4148: 400 typed for 400K was
+// saved as 400 tokens). The error names the size n was likely meant as.
+func CheckCompactAt(n int) error {
+	switch {
+	case n < 0:
+		return errorf("a compaction threshold is a number of tokens, not %d", n)
+	case n > 0 && n < catalog.LeastWindow:
+		return errorf("a compaction threshold of %d tokens can't hold an agent's system prompt, so it would compact on every turn; at least %d, or %dk for %dK", n, catalog.LeastWindow, n, n)
+	}
+	return nil
+}
+
 // SetCompactAt has every model without a threshold of its own compacted at
 // n tokens, Full window turned off; 0 is the working window again
 // (settings.WorkingWindow).
 func SetCompactAt(n int) error {
-	if n < 0 {
-		return errorf("a compaction threshold is a number of tokens, not %d", n)
+	if err := CheckCompactAt(n); err != nil {
+		return err
 	}
 	s := settings.Load()
 	if n == settings.WorkingWindow {
diff --git a/internal/provider/compact_least_test.go b/internal/provider/compact_least_test.go
new file mode 100644
index 000000000..a2d471f0c
--- /dev/null
+++ b/internal/provider/compact_least_test.go
@@ -0,0 +1,67 @@
+package provider
+
+import (
+	"maps"
+	"strings"
+	"testing"
+
+	"github.com/yetone/magpie/internal/catalog"
+	"github.com/yetone/magpie/internal/settings"
+)
+
+// A threshold too small to hold an agent's system prompt (#4148: 400 typed
+// for 400K) is refused, for every model and for one provider's, with the
+// size it was probably meant as; what was saved stays, and catalog.LeastWindow
+// itself, the smallest window magpie takes a list at its word for, is
+// accepted. A small value saved before the floor and sent back as it is
+// stays, as a model the provider no longer lists does (#3305).
+func TestCompactAtTooSmallIsRefused(t *testing.T) {
+	limitsHome(t)
+	if err := settings.Save(settings.Settings{CompactAt: 500000}); err != nil {
+		t.Fatal(err)
+	}
+	for _, n := range []int{1, 400, catalog.LeastWindow - 1} {
+		err := SetCompactAt(n)
+		if err == nil {
+			t.Errorf("SetCompactAt(%d) was accepted", n)
+			continue
+		}
+		if n == 400 && !strings.Contains(err.Error(), "400k") {
+			t.Errorf("SetCompactAt(400): %q doesn't say 400k", err)
+		}
+	}
+	if s := settings.Load(); s.CompactAt != 500000 {
+		t.Errorf("a refused size changed it: %d", s.CompactAt)
+	}
+	if err := SetCompactAt(catalog.LeastWindow); err != nil || settings.Load().CompactAt != catalog.LeastWindow {
+		t.Errorf("SetCompactAt(LeastWindow): %v, saved %d", err, settings.Load().CompactAt)
+	}
+	if err := SetCompactAt(0); err != nil || settings.Load().CompactAt != 0 {
+		t.Errorf("0 (the working window): %v, saved %d", err, settings.Load().CompactAt)
+	}
+
+	if err := Save(Provider{ID: "deepseek", Name: "deepseek", Chat: "https://relay.example/v1", Key: "k", Models: []string{"deepseek-v4-flash"}}); err != nil {
+		t.Fatal(err)
+	}
+	if err := SetModelCompacts("deepseek", map[string]int{"*": 500000}); err != nil {
+		t.Fatal(err)
+	}
+	for _, cs := range []map[string]int{{"*": 400}, {"*": 500000, "deepseek-v4-flash": 400}} {
+		if err := SetModelCompacts("deepseek", cs); err == nil {
+			t.Errorf("SetModelCompacts(%v) was accepted", cs)
+		}
+	}
+	if got := settings.Load().ModelCompacts; !maps.Equal(got, map[string]int{"deepseek/*": 500000}) {
+		t.Errorf("a refused save changed them: %v", got)
+	}
+
+	// saved under an older magpie, then the editor saved with it unchanged
+	s := settings.Load()
+	s.ModelCompacts["deepseek/deepseek-v4-flash"] = 400
+	if err := settings.Save(s); err != nil {
+		t.Fatal(err)
+	}
+	if err := SetModelCompacts("deepseek", map[string]int{"*": 600000, "deepseek-v4-flash": 400}); err != nil {
+		t.Errorf("a small size sent back as it was: %v", err)
+	}
+}
-- 
2.50.1 (Apple Git-155)
```

</details>

**Verification**

Every check below I ran myself today on this machine (macOS arm64, go1.25.5, sandbox HOME, pinned caches); branch head a4478a80e is the patch rebased onto upstream/main 43849d51 with the author and message preserved, and the four files it touches are byte-identical to pintaste's commit.
| Check | Result |
|---|---|
| `TestCompactAtTooSmallIsRefused` (provider) with `compact.go`+`api.go` reverted to main, tests kept | FAIL as claimed: "SetCompactAt(400) was accepted", "SetModelCompacts(map[*:400]) was accepted", "a refused size changed it" |
| `TestCompactAtTooSmallLeavesFullWindow` (gui), same ablation | FAIL: `400: 200 … "compactAt":400`, "a refused size changed the settings: full=false at=400" |
| Both tests with the fix | pass |
| `TestSetCompactAt`, `TestModelCompactsSetFromTheEditor`, `TestSetAgentCompact` | pass |
| `go test -tags nogui -count=1 ./internal/provider ./internal/gui ./internal/cli ./internal/settings` (full packages) | ok |
| `go test -tags nogui -count=1 ./internal/agent` | `TestMothX` fails on plain main 43849d51 too — pre-existing, unrelated |
| `go test -tags nogui -count=1 ./internal/gui` full | `TestLaneLimitRoutes`, `TestProxyCheckSaysAProxyPassedBy` fail on plain main too — pre-existing, unrelated |
| `gofmt -l` on the four touched files | nothing |
| `go vet ./...`, `GOOS=linux go vet -tags nogui ./...`, `GOOS=windows go vet ./...` | clean |
| `go build ./...`, `GOOS=linux go build -tags nogui ./...`, `GOOS=windows go build ./...` | clean |

**Not verified**

The Playwright cjs suite (playwright is not installed in this sandbox; no asset changed anyway) and the real app.

**One sibling this commit cannot see**

Main gained per-agent Long conversations (3eb2bda4, `provider.SetAgentCompact`, `POST /api/settings/agent-compact`, `magpie model compact codex <size>`) after this branch was written. A probe on this branch shows `SetAgentCompact("codex", {At: 400})` is still accepted and saves 400 — the same shape as this report, for one agent's own window. The one-line change is the same guard in `SetAgentCompact`, with an unchanged saved value kept passing as in `SetModelCompacts`. I left it out: the commit is pintaste's, and the newer surface deserves its own look. @yetone this may be worth a follow-up either way.

**AI use**

The verification runs and this write-up were done with AI assistance (GLM-5.3-Flash via ZCode); posted by ggbdpq.

**Attribution**: patch by @pintaste (branch fix/4148-compact-at-min, commit 49cfa9e9), rebased and verified by me; credit for the report to @thedavidweng. I've read the whole diff and the tests pass. Please keep the author (pintaste) or add Co-authored-by: pintaste.

**Branch with the commit**: https://github.com/ggbdpq/magpie/tree/fix/4148-compact-at-min-verify (head a4478a80ea8a5b3b77d4aa4627c7556745ce8355).
