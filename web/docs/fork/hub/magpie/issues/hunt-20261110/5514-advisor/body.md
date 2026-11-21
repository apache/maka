Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `a66cf02aa`, branch [`fix/5514-advisor-remote`](https://github.com/ggbdpq/magpie/tree/fix/5514-advisor-remote). No upstream commits on the advisor-detect path in this range.

Verification on the new base:

- `TestClaudeSubscriptionSaysWhenTheAdvisorIsLeftOut`, `TestClaudeSubscriptionWithoutAnAdvisorSaysNothing` green.
- Ablation on the new base: the advisor notice out (`"advisor_` fork gated) → the says-when-left-out test red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `7a3e6736f7f37a04`.

Generated-by: GLM-5.3-Flash (ZCode)
