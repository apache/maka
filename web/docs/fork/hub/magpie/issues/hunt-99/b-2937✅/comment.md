Thanks — this is exactly the kind of field data this issue needed. The before/after numbers (35% → 98.21% weighted hit rate, all 8 zero-hit turns followed by a cached hit on the next turn of the same session) support the premise both sides here work from: the cache identity just needs to be present and stable. The account-fixed table in particular closes the rotation explanation I'd have reached for first.

One update before your questions: main moved on this today. `6e331afb` — postdating both your comment and the `c3b0484a` you read — fills a cache identity by default when a Chat/Responses request has none (`ownCacheKey`, `cacheKeyOf` in `internal/gateway/gateway.go`). The capability scoping is what you asked for in point 1: OpenAI's own API with a key, and a provider the user added by its address (which may be a relay like yours), get the fill; a vendor's preset, a signed-in account, a plugin, Bedrock and Vertex get nothing new. The shape is your point 3: `cacheKeyOf` is a sha256 digest — `"session\0"` plus the session when there is one, else a digest of the first user message as a defined fallback, never a raw id surfaced upstream — an explicit client key wins, a provider whose extraBody names the field keeps the user's value, and an upstream whose 400 names the field is asked once more without it and not sent it again.

On your question 2 — a generic subagent variable — that shape already exists as a proposed patch on this issue (posted here Oct 20), and it composes with the new default rather than competing with it. `${subagentId}` resolves to the request's Claude Code subagent id (`x-claude-code-agent-id`, which the gateway already parses as `subOf`): a subagent's turns send it, the conversation's own turns never do. A provider composes the identity explicitly:

```json
{"prompt_cache_key": "${sessionId}:${subagentId}"}
```

It stays opt-in: an extraBody value without the placeholder goes out byte-for-byte as before, `${sessionId}` alone means what it always did, and since an extraBody naming the field is one of the providers the default fill skips, the explicit value is the one sent. I rebased the branch onto current main (`8c5c83c9`) today and re-ran the targeted tests: `TestExtraBodySubagentId` and the extraBody family in `internal/gateway` and `internal/provider` all pass, alongside main's new `TestOwnCacheKey`. Docs note included.

Branch with the commit: [hunt50-e-sessionid-cache](https://github.com/ggbdpq/magpie/tree/hunt50-e-sessionid-cache) (head `3ddcadd1`).

One fact worth putting beside the default: `cacheKeyOf` is conversation-scoped. It hashes the session — which a Claude Code subagent sends with its parent's id, the observation this issue opened with — or the first user message, with no subagent signal in it. So on the default path a conversation's subagents now share one key: the overload shape this issue reported applies to users who never configured extraBody, not only to those who did. Whether the default digest should fold the subagent in, or stay conversation-level and leave per-subagent keys to explicit extraBody, is a design call for @yetone — and your point 2 (no evidence so far that every upstream wants a distinct key per subagent) is the right counterweight from the other side.

written with GLM-5.3-Flash (ZCode)
