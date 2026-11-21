Verification refresh: @MRQC-st's fix (author unchanged) rebased onto current `upstream/main` (`803d7747e`) — one conflict in `docs/subsystems/gateway-routing.md`, resolved as a union: upstream's Responses-enum bullet (#4482, `responsesEnumTidy`) and this patch's assistant-phase bullet both stand, adjacent. Branch: [`fix/4324-muse-phase-verify`](https://github.com/ggbdpq/magpie/tree/fix/4324-muse-phase-verify), head `07246539b`.

On the new base:

- `TestTranslatedMessagesSayPhase`, `TestOtherClientGetsNoPhase`, `TestMuseClientStreamHasNoPhase` green (the full trio, stream and whole-reply).
- Ablation on the new base: the encoder's phase write gated out (`release` never sets `heldMsg["phase"]`) → `TestTranslatedMessagesSayPhase` red; restored → green. (Gating `codexPhase` itself isn't witnessed by the direct tests — they drive the encoder with the flag already set; the write site is the load-bearing fork, and it is what's recorded.)
- Sibling scan: upstream's enum tidy and this patch's phase field compose — different fields, same encoder; both test families pass in one tree.
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `3ac734a806c83311`. A real Muse Code kill stays NOT-RUNNABLE here, as posted (the stream fixture covers the changed-phase shape).

Generated-by: GLM-5.3-Flash (ZCode)
