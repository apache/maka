Verified the report's current-state table against `main` (`a3768cdd1`) — all five rows check out:

| Request class | What main sends today | Where |
| --- | --- | --- |
| Agent inference | `magpie/<version>`; the inbound Agent UA where the provider passes it on and the agent sent one; a `User-Agent` set in provider headers wins over both at signing | `internal/gateway/user_agent.go` |
| Model list | `User-Agent: magpie` — bare, no version | `internal/catalog/live.go` (`fetchPage`) |
| Provider test | no common default UA; test-as-client shapes set coherent codex profiles (`User-Agent` + `Originator` + `Version`) | `internal/provider/test.go`, `internal/provider/test_as.go` |
| Balance | no explicit UA, so Go's transport sends `Go-http-client/1.1` | `internal/provider/balance.go` |
| Quota/usage | no explicit UA on the paths I checked (`planquota.go`) → same | `internal/provider/planquota.go` |

Two details worth adding:

- The bare `magpie` on model-list dates back to the rename commit (402a96c39), before the versioned `magpie/<version>` existed on inference. So Magpie already disagrees with itself about its own product identity today, independent of any per-class policy question.
- Provider `Headers` already reach model-list (`PutUserHeader` replaces the default, `User-Agent` included) and balance (`SentHeaders`), and win over the defaults on inference at signing. A per-provider override exists on most paths already; the real gap is per-operation scoping, as the report says.

On evidence: I found no first-hand failure attached for the Magpie-originated classes — no relay shown rejecting balance/model-list for `Go-http-client/1.1` or bare `magpie`. #3851 is real and well-evidenced, but it is a different surface: a mixed *inbound* Agent identity (Desktop UA + TUI originator) forwarded on inference, tracked there. Per-class policies for Magpie-originated requests would not change that case.

That leaves two separable paths, and the second is a maintainer design call:

1. **Unify the baseline (small).** Every Magpie-originated request gets the same `magpie/<version>` UA by default: model-list drops the bare `magpie`, test/balance/quota gain it. No config-model change; provider `Headers` keep winning where they already apply. A few lines, and upstreams see one coherent Magpie marker.
2. **Per-request-class policies (this proposal).** `magpie` / `agent_passthrough` / `client_profile:<name>` / `custom` per class, provider-wide `Headers` as fallback. Bigger surface: config schema, precedence against `passUserAgent` (#1851) and the test-as profiles, and hard to verify until the upstream-header visibility of #2495/#3672 lands — a policy nobody can observe is hard to trust or debug.

If some relay is concretely rejecting balance/model-list over the missing or bare UA, that evidence would justify doing (1) now. Otherwise (2) is worth deciding after #2495/#3672 make what is sent observable.
