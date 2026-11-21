Confirmed — the report's diagnosis is exact, and the fix belongs on magpie's side, not in the plugin. `Aside` is declared as routing information only (QuotaWindow: "Aside when using it up doesn't stop the account"); the history gate wasn't supposed to key on it. The skip dates back to #651, and the pools' own exception (14e4d8040) freed only the row an Antigravity card shows, not every measured window — so the Cursor plugin's Weekly and Grok Bot (and Copilot's completions, and a Factory account's windows while it may spend extra) were measured but never sampled. `pointOf` has exactly one caller, `noteQuotaHistory`, so the gate was one condition.

The fix: `pointOf` now refuses only what has no share to tell — a window whose text alone is told (`Text`), an unlimited one, a family's, an unnamed one, a NaN reading — instead of `w.Aside && !w.PoolWindow()`. Every measured window keeps its line whether or not using it up stops the account; a pool's window needs no exception of its own; routing reads `Aside` exactly where it did, and nothing is set aside that wasn't.

One row would have turned into a fictitious point under the new condition, so the patch fixes it too: Factory's "Extra usage", a balance in cents with no share, stayed out before only because it was aside. It is `Text: true` now — its display alone, the same as Claude's row of the same name (`claudeOveragesWindow`). Without that, Factory accounts would have grown a flat "100% left" curve for a dollar figure.

Tests: `TestQuotaHistoryKeepsAsideReadings` builds the reported snapshot shape (Weekly 56.1% and Grok Bot used, both aside; On-demand `$0.00` text) and fails before the patch — `histories = []` — and passes after with the 43.90 left points; `TestFactoryExtraUsageIsTextAlone` pins the balance row out of the history; `TestQuotaHistoryKeepsAntigravityPools` now also expects the aside "Extra" window's line, which is the new rule's own doing, not a workaround.

One edge left deliberately open, for you to rule on: a plugin row set aside that tells no share at all (`TestPluginTextRowIsText`'s "Bare", pinned not-Text) would now keep a flat 100% line where `Aside` kept it out before. None of the plugins on record sends such a row — the Cursor plugin's aside rows all carry a real `used` (checked at 08ad5e39) — and the test pins those rows as not-Text, so I didn't re-flag them; marking them `Text` in `quotaOfPlugin` would close it if one ever shows up.

| Check | Result |
| --- | --- |
| `go test ./internal/provider -tags nogui -count=1` (full package, at 8835a061c, macOS arm64) | ok, 0 FAIL |
| Ablation: the two new tests with only the product files reverted to the parent | FAIL → pass again with the patch |
| `gofmt -l internal/provider` | clean |
| `go vet ./internal/provider`; `GOOS=linux` and `GOOS=windows` with `-tags nogui` | clean |
| Builds: darwin, `GOOS=windows`, `GOOS=linux -tags nogui` | ok |
| Plain `GOOS=linux` build without `-tags nogui` | fails in wails' GTK/cgo on this host, before reaching the changed files — not exercised |

Not verified against a real Cursor account (no Weekly/Grok Bot access here), and no GUI run: the card's curves look history lines up by window name (`quotaLines` in app.js skips only unlimited and family windows), so the new lines draw unmodified.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: provider: quota history draws measured windows set aside for routing (#4612) — git am applies it as is; SHA-256 first 16: ab280916bfb2c53a</summary>

```diff
From 8835a061cbf9acd57f9ef3c42eaf0757952171c4 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Sun, 1 Nov 2026 19:13:57 +0800
Subject: [PATCH] provider: quota history draws measured windows set aside for
 routing (#4612)
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit

chowyuan1314: the Cursor plugin marks its Weekly window aside when
on-demand or free credit can pay, and Grok Bot always — using them up
doesn't stop the account, so routing sets them behind — and both carry a
real percentage. pointOf refused every window set aside that wasn't a
pool's, so quota-history.json took no point for them and the card had no
curve, while the same account's Codex windows drew theirs. The aside
check predates the pools' (#651); the pools' own exception (14e4d8040)
freed only the row the card shows, not every measured window.

Aside is for routing, not history: what a window says is drawn
independently of whether using it up stops the account. pointOf now
refuses only what has no share to tell — a window whose text alone is
told (Text), an unlimited one, a family's, an unnamed one, a NaN — so a
pool's window needs no exception of its own and every measured aside
window keeps its line: the Cursor plugin's Weekly and Grok Bot, Copilot's
completions, a Factory account's windows read while it may spend extra.

Factory's "Extra usage" row, a balance in cents, told no share either and
stayed out only because it was aside; it is Text now, its display alone —
as Claude's row of the same name already is (claudeOveragesWindow).
Without it, the new condition would have drawn it as a fictitious 100%
left.

Routing reads Aside where it did; nothing is set aside that wasn't.

Run (at d1a94f579 + this change, macOS arm64):
- TestQuotaHistoryKeepsAsideReadings and TestFactoryExtraUsageIsTextAlone
  (new) fail before and pass after; TestQuotaHistoryKeepsAntigravityPools
  now also expects the aside "Extra" window's line, the new rule's own
  doing.
- go test ./internal/provider -tags nogui -count=1: ok.
- gofmt -l clean; go vet ./internal/provider, GOOS=linux and
  GOOS=windows (nogui) clean; builds darwin, linux, windows ok.

Fixes #4612

Generated-by: GLM-5.3-Flash (ZCode)
---
 docs/subsystems/providers-accounts.md         |  5 +-
 internal/provider/factory_usage.go            |  5 +-
 internal/provider/quota_history.go            | 16 +++--
 internal/provider/quota_history_aside_test.go | 64 +++++++++++++++++++
 internal/provider/quota_history_test.go       | 10 ++-
 5 files changed, 89 insertions(+), 11 deletions(-)
 create mode 100644 internal/provider/quota_history_aside_test.go

diff --git a/docs/subsystems/providers-accounts.md b/docs/subsystems/providers-accounts.md
index 94168d6df..352e0ca44 100644
--- a/docs/subsystems/providers-accounts.md
+++ b/docs/subsystems/providers-accounts.md
@@ -251,7 +251,10 @@ the gateway report. [`quota_last.go`](../../internal/provider/quota_last.go),
 Allowance readings are kept by provider, lowercased account and window in
 `quota-history.json` ([`quota_history.go`](../../internal/provider/quota_history.go)),
 for up to 45 days and 6000 points per window. Failed or stale readings add
-nothing. `newCycle` preserves a boundary when the previous deadline passes,
+nothing. A window set aside for routing is kept when it is measured (a
+pool's window, or the Cursor plugin's Weekly and Grok Bot, #4612); a
+text-only one tells no share and is not. `newCycle` preserves a boundary
+when the previous deadline passes,
 appears/disappears, moves backward by more than five minutes or forward by
 more than the elapsed sampling time plus five minutes. A refill of more
 than five percentage points with a deadline unchanged within five minutes
diff --git a/internal/provider/factory_usage.go b/internal/provider/factory_usage.go
index bc13aca12..0703a1ea8 100644
--- a/internal/provider/factory_usage.go
+++ b/internal/provider/factory_usage.go
@@ -92,7 +92,10 @@ func factoryQuota(l factoryLimits) []QuotaWindow {
 	add(l.Limits.Standard, "", false)
 	add(l.Limits.Core, "Droid Core · ", true)
 	if l.Extra != nil && *l.Extra > 0 {
-		out = append(out, QuotaWindow{Name: "Extra usage", Display: fmt.Sprintf("$%.2f", *l.Extra/100), Aside: true})
+		// a balance in cents, its display alone: no share, as Claude's
+		// "Extra usage" row is (claudeOveragesWindow), and no history
+		// point of a fictitious 100% left (#4612)
+		out = append(out, QuotaWindow{Name: "Extra usage", Display: fmt.Sprintf("$%.2f", *l.Extra/100), Aside: true, Text: true})
 	}
 	return out
 }
diff --git a/internal/provider/quota_history.go b/internal/provider/quota_history.go
index 479aa04cf..b02cde3ef 100644
--- a/internal/provider/quota_history.go
+++ b/internal/provider/quota_history.go
@@ -10,7 +10,8 @@ package provider
 // Kept in quota-history.json, by provider and account name, and by window:
 // the figures only — no token, no prompt, nothing else of the vendor's. A
 // reading kept from before (AsOf) or failed isn't a new one; a window with no
-// limit, or one set aside, has nothing to draw. Points come at least
+// limit, or one told as its text alone, has nothing to draw — aside is for
+// routing. Points come at least
 // quotaHistGap apart within a cycle (a nearer one moves the last instead),
 // and a run of the same figure is its first and last point only. A cycle
 // ends where the window starts again: its reset passed, or moved further
@@ -219,12 +220,15 @@ func newCycle(a, b QuotaPoint) bool {
 }
 
 // pointOf is what w, read at at, says, if it is something to draw; a
-// reset told in seconds counts from now, when the windows were made. A
-// pool's window is drawn though it is aside for routing: it is the row
-// the card shows, where its models' own windows are not (max2020 on
-// Discord: an Antigravity card had no curve and no "runs out" line).
+// reset told in seconds counts from now, when the windows were made.
+// Aside is for routing, not history: a measured window is drawn though
+// using it up wouldn't stop the account, as a pool's window always was
+// (max2020 on Discord: an Antigravity card had no curve and no "runs
+// out" line; chowyuan1314, #4612: the Cursor plugin's Weekly and Grok
+// Bot are aside and had no curve). A window told as its text alone has
+// no share to draw.
 func pointOf(w QuotaWindow, at, now time.Time) (QuotaPoint, bool) {
-	if w.Unlimited || w.Aside && !w.PoolWindow() || w.Family != "" || w.Name == "" || math.IsNaN(w.Used) {
+	if w.Unlimited || w.Text || w.Family != "" || w.Name == "" || math.IsNaN(w.Used) {
 		return QuotaPoint{}, false
 	}
 	p := QuotaPoint{At: at.UTC().Truncate(time.Second), Left: math.Round(max(0, min(100, 100-w.Used))*100) / 100}
diff --git a/internal/provider/quota_history_aside_test.go b/internal/provider/quota_history_aside_test.go
new file mode 100644
index 000000000..963592c48
--- /dev/null
+++ b/internal/provider/quota_history_aside_test.go
@@ -0,0 +1,64 @@
+package provider
+
+import (
+	"testing"
+	"time"
+
+	"github.com/yetone/magpie/internal/testenv"
+)
+
+// Aside is routing: using the window up doesn't stop the account, which is
+// the Cursor plugin's word for its Weekly window when on-demand or free
+// credit can pay, and for Grok Bot always (chowyuan1314, #4612). The
+// readings are real, so they keep their history line as any measured
+// window's, as a pool's window already does; one whose display alone is
+// told has no share and keeps none.
+func TestQuotaHistoryKeepsAsideReadings(t *testing.T) {
+	testenv.SetHome(t, t.TempDir())
+	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
+	t0 := time.Date(2026, 10, 31, 16, 51, 12, 0, time.UTC)
+	reset := t0.Add(4 * 24 * time.Hour)
+	card := func(used float64) []SubscriptionQuota {
+		return []SubscriptionQuota{{Provider: "cursor", Name: "Cursor", User: "c@x.com", Windows: []QuotaWindow{
+			{Name: "Weekly", Used: used, ResetsAt: &reset, Span: 7 * 24 * time.Hour, Aside: true},
+			{Name: "Grok Bot", Used: used, ResetsAt: &reset, Span: 7 * 24 * time.Hour, Aside: true},
+			{Name: "On-demand", Used: 0, Display: "$0.00", ResetsAt: &reset, Text: true, Aside: true},
+		}}}
+	}
+	noteQuotaHistory(card(56.1), t0)
+	noteQuotaHistory(card(70), t0.Add(time.Hour))
+	hs := QuotaHistories(t0.Add(-time.Hour), "", "")
+	if len(hs) != 1 || len(hs[0].Lines) != 2 {
+		t.Fatalf("histories = %+v, want the Weekly and Grok Bot lines alone", hs)
+	}
+	for _, name := range []string{"Weekly", "Grok Bot"} {
+		pts := lineOf(t, hs, "c@x.com", name)
+		if len(pts) != 2 || pts[0].Left != 43.90 || pts[1].Left != 30 {
+			t.Errorf("%s = %+v, want the readings' points", name, pts)
+		}
+	}
+}
+
+// Factory's extra usage is a balance in cents: its row is its display
+// alone, as Claude's "Extra usage" row is, so it is Text and keeps no
+// history point of a fictitious 100% left (#4612).
+func TestFactoryExtraUsageIsTextAlone(t *testing.T) {
+	l := factoryLimits{}
+	l.ExtraAllowed = true
+	l.Extra = fptr(500)
+	var extra *QuotaWindow
+	for i, w := range factoryQuota(l) {
+		if w.Name == "Extra usage" {
+			extra = &factoryQuota(l)[i]
+		}
+	}
+	if extra == nil {
+		t.Fatal("no Extra usage window")
+	}
+	if !extra.Text || !extra.Aside {
+		t.Errorf("Extra usage: Text %v, Aside %v, want its text alone", extra.Text, extra.Aside)
+	}
+	if _, ok := pointOf(*extra, time.Now(), time.Now()); ok {
+		t.Error("Extra usage produced a history point")
+	}
+}
diff --git a/internal/provider/quota_history_test.go b/internal/provider/quota_history_test.go
index 544385259..339103237 100644
--- a/internal/provider/quota_history_test.go
+++ b/internal/provider/quota_history_test.go
@@ -208,7 +208,8 @@ func TestMergeQuotaHistory(t *testing.T) {
 // at this pace" line, as its rows are its pools' windows, which are aside
 // for routing, and its models' own windows are a family's. Each pool's
 // window is kept under its pool's name, as the card's line looks it up;
-// the models' windows still aren't, nor another window set aside.
+// the models' windows still aren't. Another measured window set aside for
+// routing keeps its own line too (chowyuan1314, #4612).
 func TestQuotaHistoryKeepsAntigravityPools(t *testing.T) {
 	testenv.SetHome(t, t.TempDir())
 	t.Setenv("XDG_CONFIG_HOME", t.TempDir())
@@ -227,8 +228,8 @@ func TestQuotaHistoryKeepsAntigravityPools(t *testing.T) {
 	noteQuotaHistory(card(10), t0)
 	noteQuotaHistory(card(30), t0.Add(time.Hour))
 	hs := QuotaHistories(t0.Add(-time.Hour), "", "")
-	if len(hs) != 1 || len(hs[0].Lines) != 3 {
-		t.Fatalf("histories = %+v, want the three pool windows' lines", hs)
+	if len(hs) != 1 || len(hs[0].Lines) != 4 {
+		t.Fatalf("histories = %+v, want the three pool windows' lines and Extra", hs)
 	}
 	five := lineOf(t, hs, "m@x.com", "Gemini · 5 hours")
 	if len(five) != 2 || five[0].Left != 90 || five[1].Left != 70 || five[0].Start == nil || !five[0].Start.Equal(r5.Add(-5*time.Hour)) {
@@ -240,4 +241,7 @@ func TestQuotaHistoryKeepsAntigravityPools(t *testing.T) {
 	if cl := lineOf(t, hs, "m@x.com", "Claude & GPT · 5 hours"); len(cl) != 2 || cl[0].Left != 60 {
 		t.Errorf("Claude & GPT · 5 hours = %+v", cl)
 	}
+	if extra := lineOf(t, hs, "m@x.com", "Extra"); len(extra) != 2 || extra[0].Left != 90 || extra[1].Left != 90 {
+		t.Errorf("Extra = %+v", extra)
+	}
 }
-- 
2.50.1 (Apple Git-155)
```

</details>

Branch with the commit: [fix/4612-aside-quota-history](https://github.com/ggbdpq/magpie/tree/fix/4612-aside-quota-history) (head `8835a061cbf9acd57f9ef3c42eaf0757952171c4`).
