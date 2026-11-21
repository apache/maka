A patch for this, as a branch: [`ggbdpq/magpie`, `fix/3106-compaction-silent-assistant`](https://github.com/ggbdpq/magpie/compare/main...ggbdpq:magpie:fix/3106-compaction-silent-assistant), head `cbf216af738ef5f275bb9298e301705401026509` (on `yetone/magpie` `f24829636`). `git am -3` copy: sha256 `2eed81a86822e34d…` (attached below as a file comment would not carry it — applied clean on `f24829636`, its compact tests green).

**What happens** — as reported: every ordinary turn of the conversation is answered `200`, but the summary request is answered `400 "Invalid assistant message: content or tool_calls must be set"` on every model of that upstream, while a laxer upstream answers the very same request `200` — the request's shape, not the model.

**Why** — the turn a network drop interrupted stays in the conversation as an assistant message with neither content nor tool_calls. Ordinary turns survive it: `withoutSilentAssistants` (#2599) leaves such turns out of what a Chat upstream is sent, on both paths a Chat body takes (`buildChat`'s translation, `silentAssistantsOut` on a relayed one). But Codex's compaction is the one request that carries the whole conversation, so the one that still holds the turn. And `codexCompact` already asks again with the conversation as plain text when the summary request is refused for its endpoint (404/405/501), an item id it doesn't have, "Upstream request failed", a protection refusal, or its size — a refusal of the messages' *shape* is in none of those lists, so the `400` went straight back to Codex, the compaction aborted, and the turn reconnected (five more `400`s two seconds apart in the `usage.jsonl` lines above).

**The fix** — `refusesMessages`, a `400` whose words are about the messages themselves: the reported `Invalid assistant message: content or tool_calls must be set`, or the tool exchange a strict chat template refuses (`must be a response to a preceding message with 'tool_calls'`, `must be followed by tool messages responding to each 'tool_call_id'`). It goes with the other conditions on the plain-text ask, which has no assistant turns to refuse; when that fails too, the summary is magpie's own, as with the other refusals. So the recovery that saves the other four cases saves this one — the compaction completes as text, or locally, instead of aborting.

**Verification** — TDD, red before the fix:

| Check | Result |
| --- | --- |
| `TestCodexCompactMessagesRefusedAsksAgainAsText` (new; the reported `400`, then the text-only ask — Codex gets a `magpie1:` compaction, the upstream saw two requests, the second with no assistant turns in it) | red without the fix (`400` handed back as it came), green with it |
| `TestMessagesRefusedOnlyMatchesBadRequestShapeErrors` (new; matches shape words at `400` only — not `relayApex400`, not an empty body, not at `500`, not at `401`) | green |
| ablation (condition lifted from the retry list, tests kept) | red again — Codex gets the `400` as it came |
| `go test -tags nogui -count=1 ./internal/gateway/` (whole package) | ok, 707s, zero failures |
| the same, compact suites only, after rebase onto `f24829636` | ok, 16s |
| `gofmt -l` on the two files / `go vet -tags nogui ./internal/gateway/` / `go build -tags nogui .` | clean / clean / builds |

Credit where due: the #2599 follow-up framing, the retry-list gap and the word list above are LionGaokk's analysis and branch (`codex-compact-shape-refused`); this patch implements the same recovery independently on the current tip. As reported there, the item the upstream refused could not be pinned from outside — every silent-assistant shape built by hand is answered `200`, and `silentAssistant` already covers all of them — so this stays a recovery; narrowing the root cause still needs the request body that was refused.

AI use: written by GLM (ZCode), committed as `ggbdpq`.
