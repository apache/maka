Took this one. AI-written — every check below ran locally today on current main, and your cc-switch cross-validation is the evidence that pins the root cause: it isolates magpie's translated stream AND points at the exact delta, because a converter that ends the reply at the Chat protocol's own `[DONE]` never waits for what your relay does after it.

**What's wrong.** For a translated reply (Codex speaks Responses, the provider speaks Chat only), magpie said the reply's end only when the upstream's connection came down: the reading loop ran to EOF, and `response.completed` was written at the hangup. A Chat relay that streams the reply whole, says it over (finish_reason, usage, `[DONE]`) and then holds the connection open leaves the stream in a keep-alive loop — the client has every word, but the end never comes until magpie gives up reading. Your app.log is that state: the reply's bytes are on Codex's side, the upstream call is still open (`499 after 29.789s: the agent canceled the request` — Codex's cancel, not an upstream error), and the turn dies "in progress". Codex skips `response.in_progress` for its idle timeout, so the keep-alives magpie sends meanwhile don't hold it.

**Root cause.** `streamTranslated`'s read of a Chat upstream ignores `[DONE]` entirely — `replyEnds` for Chat keys on `finish_reason` alone, and the reply's end is synthesized at EOF. The Chat protocol's own end sentinel is the earliest point the reply is known whole (its usage chunk precedes it), and it is what a same-protocol client would have ended on.

**The fix** (`internal/gateway/continuation.go`, 3 hunks): the translated read ends at `[DONE]` for a Chat upstream — a sentinel beside the existing `errStreamCut`, which already ends a read "without waiting on a vendor that keeps the connection open after it". The success path then writes `response.completed` as before; `ended` bookkeeping is untouched, so a Gemini OpenAI-compatible or Command Code reply that lost only its finish_reason is still filled from its usage (their deliberate cut semantics are preserved by the tests below). A reply that said nothing is still the empty reply's to answer.

**Verification on current main `db0f2f20d` (2026-11-10), rebased once mid-run as main moved:**

| Check | Result |
| --- | --- |
| `TestChatDoneEndsTranslatedReply` — Chat upstream streams text + finish_reason + usage + `[DONE]`, then holds the connection; Responses client on the HTTP route | red before the fix ("no end of the reply while the upstream holds its connection"); green after, `response.completed` with usage 9 in / 4 out while the upstream still holds |
| `TestResponsesSocketChatDoneTurn` — same upstream, Codex's socket, two turns | red before the fix — the frames are your report verbatim (`output_text.delta "hello"` and then only `response.in_progress` keep-alives, no terminal, the read timing out); green after: turn 1 completes with the text and usage on the socket, the reply is kept (`previous_response_id` works), turn 2 completes on the same socket |
| Sibling families re-run with `-race` (76 tests, 0 fail): every `TestStreamCut*`/`TestStreamError*` continuation, `TestGeminiCompat*EndedShort`, `TestCommandCode*` (incl. `RelayWholeStaysWhole` — a whole reply never gets a second end, `[DONE]` or not), `TestAnotherChatStreamWithoutAFinishReasonStaysAsItCame`, the Responses socket suite, quiet-stream keep-alives, cut-void and empty-reply sets | all green |
| Ablation: the `[DONE]` check lifted out (`git diff --stat`: 1 file) | both new tests red (HTTP 5s, socket 30s timeout) → restored → green |

**Sibling scan, point by point:** the Chat decoder's `[DONE]` (hands held text back, says no end — unchanged); `chatEncoder`'s own `[DONE]` for Chat clients (client side, untouched); the native same-protocol relay (its client reads the upstream's own `[DONE]`, nothing synthesized — untouched); the non-stream translated path (reads to EOF, no per-event end to strand — unchanged); `fallback.go`'s whole-body terminators (already list `[DONE]`, different mechanism); the hook/conversations/Ollama decode skips (unchanged); the socket layer (untouched — `ended`/`completed` now arrive at `[DONE]`). Upstream containment: since v0.1.3402 the only commit on this file is `9309e28ce` (a plugin's provider in front of a vendor's API — unrelated), so nothing on current main covers this report.

NOT-RUNNABLE here: a real OfficeAce account — the fixture carries your relay's shape (whole reply, end said, hangup withheld).

**Patch:** `git am` ready, applies clean onto `db0f2f20d`; sha256[:16] `146c099c25352924`; branch [`v2/responses-completed-5936`](https://github.com/ggbdpq/magpie/tree/v2/responses-completed-5936) (head `9a74b5c5d`), also as a [`.patch` URL](https://github.com/ggbdpq/magpie/commit/9a74b5c5d1a9aef699ee37325b7bc0c98402eea7.patch).

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
