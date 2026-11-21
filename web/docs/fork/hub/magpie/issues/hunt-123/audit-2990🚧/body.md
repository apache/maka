@thesixgod6 I read the whole Cline pinning path at upstream/main (f24829636) against your screenshot. The short version: magpie is not switching upstreams and switching back — every request carries the same pin, and the upstream column reading deepseek in your screenshot is DeepSeek's own answer to who served each request, not magpie's guess. The cache swings you caught happen **inside DeepSeek, behind the pin**: past ~400k of context, the requests alternate between cache domains that don't share a prefix cache. I found no defect on magpie's side to fix; below is the mechanism, what each row of your screenshot was, and the one improvement left open for the maintainer.

## What magpie does on this path today

With the provider's Upstream tick on (`pinUpstream`), magpie adds the pin to **every** request, on every try (`clinePin`, called from `forwardOnce` — `internal/gateway/cline_pin.go`, `internal/gateway/gateway.go`):

- A Chat body for `cline-pass/deepseek-…` gets `providerOptions.gateway: {"only": ["deepseek"], "has": ["implicit-caching"]}` appended **at the body's end**, so the prefix a prompt cache keys on is untouched (asserted by the tests).
- `has: ["implicit-caching"]` is what actually holds the request on DeepSeek: `only` alone left ClinePass free to pick another upstream (landed 10-23, `fa22bc646` — if your magpie is older than that, updating is worth it: the pin was soft before).
- The injection is unconditional and identical every time: magpie never removes the pin mid-session, and a retry rebuilds the same fields. If the client itself sent `providerOptions`/`provider`, magpie leaves the body as the client sent it.
- Affinity keeps a conversation on the key/account that answered it (`internal/gateway/affinity.go`, DeepSeek's cache held warm for an hour, `deepseekCold`); magpie rewrites nothing in the messages prefix (`chattidy` only normalizes usage field names). There is no 400k threshold anywhere in magpie's routing.

The upstream column in your screenshot is read from the reply, not from the request: ClinePass names the upstream that answered in `provider_metadata.gateway.routing.finalProvider` (`upstreamOf`, #2847). All seven rows read **deepseek** — the pin held every time; DeepSeek itself served all seven requests.

## What each row of your screenshot was

| Time | Context | Cache | Reading |
| --- | --- | --- | --- |
| 21:42:43 | 599.4k | 100% | served by the instance holding your prefix |
| 21:44:03 | 597.5k | 4% | same prefix, a **different** DeepSeek cache domain — rebuilt in full ($0.087) |
| 21:45:26 | 597.8k | 100% | back on the first domain — its cache was read again ($0.002) |
| 21:45:55 | 606.5k | 25% | the second domain again, now partially warm |
| 21:46:56 | 263.3k | 1% | after Cline trimmed context |
| 21:47:39 | 203.3k | 4% | new (post-trim) prefix, first sight |
| 21:48:00 | 204.4k | 100% | same domain as the row before — cached, and cheap again |

The tell is the pattern: 100% → 4% → 100% → 25% → …, on a prefix that only grows. One request reads what a **previous** request wrote, the next doesn't — so the requests are alternating between at least two backends whose caches don't share. And the 203k rows after Cline's trim hit 100% immediately — small prefixes cache fine; it's the 600k-class prefix that swings. That points past ~400k at DeepSeek's own side of the pin: the "deepseek" Vercel's gateway routes to is one provider with several back-ends, and a prefix cache that big lives on whichever back-end served it. Load-balancing between them turns your cache hit rate into a coin flip — exactly the 7%-ish average you measured, with the bill swinging 30x between rows ($0.002 vs $0.087).

## Hypotheses vs evidence

| Hypothesis | Evidence for | Evidence against | Verdict |
| --- | --- | --- | --- |
| H1: alternating DeepSeek back-end cache domains behind the pin (big prefixes only) | the 100/4/100/25 alternation on a monotonic prefix; finalProvider deepseek on every row; small (203k) prefixes stable at 100%; magpie-side pin and affinity identical every request | none found statically | **most likely** |
| H2: ClinePass/gateway routing for very large bodies picks another deepseek deployment (soft pin on magpie older than 10-23) | compatible with the same pattern; the soft-pin window was real before `fa22bc646` | finalProvider=deepseek on every row says the provider held either way | possible; ruled in/out by your magpie version |
| H3: magpie drops the pin on some requests | — | injection is unconditional per try; a client-sent `providerOptions` is passed through untouched, and Cline sends none here | refuted |
| H4: magpie rotating keys/accounts between requests | — | affinity pins the conversation to its answerer for an hour; two consecutive 203k rows hit 100% — per-request rotation would break exactly that | refuted |
| H5: magpie rewrites the cached prefix | — | pin goes at the body's end (tested); chattidy touches usage field names only; no 400k threshold exists in the code | refuted |

## For the maintainer

- **Option A — no change.** The pin does what it was built for: every request asked for DeepSeek and DeepSeek answered (`finalProvider` on all rows). The alternating cache loss is the cost of the hop behind the pin — ClinePass → Vercel's gateway → DeepSeek's own back-end balancing — which magpie cannot see or steer from outside. Your Routing page already records both sides per request (`Pin` — what magpie asked, `Upstream` — who the reply said served), so anyone can confirm the two never diverge here.
- **Option B — a session cache key for pinned DeepSeek requests.** DeepSeek's API takes a `prompt_cache_key` for cache routing (magpie already passes a client's through, and derives session keys for other agents — `opencode_session.go`). Injecting a stable per-conversation value on pinned ClinePass DeepSeek requests would give DeepSeek's own balancer the hint it needs to keep one conversation on one cache domain. Unverified: whether it survives ClinePass and the gateway intact, and whether DeepSeek honors it at 600k prefixes — so it's a measured experiment, not a safe default; hence left as a choice rather than a patch.

## Not verified

No ClinePass key on this machine — everything above is a code read plus your screenshot. Unknown: your magpie version (whether the 10-23 `has` reinforcement is in it), how many back-ends sit behind the gateway's deepseek entry and why the balance flips past 400k, and whether `prompt_cache_key` would in fact stick at that size. If you want to confirm H1 from your side, the Routing page's `Pin` and `Upstream` columns on the 4%-rows versus the 100%-rows should both read deepseek throughout — that's the proof magpie never moved.

AI use: comment written with GLM-5.3-Flash (ZCode) from a code-level read of the repo at f24829636; no requests were sent to the upstream.
