This post and its patch are written by an AI (GLM-5.3-Flash via ZCode) and authored by ggbdpq. The diagnosis, the production change and the live Windows verification are clhchan's own, from the report — this is that patch reworked onto current main (`b96847c3d9f`), with the tests and the evidence below rebuilt here. Credit for the report and the working fix is theirs.

**What's wrong**

A relay fronting Azure OpenAI that spreads one key over several resources answers a conversation another of its resources began with a persistent 400 — "The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it." — and a Smart routing-group request ends on it: no healthy alternative is tried, the failing relay takes no rest, and the next client request can select the same relay again (#5932). The reporter's live Windows install showed eight group requests in five minutes, each on the failing relay, no `rest` record, some traces returning to it from the working spare on affinity `why: "back"` — and `restCap: 720` could not help, because the error never entered the rest path.

**Root cause**

`prevForeign` ([`internal/gateway/prev_response.go`](https://github.com/yetone/magpie/blob/main/internal/gateway/prev_response.go)) already recognizes this refusal, and the passthrough path already asks once more with the ids magpie owns taken out. But when no repair is available — Codex sends its own full history with `store:false`, so there is nothing of magpie's to take out — or the repaired ask is refused again, the refusal reaches `retryable` in `internal/gateway/fallback.go`, and it is not counted: the `case status == 400, status == 422` word lists (quota, unserved, refused, shape, unsaid, region, wrong-endpoint, upstream-failed, reasoning-back) match none of these words. So the group's try loop stops: no failover, no rest, next request back on the same relay.

**The fix**

The report's five-line production change, reused whole, on the current shape of the switch:

```go
case prevForeign(status, raw):
    // a relay's Azure resource cannot read this history (its own
    // refusal, 400). Passthrough has already tried repairing the
    // items it owns; another member may answer, and the failing
    // relay takes its normal error rest (#5932)
    return true
```

A successful repair still returns normally and rests nobody; an ordinary input-validation 400 still reaches the client without failover; `rest-cap off` and last-candidate behavior are unchanged; no new timer, no more history discarded, and the history-reconstruction / previous-response-pointer policies around #4478, #5477 and #5733 are untouched.

`gateway: a relay's Azure resource-mismatch 400 fails over and rests the failing relay (#5932)`, branch [`fix/5932-azure-400-rest`](https://github.com/ggbdpq/magpie/commit/d5376482be5f8060799ac9f361865d86f75ae622) on `b96847c3d9f`:

```sh
git am https://github.com/ggbdpq/magpie/commit/d5376482be5f8060799ac9f361865d86f75ae622.patch
```

sha256[:16] = `fe2692fec35dfffd` · `git am` into a clean tree at `b96847c3d9f`: zero conflict.

**Reproduction and verification** (this machine, darwin, `-tags nogui`)

| Check | Result |
| --- | --- |
| `TestAzureResourceMismatchFailsOverAndRests` (new; the report's own test) | red before the change — client 400, spare called **0** times, relay once without stored history (`store:false` full history) and three times with the first turn and the refused repair in — then green: the spare answers, the failing try carries `rest.by:"backoff"` with the original error in it, and the next group request skips the resting relay |
| `TestAzureResourceMismatchLeavesOtherBadRequestsAlone` (new; the report's negative control) | green: a `messages: field required` 400 reaches the client, one try, no rest, spare untouched |
| `TestPreviousResponse*` (7), `TestUnknownPreviousResponseRelayedAsSent`, `TestNoFallbackForOtherErrors`, `TestRestCapOr`, `TestRestCapOff`, `TestOneRequestDoesNotClimbTheBackoff` | all green, then green again with `-race` (the report's list in current main's names; its `TestBackoffOneRequest` is now `TestOneRequestDoesNotClimbTheBackoff`) |
| pre-existing red on this machine | `TestMothX`, `TestProxyCheckSaysAProxyPassedBy` — red on the parent commit `b96847c3d9f` too; `TestLaneLimitRoutes` passes here with `-tags nogui` |
| real Azure relay, real Windows EXE | NOT-RUNNABLE here — covered by the reporter's own live verification (routing log: failing relay 400 + `rest.by:"backoff"`, spare 200, final 200; the next route on the spare alone) and the fixtures above, which pin the report's exact refusal text |

**Ablation**

The `prevForeign` case taken back out of `retryable` (the patch's only production hunk; the build stayed green, so the red is semantic): both resource-mismatch cases red again exactly as the pre-fix run (client 400, spare 0); restored → green.

**Sibling scan**

`prevForeign` is written nowhere else; its other reader, the passthrough repair, is untouched. Every other `retryable` reader takes the refusal the same way now — route-problem semantics everywhere, none touching the repair:

- `decide_group.go` group try loop — the fixed path: next candidate answers, failing try rests.
- `decideFailed` (System One groups) — rests its candidate for this refusal, same as a chat group's try now.
- a stream error frame naming a 400 (`gateway.go`, `failedNamed`) — no longer "the request's fault"; falls to `lateRests`, and `refusedWords` (`unapproved channel|illegal api invocation`) does not match the refusal, so the failing candidate rests, as it would before any stream.
- `refusal_handover.go` `eventError` after thinking began — hands the turn to the next candidate instead of ending it.
- `holdWriter.failed` — a held reply with this refusal lets another provider answer.
- `draw.go` / `video.go` — their next candidate is tried; no foreign history rides a fresh generation, so this only moves a relay artifact along.
- `6a253f8af` (the report's v0.1.3545 base) → `b96847c3d9f` on `fallback.go`, `prev_response.go`, `decide_group.go`: three commits (Never-a-fallback, a pooled model refusal resting the model not the key, Codex auto-review), none touched `retryable` or `prevForeign` — the gap on current main is exactly as the report found it on v0.1.3576.

Generated-by: GLM-5.3-Flash (ZCode)
