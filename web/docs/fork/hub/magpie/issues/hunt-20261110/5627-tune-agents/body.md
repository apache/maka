Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `ebe6c67cc`, branch [`fix/5627-tuned-for-you-agents`](https://github.com/ggbdpq/magpie/tree/fix/5627-tuned-for-you-agents) — also covering jackyfan01's correction (the root cause landed on is the single-source one).

Verification on the new base:

- `TestTuneTellsWhyAnAgentIsBlank`, `TestTuneAgentsHavePlaces` green.
- Ablation on the new base: `TouchedSince` emptied (the blank-agent evidence source out) → `TestTuneTellsWhyAnAgentIsBlank` red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `892d01ecd0cf4c42`.

Generated-by: GLM-5.3-Flash (ZCode)
