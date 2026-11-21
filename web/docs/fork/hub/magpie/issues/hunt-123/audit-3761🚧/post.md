Thanks @coffe01-10 for the report — the numbers you see are real, but the missing cache counts come from Kiro itself, not from magpie's parsing, and the cost side already has a path.

What Kiro says
---

Kiro's usage tells credits only, never tokens — no `cache_read_input_tokens`, no `cache_creation_input_tokens`, and its `input_tokens` lumps the cached reads in with the rest. This is the vendor's own shape (zeewell on X, and the plugin's records agree), so there is nothing in the response for magpie to parse apart. On the standard Anthropic chain the cache fields are parsed as they come (`internal/gateway/anthropic.go`, `aUsage`: `cache_read_input_tokens` → `Usage.CacheRead`, creation split by 5m/1h TTL) — Kiro simply never sends them.

What magpie already does about it
---

- A plugin's usage that says its vendor gave no cache counts is marked `magpie_cache_unknown` on the way through (`anthropic.go:1390-1394`, built for exactly this Kiro shape), so the zero cache column is read as "the vendor said nothing", not as "nothing was cached" — the dash the usage views show there is deliberate.
- The Kiro credits themselves — the number Kiro *does* report — are being wired into the ledger by the patch in #4328 (`aUsage.credit`), so the row that matches Kiro's own settlement will be there once that lands.
- The "cache reads billed as full input" you observe is Kiro's `input_tokens` saying so: the vendor's counter includes the cached reads, at whatever rate Kiro then discounts internally. Magpie cannot split a counter the vendor reports as one number.

What would actually align the cost
---

Not a cache-rate guess, which would invent a split the vendor never states: the credits column from #4328 is the figure Kiro settles in, so cost checks against Kiro should read that, and the input-token figure stays the vendor's own lumped count. If Kiro starts reporting token-level cache fields, the standard Anthropic parsing picks them up with no change.

Not verified: no Kiro account was asked from here (the vendor shape is on record from the plugin's own logs and the zeewell note cited in the code); the #4328 credits patch is in review, not yet in a release.

AI use: analysis performed with AI assistance; all code reads above were run locally at the current main.
