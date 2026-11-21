Verification refresh: @Niko-Wu's fix (author unchanged) rebased onto current `upstream/main` (`803d7747e`) — zero conflicts. Branch: [`fix/4241-overage-window-verify`](https://github.com/ggbdpq/magpie/tree/fix/4241-overage-window-verify), head `9b8d74b51`.

On the new base:

- `TestClaudeOverageSeatSaysItsWindow`, `TestClaudeOverageSeatKeepsItsWindow` green (provider and gateway sides both).
- Ablation on the new base: the `overage` seat row out (the type unknown again) → red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `b034b4454305a1b6`.

Generated-by: GLM-5.3-Flash (ZCode)
