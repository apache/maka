Status check: **both problems were fixed in v0.1.1710 (commit 5f3146be0)** — A via @JoeyWu-tech's patch originally made for #2883 (authorship preserved, as @yetone announced), B added during the merge. Verified at current `main` today:

| Facet | Fix commit | Status at tip | Reporter confirmed on v0.1.1734? |
|---|---|---|---|
| A — thinking block sent without `signature` | 5f3146be0 (v0.1.1710), JoeyWu-tech's d9283c78 shape | `internal/gateway/anthropic.go:66-73` — `aBlock.MarshalJSON` always writes `"signature"` on a thinking block (empty string for the unsigned filler and replayed reasoning); guard test `TestOpenRouterDeepSeekThinkingHasASignature` at `internal/gateway/deepseek_anthropic_thinking_test.go:192` | Not explicitly (A was verified by the fake-OpenRouter test and against DeepSeek's own `/anthropic` endpoint; the reporter's live confirmation covered B) |
| B — mid-conversation `role: "system"` message with per-message `output_config` | 5f3146be0 (v0.1.1710), added in the merge | `internal/gateway/anthropic_shapes.go:81` — `turnEffortRefused` also matches OpenRouter's `Mid-conversation reasoning effort (configuration_update) is not supported` wording; the refusal is learned per provider (`anthropic_shapes.go:109-111`) and `withoutTurnEffort` (`anthropic_shapes.go:205`, applied at `:160-162`) drops the per-message `output_config` on the retry and afterwards, keeping the request's top-level `output_config` and the system message text; guard test `TestOpenRouterTurnEffortLeftOut` at `internal/gateway/deepseek_anthropic_thinking_test.go:309` | Yes — 200 on the first try on a live OpenRouter account (`z-ai/glm-5.3-flash`) |

**Version comparison / upgrade guide:** the report was filed on magpie **0.1.1285** (code cross-checked at v0.1.1476 and v0.1.1564 — all older than the fix). Reporter on 0.1.1285 → upgrade to ≥ **v0.1.1710**; the latest release is **v0.1.2889** (latest tag v0.1.2891). No config change is needed: on this endpoint magpie learns the refusal per provider and stops sending the per-message effort automatically after the first 400.

**Still open (unchanged from @yetone's note):** the one row not handled is a mid-conversation `role: "system"` message *without* `output_config` on DeepSeek answering the generic `400 Invalid Anthropic Messages API request` (footnoted in the report as the A/B combination). If it still reproduces after upgrading, please attach that 400's complete body — especially the path inside `metadata.raw` — as requested.

Not verified against a live OpenRouter account from my side (no key here); the above is code-level confirmation at tip plus the reporter's v0.1.1734 live confirmation of B.

Thanks @magicseek for the report and @JoeyWu-tech for the patch.

AI use: analysis performed with AI assistance; all code reads above were run locally at e17b6cefc.
