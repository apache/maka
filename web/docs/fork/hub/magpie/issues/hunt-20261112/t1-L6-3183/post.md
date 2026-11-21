Read the gate at today's main (`f6c882ad7`, which carries the 30-day stick from `45dfdd998`). Your timeline is real in the code, and the direct answer to your question is: **the gate is not meant to rely on the spawning turn being recorded first** — the log fallback exists precisely because affinity can miss (#1367) — but that safety net has two gaps a fresh conversation's first spawn can fall through.

**The order you describe is structural.** The gate reads `leadProvider(scope, parent)` — the affinity stick — then, if the reader set doesn't take it, falls back to `loggedAnswerers(parent, conv)` (gateway.go, the `sealedTask` block). A stick is written only when an answer completes (`answered`, affinity.go, called with the call's usage once the turn is done), never while the request is out. Codex spawns the subagent mid-stream of the lead's turn, so the subagent's first request structurally precedes the stick the spawning turn will write. Subagent #2 at +33 s found both lookups; subagent #1 at +21.0 s, 0.6 s before the spawning turn's row, had neither.

**Why the +12.5 s row was invisible is the open half.** Two candidates, and your data doesn't yet tell them apart:

1. **The fallback reads the shared snapshot, not the file.** `loggedAnswers` → `usage.VisitSessions` → `readLogSnapshot()`. While appends keep the file inside the settle stamp (`logStampSettle` = 1 s), a reader keeps the previous snapshot without re-hashing — #4368's own comment: "Still in the stamp's tick: hashing the log again proves nothing a read a moment earlier wouldn't have". Under traffic appending more often than once a second, the snapshot — and everything this fallback sees — lags until a quiet second. Your +12.5 s row could be in the file but not yet in the index the gate reads.
2. **Or the row never matches.** `loggedAnswers` matches Session/NativeSession against the ids the gate passes; if the lead's first turn recorded a different session id than the `parent` the subagent request names, the row is never visited — and the same mismatch would explain why the stick that turn's completion wrote wasn't found either. Your subagent #2 finding both lookups at +33 s says the spawning turn's ids do match, so a mismatch would have to sit between the two lead turns, not between lead and gate.

What would tell them apart: the +12.5 s row's Session/NativeSession value next to the parent id the subagent request carried, and whether other calls were completing on that instance in the +12.5 s→+21.0 s window.

**Fix directions — the maintainer's call, each with a cost**, since the gate is deliberately fail-closed (a sealed task handed to a provider that didn't answer the lead is the `invalid_encrypted_content` failure 3b961f294 fixed):

- The one you suggested — count the in-flight answerer. Routing already remembers where a conversation's un-answered request went (`sticks.opening`, "who a conversation that nobody has answered yet was sent to, while its first request is out") — but only on multi-candidate routes, and it is deleted the moment the answer lands. A gate that also consulted the in-flight record for the parent would cover exactly your window.
- Force a settled read for this one lookup (bypass the settle stamp), at the cost of a re-hash on every sealed-task miss.
- Binding at dispatch instead of completion would stick the conversation to a provider that may then fail the turn — that shape is probably worse than the hole.

Not verified: your relay's real traffic — this is the code at `f6c882ad7` plus your timeline; I didn't replay a Sub2API relay.
