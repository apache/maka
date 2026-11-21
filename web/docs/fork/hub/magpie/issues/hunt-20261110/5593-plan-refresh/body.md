Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `9a610bd31`, branch [`fix/5593-codex-plan-refresh`](https://github.com/ggbdpq/magpie/tree/fix/5593-codex-plan-refresh). No upstream commits on `logins_on.go` in this range.

Verification on the new base:

- `TestSavedRefreshUpdatesPlan` green.
- Ablation on the new base: the refresh-follows-plan write out (`codexPlan` result discarded) → red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `51c1ced1e629e18d`. Real Free→Plus refresh flow stays NOT-RUNNABLE here, as posted (the saved-logins fixture covers the write shape).

Generated-by: GLM-5.3-Flash (ZCode)
