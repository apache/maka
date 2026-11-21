Rebased onto current `upstream/main` (`0d99261dc`): zero conflicts, head `824ce4752`, branch [`fix/4165-passthrough-thinking`](https://github.com/ggbdpq/magpie/tree/fix/4165-passthrough-thinking). Test-only — pins the passthrough leg of the thinking-back learn.

Verification on the new base:

- `TestThinkingBackLearnedOnPassthrough` green (both halves: the refusal word-for-word, and a plain reply taken).
- Ablation on the new base: the learn out (`refuseThinkingBack` fixed false — the passthrough relay never gets marked, the thinking block never goes back) → red at the refused call; restored → green.
- Fresh patch `git am`s clean onto a tree at `0d99261dc`; sha256[:16] `d445e5a5a647613e`. tokenrhythm.studio itself stays NOT-RUNNABLE (the fixture plays its 400 verbatim from the report).

Generated-by: GLM-5.3-Flash (ZCode)
