Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `70b76e31e`, branch [`fix/4863-replay-cache-diagnose`](https://github.com/ggbdpq/magpie/tree/fix/4863-replay-cache-diagnose). No upstream commits on the park/shelve path in this range.

Verification on the new base:

- `TestClaudeRunDeadWhileParkedLeavesItsSession` green.
- Ablation on the new base: `shelveParked` out (a dead parked run keeps its shelf) → red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `f06aadd11ae44153`. The diagnosis half (follow-up post above) stands as written; the shelf-leak fix is the patch part.

Generated-by: GLM-5.3-Flash (ZCode)
