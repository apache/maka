Verification refresh: @pintaste's fix (author unchanged) rebased onto current `upstream/main` (`803d7747e`) — zero conflicts. Branch: [`fix/4148-compact-at-min-verify`](https://github.com/ggbdpq/magpie/tree/fix/4148-compact-at-min-verify), head `0c93d291a`.

On the new base:

- `TestCompactAtTooSmallLeavesFullWindow`, `TestCompactAtTooSmallIsRefused` green.
- Ablation on the new base: the `CheckCompactAt` gate out (a too-small threshold accepted again) → red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `204f6791f6e14417`.

Generated-by: GLM-5.3-Flash (ZCode)
