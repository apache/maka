Triaged against current `main` (`a3768cdd1` = v0.1.2738). Two findings: most of what this report asks for shipped **today in v0.1.2736**, and the part that remains (OfficeAce's shape) sits on pinned pacing semantics, so it needs a design call rather than a spot fix. Numbers below are from a probe at `a3768cdd1`.

## 1. What already landed today

95d0c97bf (v0.1.2736, "Use before expiry counts credits that expire before the reset") implements exactly the ranking this report asks for, for every account whose plugin carries the expiry: `provider.Allowance.Pace` folds `Limit.RunsOut` / `RunsOutLeft` (from `QuotaWindow.RunsOutAt` / `RunsOut`) into the pace, and the account whose credits are lost soonest per hour goes first.

Timeline: this issue was filed 12:40 UTC; v0.1.2736 was published 14:25 UTC — so "latest" at filing time (≤ v0.1.2735) ranked by weekly pace alone, and both reported symptoms reproduce there. Updating past v0.1.2736 fixes the CodeArts half:

Probe, CodeArts as `@magpie-community/opencode-codearts-auth` builds it (package total 500/5600 monthly, 300 credits expiring in 20 h via `runsOutAt`/`runsOut` — the plugin has stamped its **total** window this way since 0.2.0; the aside buckets are display breakdown):

- A (check-in credits expiring): pace 0.268, due in 20 h
- B (same plan, nothing expiring): pace 0.149 → A first

And when A's check-in credits are spent, the plugin's `soonestLapse` drops the spent batch (`left > 0` filter), A falls back to its monthly pace, and the sibling account whose check-in is intact rises first — the cross-account behavior the report expects follows from the data refresh.

## 2. The report's three code claims vs current main

- "`Allowance.Pace` doesn't fold `RunsOut`" — fixed by 95d0c97bf (`Limit.expiring`, per window).
- "`Pace` never reads `Seat.Lapse`" — no longer needed: the expiry is folded into `Seat.Pace` itself (the gateway feeds `a.Pace(model)` into the seat; `TestPaceGoesByCreditsExpiring` pins the ordering), and the strategy is now "Use before expiry".
- "`allowanceOf` skips aside buckets" — true (`if w.Aside || w.Text { continue }`), but it does **not** lose the check-in signal for CodeArts: the plugin's total window is not aside and carries `runsOutAt`/`runsOut` from the batches (`usageFromStatistics` in packages/codearts); the aside buckets are the breakdown only.

## 3. What remains — OfficeAce's shape, a real gap that needs a design call

OfficeAce (`fetchOfficeAceUsage`, added 10-31) builds each bucket as its own window whose `resetsAt` **is** the bucket's expiry (the daily check-in bonus: tomorrow); buckets become `aside` only once expired. So the soonest deadline lives in a *separate budget window*, and `Allowance.Pace` ranks an account by **the tightest of its budget windows** — min(left ÷ hours) — which buries it:

- A (monthly plan + check-in bonus expiring in 20 h): pace 0.125, due in 720 h — the expiring window is invisible
- B (same plan, fresh): pace 0.139 — ranks ahead of A

Once A's check-in is burned, the spent bucket zeroes A's pace (0.0) and, through `Allowance.For`'s fullest-window share, drops the account into the spent tier — same root cause as #2878.

This is not an oversight to patch: "of several (Opus's own beside the general) the tightest" is the semantics pace was written with (#517), `TestAllowancePace` pins it both ways ("Opus by its own, the tighter" / "the general decides Opus too"), and 95d0c97bf kept it while adding expiry *within* a window. Flipping min → max would rank OfficeAce right and break those pinned cases. Notably **Smart** already ranks such an account first (its first renewal is the expiring bucket: renewals [20 h, 720 h]) — pace is the odd one out.

Ways forward, for whoever calls it:

- **No magpie change:** the OfficeAce plugin can stamp `runsOutAt`/`runsOut` on its longest-lived window from the soonest live bucket — exactly what the CodeArts plugin already does for its total. v0.1.2736+ then ranks it first, today.
- **Magpie-side:** fold cross-window deadlines into the pace — that is #3428's territory (the seat knowing *what* is about to be lost, not only *when*), and it needs the "tightest window" rule revisited, so I'd rather not one-line it into a patch.

Happy to work either.

Verification: probe at `a3768cdd1` (= v0.1.2738) through `allowanceOf` + `Allowance.Pace` (numbers above); plugin sources read at magpie-community/plugins `packages/codearts` (`usageFromStatistics`, `fetchOfficeAceUsage`); timeline from the releases (v0.1.2736 published 2026-11-02 14:25 UTC, commit 95d0c97bf).

Generated-by: GLM-5.3-Flash (ZCode)
