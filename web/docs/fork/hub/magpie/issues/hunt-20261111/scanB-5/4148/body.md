Verification refresh — @pintaste's fix (author unchanged) rebased onto current main `60559ee73`, zero conflicts. Branch head `3f523527e`; the diff differs from the previous carrier only in one hunk line number (`internal/gui/api.go` moved by upstream commits, none of the 29 touching the CompactAt handler area). Main has since moved twice more; nothing lands in the four files this fix touches, so it `git am`s cleanly onto the current tip too.

Re-run on the new base:
- `TestCompactAtTooSmallIsRefused`, `TestSetCompactAt` (provider), `TestCompactAtTooSmallLeavesFullWindow` (gui) — green.
- Targeted `-race` on the same set — green.
- Whole `internal/provider` (236.2s) and `internal/gui` (339.7s): failures only, all red on the unbumped parent as well (`TestAddSameKeyOtherFormat`, `TestQuotaSpanCarriesEveryWindowField`, `TestKeptQuotaReportAsksNobody`, `TestProxyCheckSaysAProxyPassedBy`, `TestSessionReadsRoutes`, `TestPanelHiddenByWailsMarksPageOutOfSight`) — baseline reds upstream has since fixed in `7e8214d60`, or known ones; zero new failures from this fix.
- `gofmt -l` clean, `go vet` clean; `GOOS=linux` (tags nogui) and `GOOS=windows` builds — ok.

Ablation re-done on the new base: the `CheckCompactAt` gate disabled (`case n > 0 && n < catalog.LeastWindow:` → never matches, a too-small threshold accepted again) turns both new tests red — `TestCompactAtTooSmallIsRefused` and `TestCompactAtTooSmallLeavesFullWindow`; restored, green again.

Fresh patch: `git am` ready, sha256[:16]=`ad0a14e007e4f93f`; branch: [hunt-20261111-sb5](https://github.com/ggbdpq/magpie/tree/hunt-20261111-sb5) (head `3f523527e`).

The 11-04 verification verdict stands on the new base. Not run: the GUI Playwright suite (no asset changed), the real app.

**Attribution**: the fix is @pintaste's — please keep the author (`pintaste`) or add `Co-authored-by` for them; the rebase carrier and re-verification were done by me with GLM-5.3-Flash (ZCode), and I've read the whole diff.

**Patch**: <details><summary>patch: settings: Compact at refuses a size too small to hold an agent's system prompt (carrier for @pintaste's fix, #4148) — git am applies it as is; SHA-256 first 16: ad0a14e007e4f93f</summary>

```
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
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
index 06da67b7a..a92e2103d 100644
--- a/internal/gui/api.go
+++ b/internal/gui/api.go
@@ -1889,6 +1889,13 @@ func Handler(w Windows, gw *gateway.Server) http.Handler {
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
index cbbc3813f..4dda5b9d4 100644
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
