Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `b2e702979`, branch [`fix/5521-models-api-key-scope`](https://github.com/ggbdpq/magpie/tree/fix/5521-models-api-key-scope). No upstream commits on the live-list auth path in this range.

Verification on the new base:

- `TestListBearerOnlyOnOpenAIBase` green.
- Ablation on the new base: the `anthropic` gate out (x-api-key sent to the OpenAI-compatible base again) → red; restored → green. (The `remote_magpie.go` signing half isn't load-bearing for this test — it's covered by the same fixture shape at the relay boundary.)
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `835ee0631a4c75f3`. wabxn514's lightvela relay stays NOT-RUNNABLE here (the fake gateway asserting header sets covers the contract).

Generated-by: GLM-5.3-Flash (ZCode)
