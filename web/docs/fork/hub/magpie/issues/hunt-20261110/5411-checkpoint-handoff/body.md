Rebased onto current `upstream/main` (`803d7747e`), head `0fb4b1703`, branch [`fix/5411-checkpoint-handoff`](https://github.com/ggbdpq/magpie/tree/fix/5411-checkpoint-handoff). One conflict, resolved as a union: upstream's new `TestForeignCompactionLeftOutOfAutoReview` (echo_ts, Copilot seal kept beside the conversation) landed in the same region of `native_compaction_test.go` — both tests stand, each with its own setup block; upstream's test passes untouched alongside ours.

Verification on the new base:

- `TestNativeCompactionSealedIsNotTranslatedAway`, `TestNativeCompactionSealedIsNotTranslatedIntoASubscription` green — and `TestForeignCompactionLeftOutOfAutoReview` (upstream's, sharing the file) green too.
- Ablation, each on the new base: the subscription-path refusal out → the subscription test red; the translation-path refusal out → the translated-away test red. Both restored → green.
- Sibling scan: the two `translatedCompaction` call sites are the only gates; upstream's echo_ts work composes with the refusal (a writer's seal stays beside the conversation, an unknown writer's is refused) — both behaviors verified in one tree.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `808507dcaf5030fa`. The deciding-shape data the issue asks for (a real checkpoint-only handoff) stays NOT-RUNNABLE until the reporter's setup is shared — the refusal semantics are fixture-covered meanwhile.

Generated-by: GLM-5.3-Flash (ZCode)
