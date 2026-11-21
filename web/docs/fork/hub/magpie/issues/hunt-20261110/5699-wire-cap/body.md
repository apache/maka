Rebased onto current `upstream/main` (`803d7747e`), zero conflicts; head `2616e2c31`, branch [`fix/5699-gateway-begin-wire-cap`](https://github.com/ggbdpq/magpie/tree/fix/5699-gateway-begin-wire-cap). `f1a4b5751..tip` brings three commits into `internal/plugin/` (a provider's models served by its plugin, sign-in words i18n, the #5583 rotating-token rule) — none on the `gatewayBegin`/wire-cap path.

Verification on the new base:

- Tests re-run green: `TestGatewayBeginLargeBodyUnchangedKeepsHostAlive`, `TestGatewayBeginLargeBodyTimeoutKeepsRequestAndHost`, `TestGatewayBeginLargeBodyRewriteTooLargeGivesUpThatRequest`, `TestGatewayBeginSmallBodyOrdinaryRewrite`.
- Ablation, each on the new base: `changed` forced true (the unchanged short-circuit out) → `TestGatewayBeginLargeBodyUnchangedKeepsHostAlive` red; `WIRE_LINE_MAX` past `Number.MAX_SAFE_INTEGER` (the give-up out) → `TestGatewayBeginLargeBodyRewriteTooLargeGivesUpThatRequest` red. Both restored → green.
- Sibling scan: `GatewayBegin`'s Go consumers and the wire-cap's only reader unchanged on the new base (the three plugin commits above are off-path).
- Fresh patch `git am`s clean onto a tree at `803d7747e`; sha256[:16] `63ea496629b4be80`. Real-plugin-host 32 MiB reproduction stays NOT-RUNNABLE here, as posted (the full-size 32 MiB+4 KiB fake-host run covers the shape).

Generated-by: GLM-5.3-Flash (ZCode)
