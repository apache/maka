I took this. The 400 is Anthropic's own words arriving through magpie unchanged, and magpie's handling of it is its designed credit semantics, so there's no patch here — but the "same key works directly" half is worth pinning down, because it points at the request, not the key. Credit @AlstonChan for the precise timeline.

**What magpie does with that 400, by design**

- The body's words ("credit balance … too low") match the credit classification (`creditWords`), the failure is marked `fail: credit`, and a bare API key rests on the credit ladder — 30 minutes first, one rung up each time it fails again after a rest has ended (`creditBackoff`; a vendor-named reset or Retry-After would be honored instead). This is the same machinery that keeps a spent key from being hammered; it isn't a judgment that your key is dead forever, and `magpie provider quota-rest <id> <time>` overrides the ladder if you know the reset time.
- The 200 on the `claude` (subscription) member while you believe its weekly limit is spent is that member's own windows — a subscription turn succeeding says nothing about the API key's balance, and magpie's rest of the `anthropic` member is what made the group fall over at all, which is the group doing its job.

**Why the same key can pass directly and fail through magpie at the same minute**

Anthropic's "credit balance is too low" is about the **estimated cost of the request**, not only the balance spent so far — magpie's own classifier carries the same distinction for OpenRouter's phrasing ("requires more credits, or fewer max_tokens … can only afford N" rests briefly and doesn't climb the ladder; `creditSoon`). The two requests are not the same request:

- Through magpie the client is Claude Code: big system + tools, and its prompt-caching `cache_control` writes, which are billed at a write premium — a larger estimate.
- Direct from opencode: a different, smaller body — very likely no caching writes and a smaller `max_tokens`, a smaller estimate that still fits the remaining credit.

So the sequence in your log is consistent with a key whose remaining credit crossed below Claude Code's estimate between 14:53:51 (the last 200) and 15:01:42, while opencode's smaller ask still fits.

**Three steps to settle it**

1. Check the console balance now. Near zero → everything above is the whole story; top up or let the group carry it (it already does).
2. Replay magpie's exact body directly: the request record shows the try; take its `max_tokens` and body (key redacted) and `curl` Anthropic with it. If it 400s directly too, the request is the trigger, magpie relayed faithfully, and the classification is right.
3. If the exact same body still returns 200 directly at the same minute, that would be a magpie request-shape bug — post the request record (headers redacted) and I'll dig into what the relay changed.

**Not verified:** no Anthropic API-key account here, and your direct call's body/max_tokens weren't shared, so the estimate-gap reading is inference from the code paths (`creditWords`/`creditSoon`/`creditBackoff`, the relay keeping `max_tokens` as sent) and your timeline, not a reproduction.

AI use: analysis written with GLM-5.3-Flash (ZCode) from a code read of the repo; no requests were sent to any upstream.
