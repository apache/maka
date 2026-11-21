Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `f712c83e1`, branch [`fix/5606-names-account-collision`](https://github.com/ggbdpq/magpie/tree/fix/5606-names-account-collision). GUI-only patch (`app.js` + its `.cjs`); no upstream commits touch the masking label path on this range.

Verification on the new base:

- `account-mask-namesake.test.cjs` 4/4 pass.
- Ablation on the new base: the dynamic-name yield-out (`not.delete` gated off) → 0/4, all red; restored → 4/4.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `6aae4fdcf99b344a`. Hi3DM/v5tech's real card layout stays NOT-RUNNABLE here (the .cjs fixture covers the label-collision shapes).

Generated-by: GLM-5.3-Flash (ZCode)
