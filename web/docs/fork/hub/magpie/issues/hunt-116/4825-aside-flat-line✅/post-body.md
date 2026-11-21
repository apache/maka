Took this in 6565471441. Here is a patch.

**Symptom**: on the quota history chart, a plugin's aside row that says no used share draws a flat line at 100% left. `quotaOfPlugin` left such a window's `Used` at 0, `pointOf` took that 0 for a reading, and quota-history.json kept a point of 100% left at every reading of the account.

**Minimal repro**: a plugin usage window `{"name":"On-demand","display":"$12.34","amount":12.34,"aside":true}` (an amount with no limit to reckon a share from, `used` left out) or `{"name":"Points","amount":500,"aside":true}`: `quotaOfPlugin` builds a window with `Used` 0 and `Text` false, and `pointOf` returns a point with `Left` 100 for it. Found in the review of #4612; not reproduced with a real plugin.

**Root cause**: #3650 made a left-out `used` no reading — the card's Text row and routing's unknown account. Aside windows stayed out of that because routing keys on `Aside` alone, so a no-share aside row kept its `Used` 0; since 49c99e18d history draws measured aside windows, and the 0 read as "nothing used, all left". Factory's display-only "Extra usage" row escaped only because its own reader marks it Text.

**Fix**: `quotaOfPlugin` sets a new unexported `noShare` on an aside window whose `used` the plugin left out, however the row is otherwise told, and `pointOf` refuses it: history keeps no line for a window that says no share. A window that said `used` keeps its line, and so does one whose amount and limit reckon to a share (chowyuan1314, #4612). The card still tells the row's text and routing still sets the row aside: `noShare` is read by history alone. Non-aside rows are untouched: not set aside, a window that says no share is still Text, and a wallet's Balance is still a reading (#3950).

**Verification**:

| Check | Result |
| --- | --- |
| `TestAsideWindowWithoutUsedDrawsNoLine` (new), at this tree | pass |
| same test, the product change reverted by hand | red: both no-share rows drew a history point |
| `go test ./internal/provider -tags nogui -count=1` | ok |
| `gofmt -l` | clean |
| `go vet ./...`; GOOS=linux, windows, darwin vet of provider and plugin (nogui) | clean |
| `go build`, darwin, linux and windows (nogui) | ok |

**Not verified**: no real plugin that reports such a row was driven (the issue's own finding is from code reading); the chart itself was not driven in a browser — the change only stops the fictitious points from reaching quota-history.json, and the chart draws what the API returns.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: fix(provider): quota history draws no line for an aside window that says no share (#4825) — git am applies it as is; SHA-256 first 16: c2df3f8a730e24e4</summary>

````
From 11e2e74998a6a280588b394adcb0e72f978d0e34 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 2 Nov 2026 07:46:27 +0800
Subject: [PATCH] fix(provider): quota history draws no line for an aside
 window that says no share (#4825)

What changed: quotaOfPlugin left a plugin's aside window that said no
share with its Used at 0, and pointOf took that 0 for a reading, so
quota-history.json kept point after point of a fictitious 100% left and
the chart drew a flat line. #3650 made a left-out used no reading for
the card and routing; aside windows kept their Used because routing
keys on Aside alone, and history draws them since 49c99e18d - Factory's
display-only row was Text'd at its source, but a plugin row that says
only an amount, or nothing at all, still drew.

pointOf now refuses a window whose noShare is set, and quotaOfPlugin
sets it on an aside window whose used the plugin left out, however the
row is otherwise told: a Used left at 0 there is 0 for want of a share
said, not a reading at 0. A window that said used keeps its line, and
so does one whose amount and limit reckon to a share (chowyuan1314,
#4612). The card still tells the row's text and routing still sets it
aside: noShare is read by history alone.

Run (at ad53a23dc + this change, macOS arm64):
- TestAsideWindowWithoutUsedDrawsNoLine (new) fails before and passes
  after; with the product change reverted, it is red again.
- go test ./internal/provider -tags nogui -count=1: ok.
- gofmt -l clean; go vet ./..., GOOS=linux and windows vet of provider
  and plugin (nogui) clean; builds darwin, linux, windows (nogui) ok.

Generated-by: GLM-5.3-Flash (ZCode)
---
 internal/provider/plugin_usage.go             |  7 +++++-
 internal/provider/plugin_usage_absent_test.go | 22 +++++++++++++++++++
 internal/provider/quota_history.go            |  5 +++--
 internal/provider/subscription_usage.go       |  5 +++++
 4 files changed, 36 insertions(+), 3 deletions(-)

diff --git a/internal/provider/plugin_usage.go b/internal/provider/plugin_usage.go
index ce586a07e..c11686aa5 100644
--- a/internal/provider/plugin_usage.go
+++ b/internal/provider/plugin_usage.go
@@ -175,7 +175,12 @@ func quotaOfPlugin(q SubscriptionQuota, u plugin.Usage) SubscriptionQuota {
 		}
 		if used != nil {
 			w.Used = *used
-		} else if !x.Aside && x.Balance == nil {
+		} else if x.Aside {
+			// a window set aside that says no share: its Used is 0 for want
+			// of one said, not a reading at 0, which quota history drew as
+			// a flat 100% left line (#4825)
+			w.noShare = true
+		} else if x.Balance == nil {
 			// the plugin didn't say how much of it is used: its text is all
 			// there is, and routing has no share to count (#3650)
 			w.Text, w.Aside = true, true
diff --git a/internal/provider/plugin_usage_absent_test.go b/internal/provider/plugin_usage_absent_test.go
index f3c7471ad..1ab662197 100644
--- a/internal/provider/plugin_usage_absent_test.go
+++ b/internal/provider/plugin_usage_absent_test.go
@@ -163,3 +163,25 @@ func TestAWindowsCountIsItsShare(t *testing.T) {
 		t.Errorf("routing: known %v, used %v; want the count's 37", ok, used)
 	}
 }
+
+// A window set aside whose used was left out says no share: quota history
+// took its Used, left at 0, for a reading and drew a flat 100% left line
+// (#4825). One that said used, or whose amount and limit reckon to a
+// share, is a reading and keeps its line (chowyuan1314, #4612).
+func TestAsideWindowWithoutUsedDrawsNoLine(t *testing.T) {
+	var u plugin.Usage
+	if err := json.Unmarshal([]byte(`{"windows":[
+		{"name":"On-demand","display":"$12.34","amount":12.34,"aside":true},
+		{"name":"Points","amount":500,"aside":true},
+		{"name":"Weekly","used":56.1,"aside":true},
+		{"name":"Bonus","amount":5,"limit":20,"aside":true}]}`), &u); err != nil {
+		t.Fatal(err)
+	}
+	q := quotaOfPlugin(SubscriptionQuota{Provider: "acme-plugin", User: "u"}, u)
+	now := time.Now()
+	for i, w := range q.Windows {
+		if _, ok := pointOf(w, now, now); ok != (i >= 2) {
+			t.Errorf("%s: history point %v, want %v", w.Name, ok, i >= 2)
+		}
+	}
+}
diff --git a/internal/provider/quota_history.go b/internal/provider/quota_history.go
index b02cde3ef..acd5ca144 100644
--- a/internal/provider/quota_history.go
+++ b/internal/provider/quota_history.go
@@ -226,9 +226,10 @@ func newCycle(a, b QuotaPoint) bool {
 // (max2020 on Discord: an Antigravity card had no curve and no "runs
 // out" line; chowyuan1314, #4612: the Cursor plugin's Weekly and Grok
 // Bot are aside and had no curve). A window told as its text alone has
-// no share to draw.
+// no share to draw, and neither has one set aside whose Used is 0 for
+// want of a share said (noShare, #4825).
 func pointOf(w QuotaWindow, at, now time.Time) (QuotaPoint, bool) {
-	if w.Unlimited || w.Text || w.Family != "" || w.Name == "" || math.IsNaN(w.Used) {
+	if w.Unlimited || w.Text || w.noShare || w.Family != "" || w.Name == "" || math.IsNaN(w.Used) {
 		return QuotaPoint{}, false
 	}
 	p := QuotaPoint{At: at.UTC().Truncate(time.Second), Left: math.Round(max(0, min(100, 100-w.Used))*100) / 100}
diff --git a/internal/provider/subscription_usage.go b/internal/provider/subscription_usage.go
index 311efcd65..109b6a78c 100644
--- a/internal/provider/subscription_usage.go
+++ b/internal/provider/subscription_usage.go
@@ -134,6 +134,11 @@ type QuotaWindow struct {
 	// rate_limit_event names one window at a time), never read whole by
 	// /usage — five hours alone there needn't mean no week.
 	partial bool
+	// noShare is set on a window set aside whose used the plugin left
+	// out: its Used is 0 for want of a share said, not a reading at 0, so
+	// quota history keeps no line for it (#4825). The card still tells
+	// the row's text and routing still sets it aside.
+	noShare bool
 }
 
 // SubscriptionQuota is provider-reported allowance usage. This is separate
-- 
2.50.1 (Apple Git-155)

````

</details>

Branch with the commit: [fix/4825-aside-flat-line](https://github.com/ggbdpq/magpie/tree/fix/4825-aside-flat-line) (head `11e2e74998a6a280588b394adcb0e72f978d0e34`).
