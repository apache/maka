Took this one. AI-written — I re-ran every check below locally today under ggbdpq's lane. The short answer: **the generalization you ask for is already on main — it landed in `0ad0f4241` on 2026-11-06, four days before this issue was filed, and first shipped in v0.1.3138.** Your build (v0.1.3078) predates it, which is why the A/B still fails there.

**The landing is exactly this report.** [`0ad0f4241`](https://github.com/yetone/magpie/commit/0ad0f42411a54a91edabc0cdfcab396e94e62365) ("gateway: Ollama's options reach no Chat upstream, so Hermes Agent's requests to Mistral are not turned away", reported by lijiho96940561 on X) walks the same chain — Hermes takes the gateway for an Ollama server, injects `extra_body.options.num_ctx`, Mistral answers 422 `extra_forbidden` on `["body","options"]` — and does what your title asks: #3097's gemini-only cut became `withoutOllamaOptions`, applied to **every** relayed Chat body (`internal/gateway/gateway.go`, the Chat relay path), so Gemini (#3097, and #3716's Google case), Mistral, Groq and any other Chat upstream get the body without its top-level `options`. The cut is byte-preserving everywhere else (`withoutTopMember`: a body without the word isn't parsed at all, and a tool parameter named "options" is left as it came). Version containment checked: `0ad0f4241` is an ancestor of v0.1.3138 but **not** of v0.1.3078.

**Re-verified on current main `ca7a39291` today**, not just cited:

| Check | Result |
| --- | --- |
| `TestHermesOllamaOptionsNeverReachMistral` (Hermes' body — `options:{"num_ctx":…}` beside `reasoning_effort:"medium"` — against a fake upstream answering Mistral's real 422 shape) | green; 1 upstream call, no retry, no strip on the tool's own `options` parameter |
| `TestChatRelayLeavesOutOllamaOptions` (options reach neither Gemini nor Kimi) | green |
| Ablation redone by hand: the `body = withoutOllamaOptions(body)` line removed (`git diff --stat`: 1 file, 1 deletion) | both tests red — the fake Mistral draws the report's exact `extra_forbidden` on `loc:["body","options"]` — restored → green |
| Version containment (`git merge-base --is-ancestor`) | in v0.1.3138+, not in v0.1.3078 |

NOT-RUNNABLE here: a real Mistral key (api.mistral.ai answers 401 before it validates the body, as the landing notes too); the fixture carries the error shape verbatim from your log.

**On your two options, point by point:**

- **Option 2 (strip for every non-Ollama upstream) — done, and slightly past it.** Translated requests never carried `options` (they are built from the request's own fields; the request struct has no such member), and the native Ollama route's body builder consumes runner settings itself (`ollamaChatBody` maps only what a Chat API reads — temperature, top_p, seed, the penalties, stop, `num_predict`→`max_tokens`, `format`→`response_format`, `think`→`reasoning_effort`; `num_ctx` and friends never go upstream). The Chat relay path was the one gap left, and it is now closed unconditionally.
- **Option 1 (`options` in the refused-optional set) — superseded.** With `options` never relayed there is no failed call to drop and remember. And for the fields that *are* in that set (`store` #393, `metadata`, `service_tier`, …), the retry path already reads Mistral's dialect: `unsupportedOptionalField` walks `message.detail[]` and matches `extra_forbidden` with `loc: ["body", <field>]` — so that machinery is Mistral-422-literate today, which is what carries #393 on Mistral.
- **Sibling Ollama-only keys (`think`, `keep_alive`) — deliberately not stripped yet.** On the Chat relay path there is no known sender: Hermes' own injection is `options.num_ctx` only (its plugin source, cited in the landing), Ollama-dialect clients reach the gateway's `/api/chat` whose body builder consumes those fields, and magpie's own translated bodies never carry them. Stripping fields nothing sends would be speculative — if you have a client actually putting them in `extra_body`, one capture of such a request is all that's needed and the same one-line strip covers them.
- **`/api/show` answering in Ollama shape — kept by design** (VS Code's and Visual Studio's Copilot need it, and a client can't be told from Hermes there). Your "the gateway is the layer that knows the upstream is not Ollama" point is exactly where the fix sits: the shape stays for the client, the field goes for the upstream.

**Suggested resolution:** close as fixed in v0.1.3138 — once your install updates past it, the A/B should return `200` on both calls (B's `options` is gone before the upstream sees it, in one call). If B still returns 422 on ≥ v0.1.3138, please say so with the `app.log` line — that would be a regression worth its own report.

Generated-by: GLM-5.3-Flash (ZCode)
