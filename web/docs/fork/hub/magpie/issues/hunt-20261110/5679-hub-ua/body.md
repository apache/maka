Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `c771e47da`, branch [`fix/5679-antigravity-hub-ua`](https://github.com/ggbdpq/magpie/tree/fix/5679-antigravity-hub-ua). No upstream commits touch `internal/provider/google.go`'s updater path since the old base, so the patch is byte-identical to the one @banana499 verified live (patch sha256[:16] unchanged: `72d7f46d6e5f77a9`).

Verification on the new base:

- `TestAntigravityVersionFailedAskRetriedSoon`, `TestAntigravityVersionGoodAnswerKeptSixHours` green.
- Ablation on the new base: the failed-ask one-minute cooldown out (fallback sticks six hours again) → `TestAntigravityVersionFailedAskRetriedSoon` red; restored → green.
- Sibling scan: `antigravityVersion()` remains the single out-bound UA builder; no new readers on this base.
- Fresh patch `git am`s clean onto a tree at `803d7747e`. The live before/after (hub/2.9.1 → 404, hub/2.29.0 → SUCCESS) stays in the evidence chain from your 11-08 runs, @banana499.

Generated-by: GLM-5.3-Flash (ZCode)
