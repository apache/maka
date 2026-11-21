Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `8ec9a86bb`, branch [`fix/5568-reset-card-timezone`](https://github.com/ggbdpq/magpie/tree/fix/5568-reset-card-timezone). No upstream commits on `codex_resets.go` in this range.

Verification on the new base:

- `TestCodexResetsRanOutSkipped` and the resets family green.
- Ablation on the new base: the ran-out skip out (an expired card taken as first again) → `TestCodexResetsRanOutSkipped` red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `b02b2766ec55b17f`. Real card-list fixtures stay as posted (the timezone halves are covered by the two fixture sets).

Generated-by: GLM-5.3-Flash (ZCode)
