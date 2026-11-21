Took this and read the whole chain — good news: this exact refusal is already mended on current main, in a fix that landed the day after your captures. Credit @MOMO0302-02 for the verbatim error text, the exact gateway log window, and the two-line root cause ("the `tools` list differs from the one this block was created with") — that is precisely what Anthropic's newer binding checks, and precisely where the fix went.

**Why it happens**

Anthropic now signs a thinking block for the conversation *and* the request shape it was made in: when the `tools` list sent now differs from the one the block was created with, the signature no longer verifies and the whole request is refused ("bound to a different conversation"). Codex hits this inside one conversation — its tools load on demand via tool search (magpie carries those as deferred tools, #2660), and an MCP server change reshapes the list too — so a replayed history that carries signed thinking blocks suddenly prefixes differently.

**The fix, already on main**

`764a032f6` (2026-10-30; first numbered release containing it is v0.1.2157 — your 0.1.1990 predates it by a day, and the four 400s of 10-29 12:07 +08:00 fell in exactly that gap). It teaches `forward` — which every Anthropic-protocol route goes through, the translated Codex→Anthropic path included (`forwardTranslated` → `forward`) — to read that refusal (`internal/gateway/thinking_bound.go`):

| Step | Behavior |
| --- | --- |
| 400 read | the refusal's wording (yours matches: "Invalid `signature` in `thinking` block ... bound to a different conversation") marks the named block and every thinking block after it, remembered per provider and account |
| re-ask | the same request goes out once more without them; an assistant message left empty is dropped |
| next turns | those blocks are left out up front (`withoutRefusedThinking`), so the conversation continues instead of spending a request on the refusal every turn |

A separate pre-strip added 11-03 (`withoutForeignThinking`) drops blocks whose signature is another vendor's shape before Claude sees them; yours, signed by Anthropic itself, go through the mending above.

**On your two suggestions**

| Option | Reading |
| --- | --- |
| send `anthropic-beta: thinking-binding-controls-2026-08-01` with `prefix_mismatch_behavior: "drop_block"` | deliberately not done: Claude Code sends that beta only behind a flag, and magpie doesn't mimic Claude Code's flags (the fix's own note). `drop_block` would also silently drop blocks that prefix-mismatch for reasons worth seeing once, where the reactive drop leaves them out only after Anthropic itself refuses |
| strip prior thinking when the tools list no longer matches | done reactively — the refusal names the block (`messages.<m>.content.<b>`), so magpie drops from where Anthropic itself points rather than guessing which turn diverged |

**What to do**: v0.1.2157 or later. A new Codex conversation keeps working as a stopgap; on current magpie the mid-conversation tools change recovers on its own — one 400, one re-ask without the stale blocks, and the conversation goes on.

**Not verified:** no official-key Anthropic account here — the fix's tests replay this refusal against a fake upstream (`boundClaude` in `thinking_bound_test.go`, worded from the same error including the `drop_block` sentence), and the five bound-thinking tests pass at current tip (`df7c94bdf`); the 400 has not been reproduced against the real API. The tools-list reading of the binding is Anthropic's own error text, as quoted in the report.

AI use: analysis written with GLM-5.3-Flash (ZCode) from a code read of the repo; no requests were sent to any upstream.
