@yetone — the vendor's own words make this one: a window that says both when it renews and what lapses before it is read as ending at the lapse, whatever the lapse is worth. Your reporter's A holds 495 of 500 credits, renews in 28 days, and one credit of it lapses in 14 hours; Smart then ranks A as the account whose whole left is lost in 14 hours and sends it every request, while B — 250 left, renewing in 10 days, the one whose left is lost first in truth — gets none. The 0.2% that lapses early is real and worth spending first; the 99.8% that doesn't is not. Thank you @sparrowhe for the complete A/B arithmetic that pins the ranking flip.

**Root cause**: `Allowance.renewing` (`internal/provider/routing.go:584` at the parent commit) takes `Limit.RunsOut` for the window's renewal whenever the lapse comes before the reset, on the reading that "what is left is lost then all the same" — the reading WorkBuddy's credits made true, whose packages end on their own days and whose windows have no reset of their own (`cdredfox on X`). But a window can say how much lapses (`Limit.RunsOutLeft`, `Limit.Of`), and then "all the same" is the vendor's to assert, not ours to assume: reporter's A says one credit of 500. With the renewal moved to the lapse, Smart — "of those with quota to spare, the one whose allowance renews soonest, since what it has left is lost then" (`routes.Smart`, comparing `Seat.Soon`) — reads A as expiring 14 hours out, ahead of B's 10 days, and the group's requests pool on A while B sits. The share that expires is not unknown to the code elsewhere: `Pace`'s `expiring` already weights the lapse by `RunsOutLeft/Of` (`internal/provider/routing.go:821`); only the renewal didn't.

**The fix** — at the same line, the assumption now asks the vendor's count first: a window with a reset of its own that tells a lapse smaller than what it has left expires alone, and keeps its reset (`Limit.lapsingAll`, beside `expiring`). Every shape the old reading served stays served: a window with no reset of its own (WorkBuddy's credits) still ends at RunsOut whatever lapses — RunsOut is its only end; a window that doesn't count the lapse (RunsOutLeft or Of untold) still loses all it has left there, as before; a lapse covering all that is left still ends the window. `TestWorkBuddyCreditsRunOutForRouting` (cdredfox's account, RunsOutLeft 232.4 of 2250, no reset) still passes untouched — that is the case the moved renewal was built for, and it has no reset to fall back to.

Sibling-face scan of every `RunsOut`/window-expiry consumer, each left or changed with its reason:

- `renewing`, the RunsOut-before-reset branch (`internal/provider/routing.go:584`): the root — changed as above.
- `Lapse` (`internal/provider/routing.go:657`): the soonest lapse as a tiebreak when renewals tie, spent-first semantics — a 0.2% lapse is still the one to spend first. Left; correct as is.
- `expiring`, Pace's pace of a lapse (`internal/provider/routing.go:821`): already weights by `RunsOutLeft/Of`, so a part lapsing gives a small pace. Left; the part-expiry awareness lives here already.
- `Expires` (`internal/routes/strategies.go:558`), FreeExpiring's order: spend-free-quota-that-is-lost-soonest-first is deliberate spend-the-lapse semantics, and `Lapse` feeds it. Left; the strategy wants the lapse ranked first, whatever its size.
- `Smart` (`internal/routes/strategies.go:142`): consumer of `Seat.Soon`; with the renewal shaped right, the ranking is right. Left.
- `weighRouted` (`internal/gateway/routing.go:2365`): the only producer of `Seat.Soon` (`a.Renewal(...)`). Left; fixed at the source.
- `trace.go` Soon/Lapse/Unreached (`internal/gateway/trace.go:351`): display of the same values. Left.
- `resetRunsOut`/`Restarts` (`internal/provider/codex_expiring.go:231`, `routing.go:412`): a different mechanism — the Codex auto-use reset spent before it runs out (`ResetRunsOut`), not the `QuotaWindow.RunsOut` field. Left.
- `QuotaWindow.RunsOutAt/RunsOut` parsing (`internal/provider/quotas.go:141`, `plugin_usage.go:196`, `internal/plugin/providers.go:1253`): data entry, field semantics unchanged. Left.

<details>
<summary>patch: routing: a part expiring doesn't renew the window, its reset does (#5791) — git am applies it as is; SHA-256 first 16: cf2583d5cfcba997</summary>

```text
From 0000000000000000000000000000000000000000 Mon Sep 17 00:00:00 2001
From: ggbdpq <ggbdpq@gmail.com>
Date: Mon, 9 Nov 2026 22:14:55 +0800
Subject: [PATCH] routing: a part expiring doesn't renew the window, its reset
 does (#5791)

A vendor may tell a share of a window's left lapsing at RunsOut long
before the window's own reset (RunsOutLeft of Of, a credit of 500 of
an account 99% up). renewing took RunsOut for the renewal whatever
the share, so Smart ranked that account first as one whose whole left
is lost at the lapse, and a group sent it every request, the peer
whose real reset is the sooner getting none. A lapse told smaller
than the window has left now expires alone: the renewal stays at the
reset. What the vendor doesn't count, a lapse covering all that is
left, and an account with no reset of its own (WorkBuddy's credits)
still end the window at RunsOut, as before.
---
 internal/provider/partial_expiry_test.go | 48 ++++++++++++++++++++++++
 internal/provider/routing.go             | 24 +++++++++++-
 2 files changed, 70 insertions(+), 2 deletions(-)
 create mode 100644 internal/provider/partial_expiry_test.go

diff --git a/internal/provider/partial_expiry_test.go b/internal/provider/partial_expiry_test.go
new file mode 100644
index 000000000..a76c334de
--- /dev/null
+++ b/internal/provider/partial_expiry_test.go
@@ -0,0 +1,48 @@
+package provider
+
+import (
+	"testing"
+	"time"
+)
+
+// A part of an account's points expiring before its real reset (RunsOut
+// with RunsOutLeft told, less than what is left) is not the window ending
+// then: Renewal keeps the window at its reset, so Smart doesn't rank the
+// account first as one whose whole left is lost at the part's expiry and
+// send it every request before a peer whose reset is the sooner (#5791).
+// What the vendor doesn't count (RunsOutLeft or Of untold), a part that
+// covers all the window has left, and an account with no reset of its own
+// (WorkBuddy's credits) still end the window at RunsOut.
+func TestPartialExpiryKeepsTheReset(t *testing.T) {
+	now := time.Now()
+	day := 24 * time.Hour
+	hour := time.Hour
+
+	// the issue's A: 500 credits, 1% used (495 left), one credit lapsing in
+	// 14 hours, the window itself renewing in 28 days
+	a := Allowance{{Used: 1, Resets: now.Add(28 * day), Span: 28 * day,
+		RunsOut: now.Add(14 * hour), RunsOutLeft: 1, Of: 500, Unit: "credits"}}
+	if r := a.Renewal("m", now); len(r) != 1 || !r[0].Equal(now.Add(28*day)) {
+		t.Fatalf("a part expiring renews at its reset: %v, want %v", r, now.Add(28*day))
+	}
+
+	// what the vendor doesn't count is lost whole, as before: the window
+	// ends at RunsOut
+	uncounted := Allowance{{Used: 1, Resets: now.Add(28 * day), Span: 28 * day,
+		RunsOut: now.Add(14 * hour)}}
+	if r := uncounted.Renewal("m", now); len(r) != 1 || !r[0].Equal(now.Add(14*hour)) {
+		t.Fatalf("a lapse of untold size renews at RunsOut: %v, want %v", r, now.Add(14*hour))
+	}
+	// a part covering all that is left ends the window too
+	allLeft := Allowance{{Used: 99, Resets: now.Add(28 * day), Span: 28 * day,
+		RunsOut: now.Add(14 * hour), RunsOutLeft: 495, Of: 500, Unit: "credits"}}
+	if r := allLeft.Renewal("m", now); len(r) != 1 || !r[0].Equal(now.Add(14*hour)) {
+		t.Fatalf("a lapse of all that is left renews at RunsOut: %v, want %v", r, now.Add(14*hour))
+	}
+	// an account with no reset of its own (WorkBuddy's credits) goes by the
+	// package that ends first
+	noReset := Allowance{{Used: 10, RunsOut: now.Add(3 * day)}}
+	if r := noReset.Renewal("m", now); len(r) != 1 || !r[0].Equal(now.Add(3*day)) {
+		t.Fatalf("no reset, renewal at RunsOut: %v, want %v", r, now.Add(3*day))
+	}
+}
diff --git a/internal/provider/routing.go b/internal/provider/routing.go
index 467db2b90..f7b528736 100644
--- a/internal/provider/routing.go
+++ b/internal/provider/routing.go
@@ -554,7 +554,9 @@ func (a Allowance) Count(model string, now time.Time) (amount, of float64, unit
 // whose credits left run out before it renews (Limit.RunsOut) renews
 // then, as what is left is lost then all the same: WorkBuddy's accounts,
 // whose credits have no reset, go by the package that ends first
-// (cdredfox on X).
+// (cdredfox on X). A lapse of a part of what is left (RunsOutLeft told,
+// less than the window has left) doesn't move it: what runs out there is
+// a share of the window, and the window itself goes by its reset (#5791).
 func (a Allowance) Renewal(model string, now time.Time) []time.Time {
 	ls := a.renewing(model, now)
 	out := make([]time.Time, len(ls))
@@ -581,7 +583,7 @@ func (a Allowance) renewing(model string, now time.Time) []Limit {
 				l.Resets = now.Add(l.Span)
 			}
 		}
-		if l.RunsOut.After(now) && (l.Resets.IsZero() || l.RunsOut.Before(l.Resets)) {
+		if l.RunsOut.After(now) && (l.Resets.IsZero() || l.RunsOut.Before(l.Resets)) && l.lapsingAll() {
 			l.Resets = l.RunsOut
 		}
 		l.Resets = restarted(l.Resets, restart)
@@ -829,6 +831,24 @@ func (l Limit) expiring(u float64, now, ends time.Time) (pace float64, at time.T
 	return share / max(l.RunsOut.Sub(now), time.Hour).Hours(), l.RunsOut, true
 }
 
+// lapsingAll says whether a window ends at RunsOut as much as it does at
+// its reset. One with no reset of its own (WorkBuddy's credits) ends
+// nowhere else: RunsOut is its renewal whatever lapses there. One with a
+// reset that doesn't count what lapses (RunsOutLeft or Of untold) loses
+// all it has left there, as before; a part told less than the window has
+// left expires alone, and the window keeps its reset (#5791: one credit
+// of 500 expiring had the window renew in hours, and Smart sent it every
+// request).
+func (l Limit) lapsingAll() bool {
+	if l.Resets.IsZero() {
+		return true
+	}
+	if l.RunsOutLeft <= 0 || l.Of <= 0 {
+		return true
+	}
+	return l.Of*(100-min(100, max(0, l.Used)))/100 <= l.RunsOutLeft
+}
+
 // Allowances is each of an agent's accounts' allowance by user, as last
 // known, asked for again in the background when that was over a minute
 // ago. Only the very first ask waits, and not for long. An account
-- 
2.50.1 (Apple Git-155)

```

</details>

**Branch with the commit**: [`fix/5791-partial-expiry-window`](https://github.com/ggbdpq/magpie/tree/fix/5791-partial-expiry-window) (head `8d328bf6eb3dfd36ff375c47eede45c4817f617e`), rebased onto current `upstream/main` (`a6e4cf763` — fetched again twice during the evening, since the routing neighborhood was moving: the second fetch moved the tip by six commits, none touching `internal/provider/routing.go`, `internal/routes/` or the new test; rebased onto it, the new test, the ablation and the touched packages re-run green on the new base). On a fresh checkout `git am` applies clean. Raw patch: https://github.com/ggbdpq/magpie/commit/8d328bf6eb3dfd36ff375c47eede45c4817f617e.patch

| Check | Result |
| --- | --- |
| `TestPartialExpiryKeepsTheReset` (new) | red before the fix (`a part expiring renews at its reset: [14h out], want [28d out]` — the reporter's A renewing at its one-credit lapse), pass after; pins the four shapes that must keep ending at RunsOut (lapse of untold size, lapse covering all that is left, no reset of its own, lapse after the reset) |
| `TestWorkBuddyCreditsRunOutForRouting` | pass, before and after — cdredfox's credits (RunsOutLeft 232.4 of 2250, no reset) still renew at RunsOut |
| targeted expiry family in `internal/gateway` (`RunsOut|Renewal|WindowRest|AllowanceStale|Smart|Expir|Reset|Cap`) | pass (38s), before and after the rebase |
| `go test -tags nogui -count=1 ./...` (temp HOME, pinned GOCACHE) | 87 packages ok; 3 failures, all pre-existing red on this machine and rerun red on the clean parent `a6e4cf763` too: `TestMothX` (internal/agent), `TestProxyCheckSaysAProxyPassedBy` (internal/gui, proxy 7897), `TestHostToldTheGatewayAddress` (internal/plugin); none in `internal/provider`, `internal/routes`, `internal/gateway` |
| `gofmt -l internal/provider/` | prints nothing |
| `go vet -tags nogui ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build ./...`; `GOOS=linux go build -tags nogui ./...`; `GOOS=windows go build ./...` | clean (the macOS link prints its usual Xcode version warnings, exits 0) |
| Ablation | reverting `internal/provider/routing.go` alone to the parent commit (tests kept, first `dae104bfa`, then `a6e4cf763` after the rebase) turns the new test red at the same line it failed before the fix; restored, green; `TestWorkBuddyCreditsRunOutForRouting` unaffected by the ablation, as the old reading serves it |
| Re-verified on upstream/main `a6e4cf763` | rebased onto it (second fetch mid-evening, tip had moved); new test, WorkBuddy regression, `internal/provider` (230s) + `internal/routes` + the gateway expiry family all green on the new base |

**Not verified**: against a live vendor that really sends a partial `runsOutAt` beside a real reset (the reporter's account) — NOT-RUNNABLE here (no such account; the reporter's A/B arithmetic is what the new test pins in its place). The WorkBuddy shape is covered by its own live-shaped test, and the untold-size shape (the vendor says when, not how much) keeps its old reading, so a vendor that starts telling the size only loses the misranking if the size is genuinely partial.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
