Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `79ec15d26`, branch [`fix/5067-compaction-system-messages`](https://github.com/ggbdpq/magpie/tree/fix/5067-compaction-system-messages). No upstream commits on the compaction-ask path in this range.

Verification on the new base:

- `TestCodexCompactSystemRefusedAsksAgainDeveloper` (and the compact family) green.
- Ablation on the new base: the ask-again-as-sent retry out (`askAsSent` passes the request through unchanged) → red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `26270bb05a734677`. Real relay refusal reproduction stays NOT-RUNNABLE here, as posted (the refusing fake covers the shape).

Generated-by: GLM-5.3-Flash (ZCode)
