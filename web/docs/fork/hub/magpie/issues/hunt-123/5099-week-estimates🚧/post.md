I put up a `take` — but after pinning the mechanism down in code, I think this is a design decision more than a clear-cut bug, so I'd like to lay out how it works and leave the choice of shape to you, @yetone. The reporter's reading of the code (@Evan26Ma: `window_holds.go`, `paidOtherwise`, `HoldsCredits`) is exactly right.

## What's wrong (mechanism, pinned to code)

- `usage.dryRuns` (internal/usage/window_holds.go) builds each account's *dry runs* — stretches where one of its windows read none left — from quota history plus the card's current reading (#2010, NorethSea).
- While reckoning, `windowHolds` checks every routed call against the account's dry runs (`inRun`). A run the vendor answered while dry (`paidOtherwise`: a call with status < 400 at or after the first dry reading, or any call at all in a run with no earlier "some left" reading) sets `why[s] = provider.HoldsCredits`, and the whole estimate is dropped: `sums[s]` is skipped whenever a why is set.
- The week window is suppressed by the same calls even when the week itself never ran dry: `dry` is keyed per account (provider + user), not per window, and `TestWindowHoldsLeavesOutCallsPaidOtherwise` asserts exactly this as intended — *"A window with such a call in it isn't reckoned: not the 5 hours that ran dry, nor the week the same calls fell in."*
- So under the reporter's rotation (an account keeps serving after its quota reads zero, Codex falls back to credits), every cycle contains a dry run, and the account's whole-week estimate is gone until the window resets, reduced to `holdsWhy: "credits"`. `magpie quota --json`, `GET /v1/magpie/quotas` (#2333) and the past-cycle view (`HistoricalWindowHolds`, same `windowHolds`/`dryRuns` path) all share this.

## Why it is the way it is

- #2010: calls the vendor answered after the window read none left may be paid from credits, which are not part of the subscription window. Counting them in the numerator and scaling by `100/used` would put the whole above the real allowance — an overestimate. Suppressing the window avoids that.
- b00da3860 states the stance outright: *"Credits can't be attributed per call, so none is attempted (documented)."*
- #2045 added `holdsWhy` so the gap at least says why instead of a bare "not enough data".

## What the data already supports (verified in code)

- Per-call attribution to dry runs already exists: `inRun[s]` records, per call, which runs it fell in, and `paidOtherwise` marks the answered-dry runs. `sums[s].Routed` (calls, tokens, cost) is in fact computed even for suppressed windows today and then discarded.
- A lower bound holds: credits don't move the subscription window's `used` percentage (#2010's reading of vendor behavior), so scaling only the kept (non-suspect) calls by `100/used` cannot land above the real allowance — it can only read low, exactly as calls made outside magpie already do (documented as reading low in the `WindowHolds` doc comment).

| Hypothesis | Verdict | Evidence |
|---|---|---|
| The week losing its estimate is accidental | No — intended | `TestWindowHoldsLeavesOutCallsPaidOtherwise` asserts "nor the week the same calls fell in"; b00da3860 |
| A per-window dry-run filter alone would fix it | No | the suspect calls genuinely fall inside the week's span; the numerator is what must change |
| Calls could be excluded per-call, mechanically | Yes | `inRun`/`paidOtherwise` already attribute per call; `sums[s].Routed` is computed then discarded |
| The scaled result would overestimate | No — lower bound | credits don't move `used` (#2010); scaling only kept calls reads low, like outside-magpie calls |
| Already fixed or in flight upstream | No | `git log -S holdsWhy/HoldsCredits`: only 722abfbb0 (#2045) and b00da3860 (#2010); no open PR touches it |

## Two shapes, your call

**A — qualified lower-bound estimate.** In `windowHolds`, keep two routed sums per window (all calls vs. excluding those in `paidOtherwise` runs). Where `HoldsCredits` would fire, fill `Holds` from the excluded sum scaled by `100/used`, and keep `HoldsWhy: "credits"` on the same window as the qualifier; the GUI (`holdsLine`) would add a tooltip line like *"some calls in it may have been paid from credits, so this reads low"* (5 i18n files). Restores a useful weekly figure under rotation; loosens the "nor the week" assertion. Touches: window_holds.go, app.js, i18n ×5, tests.

**B — keep the suppression, disclose the routed totals.** Where `HoldsCredits` fires, keep no whole, but surface the already-computed routed totals in the existing "not enough data" line's tooltip (*"magpie routed {tokens} tokens in {calls} calls, but some may have been paid from credits, so the whole can't be scaled"*). No estimate claim at all — closest to the reporter's third suggestion and to the current honesty stance; smallest surface.

A narrower third lever, if you'd rather not touch the display: `paidOtherwise` currently marks every call in a run with no earlier "some left" reading (`lastLeft.IsZero()`), even calls made before the first dry reading was ever observed. Bounding that to calls at or after the first dry reading would help accounts whose history starts mid-window — but it would not fix this report (those calls are genuinely answered after a dry reading), so it isn't the ask.

My lean is A for the rotation scenario, B if "no whole where credits may be mixed in" should stay a hard rule. Happy to implement either, or step aside if you have a different shape in mind.

## Not verified

I haven't run a live Codex account through a dry run: the claim that credits don't move the weekly `used` percentage rests on #2010's reading of vendor behavior, not a capture of my own. I also haven't rendered a window with both `holds` and `holdsWhy` set — today the GUI shows the estimate and ignores the reason, which is why shape A needs a GUI line of its own.

## AI use

Written by GLM-5.3-Flash (ZCode) from a hand-audited code walkthrough, checked against `TestWindowHoldsLeavesOutCallsPaidOtherwise`, #2010 and b00da3860.
