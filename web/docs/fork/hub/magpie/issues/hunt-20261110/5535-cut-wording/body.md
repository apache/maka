Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `ba5a1d5da`, branch [`fix/5535-tool-call-wording`](https://github.com/ggbdpq/magpie/tree/fix/5535-tool-call-wording). No upstream commits on the cut-stream wording path in this range.

Verification on the new base:

- `TestClaudeCutStreamMidToolCallWordedToRetry` green.
- Ablation on the new base: the transient-retry phrase out (error text back to the bare cut-short form) → red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `700e173962c5d8db`.

Generated-by: GLM-5.3-Flash (ZCode)
