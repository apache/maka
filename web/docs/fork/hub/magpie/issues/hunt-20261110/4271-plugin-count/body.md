Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `cdda83a0d`, branch [`fix/4271-plugin-count`](https://github.com/ggbdpq/magpie/tree/fix/4271-plugin-count). No upstream commits on the middleware change-counter in this range.

Verification on the new base:

- `TestChangedCounts` green.
- Ablation on the new base: one `changed.Add` site out (a plugin file write stops counting) → red; restored → green. The patch's other Add sites are the same counter from the sibling paths (settings/hooks/MCP), covered by the one fixture family.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `31c0bdd664649666`.

Generated-by: GLM-5.3-Flash (ZCode)
