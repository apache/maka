Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `19fef38b1`, branch [`fix/5537-relay-claude-models`](https://github.com/ggbdpq/magpie/tree/fix/5537-relay-claude-models). No upstream commits on the window-selection path in this range.

Verification on the new base:

- `TestClaudeCompactWindowRelayClaude` green (plus the window-typed neighbors it shares a file with).
- Ablation on the new base: the official/group exemption out (a relay's claude-* main model falls back to the generic threshold again) → red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `fe23a140baed2aeb`.

Generated-by: GLM-5.3-Flash (ZCode)
