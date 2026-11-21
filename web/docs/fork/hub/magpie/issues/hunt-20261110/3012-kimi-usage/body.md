Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `7a1007629`, branch [`fix/3012-kimi-usage-empty`](https://github.com/ggbdpq/magpie/tree/fix/3012-kimi-usage-empty). No upstream commits on the Kimi plan-quota read in this range.

Verification on the new base:

- `TestReadKimiCodeEmptyReply` green.
- Ablation on the new base: the empty-reply refusal out (an empty `{}` read as nothing used again) → red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `9f80ceccedf059f1`.

Generated-by: GLM-5.3-Flash (ZCode)
