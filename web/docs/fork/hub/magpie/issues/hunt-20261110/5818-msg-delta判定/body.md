@yuhang0521 thank you for the regression window and the intermittent correction — both shape the diagnosis. I took this and walked the translated-stream path end to end; where it stands:

**The delta is written by one line of code, unconditionally, right before the stop.** `anthropicEncoder.finish()` (internal/gateway/anthropic.go) emits `message_delta` (stop_reason + the collected usage) and then `message_stop`, back to back, with no branch between them; `message_stop` has no other emitter in the tree. Every success path funnels through that `finish()`; every failure path emits an `error` event instead and **no `message_stop` at all**. So the sequence you captured — `message_stop` present, `message_delta` absent — cannot come from the translator choosing a branch. It points at a write of the delta that didn't reach your client while the stop did, which narrows to the stream's write layer, not the translation.

**Reproduction matrix (12 upstream shapes, all green on current main):** normal `[DONE]`; bare end of body; role chunk alone; no `finish_reason` with `[DONE]`; no `finish_reason` bare end; stop chunk without usage; `reasoning_content` thinking deltas then stop; chunk cut mid-JSON; duplicated stop+`[DONE]`; **CRLF line endings throughout** (your platform's relay shape); usage-after-blank; `event:` lines with CRLF. In every one, `message_delta` lands exactly once with the real counts, and `magpie`'s ledger records the same numbers the client sees. Fixtures run at `53b2773d7`, `internal/gateway` (`TestTranslatedAnthropicStreamSaysMessageDelta`).

**Why intermittency fits the one mechanism left:** with a routing group (or the held-stream path), writes go through a hold buffer that can release — and on a retry/second candidate, an earlier try's buffered events are dropped by design. A delta written into a held buffer that a later release discards, followed by a stop written after release, is exactly "stop seen, delta gone". That mechanism needs your environment to exercise it.

**Three things would pin it down:**

1. the `app.log` lines for one affected request (the gateway's own account of the turn — whether `magpie`'s ledger shows out=0 too, and whether a group/multiple candidates were involved);
2. whether the relay honors `stream_options: {"include_usage": true}` — i.e. does its raw stream carry a final usage chunk, or does `magpie` see counts only in the non-streaming reply?;
3. a raw capture of one affected stream as your client sees it (`curl -N ... | tee raw.txt`), including every `content_block_stop`'s `index`.

Your ledger observation (112/141 turns at out=0) says `magpie` itself never counted those outputs — which the fixtures say can't happen when the upstream's usage chunk arrives — so (2) is my prime suspect: a relay that drops the usage chunk most of the time would starve both the delta's counts and the ledger, though not the delta event itself; if your capture in (3) shows the delta missing at the byte level, it's the hold path, and (1) will say whether a group was involved.

Generated-by: GLM-5.3-Flash (ZCode)
