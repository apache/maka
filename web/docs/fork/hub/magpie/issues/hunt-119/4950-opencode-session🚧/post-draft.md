I took this to hunt it and ran the gateway's own session machinery against a recorded fake of OpenCode's gateway (tip `c86fa2a34`). The header instability this issue suspects is not what the code does — but the probes found the mechanism your own observation points at, and it explains every number in the report.

## What the probes show

A bare `/v1/chat/completions` caller (no session headers, like your agent), three turns of one conversation, every header magpie sends compared turn over turn:

| Probe | Result |
|---|---|
| 3 turns of one conversation, all headers diffed turn over turn | zero changes outside `b3`/`traceparent`'s new span on the same trace — same `x-opencode-session` (and the other 3 session headers), same User-Agent, same `x-opencode-project` |
| Two conversations whose first user message differs only in the task | two different sessions |
| Two conversations whose first user message is **byte for byte the same** | **one shared session** — all requests, both conversations, the same `ses_…` (conv `magpie-ee464ca38e08ee9a…`) |
| 1200 interleaved conversations around one conversation's turns | that conversation's session changes (the keep-table holds 1000); dozens of parallel conversations stay far under it |

And between 0.1.2616 and 0.1.2679 the OpenCode session surface did not change: `git diff v0.1.2616 v0.1.2679 -- internal/provider/opencode_client.go internal/gateway/opencode_session.go` is empty, and nothing in the window's gateway.go changes touches session derivation or these headers.

## Answers to your five questions

1. **What the four session headers carry**: one value for all four. For a caller with no session identity it is derived from the conversation's first user message (`conversationID`, sha256 of that message, `magpie-<12 hex>`), mapped through a keep-table to an OpenCode-shaped `ses_…` id (`openCodeSeed` → `openCodeSession`, internal/gateway/opencode_session.go, internal/provider/opencode_client.go). Priority: your own `x-opencode-session`, then any session header agents already send (Codex's `session_id`, `x-claude-code-session-id`, `x-conversation-id`, …), then the body's `prompt_cache_key`, then the first-user-message hash.
2. **Same conversation, same value across turns?** Yes — the keep-table maps the seed to one id and returns it for the next turns (capacity 1000; a conversation squeezed out by 1000 newer ones would get a fresh id, which your "dozens of parallel conversations" never reaches).
3. **A client's own `x-opencode-session` forwarded as is?** Yes, verbatim (a pinned test holds it: the client's session goes out unchanged). Any of the session headers above names the conversation for the derivation too.
4. **Session headers in the routing log?** Not today: `logOpenCodeRefusal` records header names and the session's first 8 characters only when OpenCode refuses a request. Recording the sent session's hash per request would be a small, contained addition if the maintainers want it.
5. **Anything changed between 0.1.2617 and 0.1.2679?** Nothing on this surface (the diff above).

## What the loss most likely is

Your own observation in the issue is the mechanism: all of the agent's parallel conversations share one conv per time window (as in #3938). When those conversations' first user message is the same template text, they all share one upstream session — the probe reproduces it — and OpenCode's per-session cache affinity then serves dozens of interleaved prefixes from one session's cache. Every observation fits that without any magpie change:

- resend the same request seconds apart: it hits (nothing interleaved in between);
- the next turn of a conversation: misses (other conversations' requests evicted the prefix in between), and the turn after recovers once its own prefix is cached again;
- direct connection with a fixed session: one conversation alone against the gateway, nothing to evict it — all hits;
- 94–96% in the small hours vs 38–73% in the evening on the same version: the hit rate tracks parallelism, not the magpie version (0.1.2616's window was 00:00–03:00, 0.1.2679's was 18:00–24:00).

**The test that would settle it**: have your agent send `x-opencode-session` (any stable per-conversation value — magpie forwards it verbatim). If the hit rate recovers while the parallel conversations keep running, the shared-session mechanism above is confirmed; if it does not, the next suspect is upstream-side (its per-session cache eviction under load), which the same A/B script would isolate.

Not verified: no OpenCode Go account here, so nothing of the vendor's cache internals is observed — the eviction mechanism is inference from your numbers plus the shared-session probe; the probe fixtures are synthetic (recorded shapes, not your traffic).

---

**Attribution**: AI-written analysis; the probe test and its output are mine and attached to this report's working notes. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
