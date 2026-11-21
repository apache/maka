Verification refresh: @cometee's fix (Haoyang Wu, author unchanged) rebased onto current `upstream/main` (`803d7747e`) — zero conflicts. Branch: [`fix/4034-ultrafast-tier-verify`](https://github.com/ggbdpq/magpie/tree/fix/4034-ultrafast-tier-verify), head `abfe864a3`.

On the new base:

- `TestUltrafastOfferedPastTheSignedInAccountsCache`, `TestCodexTiersOfferUltrafastAnAccountHas` green.
- Ablation on the new base: the Ultrafast offer fork out (`UltraOn` gated in `CodexTiers`) → the tiers test red; restored → green. (First tried gating the caller's lazy `UltraModels()` init — the direct tests construct their own `ultra` and call `CodexTiers` themselves, so that mutation isn't the load-bearing fork here; the in-function fork above is what's recorded.)
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `f3023f75202b1ead`. A real Ultrafast-capable Codex account stays NOT-RUNNABLE here, as posted (the account-list fixtures cover the shapes).

Generated-by: GLM-5.3-Flash (ZCode)
