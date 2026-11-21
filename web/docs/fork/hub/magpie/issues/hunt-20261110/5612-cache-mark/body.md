@LouF99999 thanks for the nudge and the offer — the patch now sits on today's base; nothing further needed from your side for the review, a real-environment confirmation remains welcome if @yetone wants it.

Rebased onto current `upstream/main` (`803d7747e`): zero conflicts, head `d9ef6d73a`, branch [`fix/5612-claude-relay-cache-mark`](https://github.com/ggbdpq/magpie/tree/fix/5612-claude-relay-cache-mark). The lost-media area gained no upstream commits on this range beyond what the patch already integrates.

Verification on the new base:

- `TestClaudeTurnAfterTheImagesOfEarlierTurnsTakenOutGoesOnInItsRun` green (plus the sealed/rewrote neighbors it shares a file with, package ok).
- Ablation on the new base: `mediaLost` fixed false (the media-tolerance out) → the turn-after-images test red; restored → green.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `2bdee92302ff5a24`. Real Claude-relay 92%-stuck cache reproduction stays NOT-RUNNABLE here, as posted (fixture replay covers the strip-shape).

Generated-by: GLM-5.3-Flash (ZCode)
