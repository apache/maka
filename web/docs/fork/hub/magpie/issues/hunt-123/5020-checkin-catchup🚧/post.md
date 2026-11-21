Fixed on `upstream/main`'s side of the ledger — a patch follows, attached here per the project's no-PR policy.

## Summary

The daily loop keeps a count of check-ins in a row that never reached the vendor, and waits longer before each next try (a minute, doubled to half an hour — #265, for a machine that wakes before its network does). A DarkWake's failed check-in counted as one more *in that row* even when the last one had been hours before, so the row Macs sleep through midnight into — 03:40, 07:51, 09:38, each failing in its 2-7 s window — earned the full half-hour backoff by the time the lid opened. The look two minutes after waking for good was kept back by a failure from half an hour before, and on a day like 2026-11-03 the log shows nothing again until the day was over.

Now a failure only continues the row while the last try's backoff was still running (its own retry on the dot included). A DarkWake hours later starts the row anew, so the first look after waking for good — or after a restart, the other way your 09:42 run lost the day — asks at once, with the minute-long wait #265 kept for a network still coming back.

All five check-ins share the loop (WorkBuddy's plugin, WorkBuddy built-in, Trae CN, Qoder, MiniMax Code), so this covers the Qoder accounts your logs show timing out in the same DarkWakes too. The retry no longer fires inside a DarkWake itself — nothing in magpie knows a wake is a DarkWake — but the backoff no longer survives one, which is what kept your day from being made up.

## Verification

| Check | Result |
| --- | --- |
| New test `TestWorkBuddyCheckinDarkWakeFailsNotStacked` (clock stepped, never slept) | RED before the fix (Tries stacked to 1 at 07:51), GREEN after |
| Ablation: fix reverted, test kept | RED again |
| #265's own retry schedule test `TestWorkBuddyCheckinOfflineRetriesSoon` (tried at 0, 1, 3, 7, 15, 31, 61, 91 min) | unchanged, GREEN |
| Targeted: checkin/offline/plugin/qoder/minimax/trae suites | GREEN |
| `go test -tags nogui ./internal/provider/` (full, ~109 s) | GREEN |
| `go vet`, `gofmt`, `go build ./...` | clean |
| Full package under `-race` | 3 fails, all reproduced on the untouched parent commit (`TestPluginCheckinAsksAgainAtUntil`, `TestSignInDoneOnceTheAccountIsBack`, `TestMoveToPlugin`; each GREEN alone) — pre-existing, not from this change |

## AI use

Written by GLM-5.3-Flash (ZCode); author ggbdpq.

<details>
<summary>Patch — SHA-256 first 16: <code>6a371e41b5724d06</code></summary>

The commit is on the branch below, one commit on top of `upstream/main` (667317159); `git am` it from there, or cherry-pick 3aef9965625781a6610b0b6cf53f045301d86d6c. The change in full, on the product side:

```diff
--- a/internal/provider/checkin.go
+++ b/internal/provider/checkin.go
@@ -124,7 +124,11 @@ func (c checkiner) checkinNow(ctx context.Context, soon bool) []WorkBuddyCheckin
 		// global proxy was refused there (#2777)
 		r := a.do(ViaLogin(ctx, a.provider, a.User))
 		r.Day, r.At = day, now
-		if r.Offline && seen && prev.Day == day && prev.Offline {
+		// tries in a row are only so while the last try's backoff was
+		// still running, its own retry on the dot included: a DarkWake's
+		// failure hours later (#5020) is the day's first again, and the
+		// look on waking for good asks at once
+		if r.Offline && seen && prev.Day == day && prev.Offline && now.Sub(prev.At) <= prev.retryAfter() {
 			r.Tries = prev.Tries + 1
 		}
```

plus `TestWorkBuddyCheckinDarkWakeFailsNotStacked` in internal/provider/workbuddy_checkin_test.go (the 03:40 / 07:51 / 09:38 DarkWake timeline, stepped clock).

</details>

Branch: https://github.com/ggbdpq/magpie/tree/fix/5020-checkin-catchup (head 3aef9965625781a6610b0b6cf53f045301d86d6c)

Attribution: patch by ggbdpq, written by AI (GLM-5.3-Flash via ZCode) — happy to test a build if useful; the failing-and-fixed behavior is covered by the stepped-clock test, no real sleep needed.
