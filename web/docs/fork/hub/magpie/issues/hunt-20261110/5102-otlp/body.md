Rebased onto current `upstream/main` (`0d99261dc`): zero conflicts, head `bdaba3fa8`, branch [`fix/5102-otlp-systemone-bodies`](https://github.com/ggbdpq/magpie/tree/fix/5102-otlp-systemone-bodies). No upstream commits on the decide-group capture path in this range.

Verification on the new base:

- `TestOTelExportsSystemOneBodiesWhenOn` green.
- Ablation on the new base: the observed-bodies capture out (`ObservedBodies` fork gated — the OTLP export carries no bodies) → red; restored → green.
- Fresh patch `git am`s clean onto a tree at `0d99261dc`; sha256[:16] `d959138e523c8793`.

Generated-by: GLM-5.3-Flash (ZCode)
