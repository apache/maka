**Verdict** — the analysis is right and I verified every part of it against today's upstream/main; what keeps this a verdict rather than a patch is that the exact-match rewrite the report recommends can only cover two of the three channels that carry a call's arguments to the client, and the third — the one a gateway-only session like the report's actually runs on — streams the arguments in JSON fragments, where a whole-value rewrite needs a streaming JSON lexer on a path every non-tui tool call takes. That tradeoff is the maintainer's to pick.

## The report's root cause, re-verified at `db0f2f20d` (line numbers have moved; the logic is as described)

| Report (v0.1.3357) | now | Confirmed |
| --- | --- | --- |
| `bridgeName` :5028 | `claude_subscription.go:5170` | `mcp__magpie__` + `bridgeToolName` |
| `bridgeToolName` :5049 | :5195 | alias charset `[A-Za-z0-9_-]`, ≤64 with the prefix, hash suffix `_+12 hex` when the name would be changed |
| `bridgeTools` :7368 | :7536 | sends `bridgeToolName(t.Name)` only; description and schema unchanged |
| `toolStart` :3871 | :4017 | cuts the prefix, `declaredName` for the block's **name** |
| `mcpCall` :5888 | :6063 | `call.Name = declaredName(run.names, call.Name)`; `call.Arguments` forwarded untouched at :6111 |
| `declaredName` :5084 | :5226 | the reverse map exists, per-run, small |

## What the report's analysis does not cover: arguments reach the client on three channels

1. **`onCall` (tui sessions)** — the MCP helper's call lands on `mcpCall`, which hands `(id, name, args)` to `run.onCall`; the closure emits `KToolStart`/`KToolArgs` (:4134). Whole JSON. This is the early-telling path of an interactive session.
2. **A whole message block (:4479)** — a call held back (#4611) is told from the message that carries its input whole. Whole JSON (`c.Input`).
3. **Streaming `input_json_delta` (:4553)** — `content_block_start` marks the block the client's (`toolStart`), `told` is set so the other two channels don't repeat it, and the arguments then arrive as **partial JSON fragments**. For a run started by magpie itself (gateway-only, the report's Docker case), this is the channel the client's tool call actually rides: `onCall`'s closure is only installed for `r.tui` sessions (:4103), and `mcpCall` with no `onCall` only parks the call (`run.pending`) waiting for the client's result — which the client can only produce from what the stream told it.

The report's fix (1) rewrites values in `arguments` — a whole-value, exact-match pass, well defined on complete JSON, so it lands on channels 1 and 2. Channel 3 is where Maki-style clients on a gateway receive the call, and there the alias can be split across fragments (`mcp__magpie__r` + `ead`), the JSON structure is only known incrementally, and the path carries **every** non-tui tool call, not just meta-tools. Rewriting there means one of:

- **byte-level substitution** (buffer the tail up to the longest alias, 64 bytes, flush what cannot begin an alias): simple, but it rewrites an alias **inside a free-text value** too — a grep pattern, a pasted log line — which is exactly the false-positive class the report's whole-string matching was chosen to avoid;
- **a streaming JSON lexer** (in-string, escape, key-vs-value position, across fragments): precise, but a new state machine on the shared call path of every non-tui session — the highest-blast-radius code in the bridge;
- **buffering each block to its end** and rewriting whole: precise, but it takes streaming away from tool arguments, which clients watch for.

Which of those is acceptable is a design call, not something to pick from an issue; and the fix must cover channel 3 or it does not cover the report's own deployment.

The report's other two suggestions are cheap and worth doing alongside, but each has a small price worth naming: putting the declared name in each bridged tool's description (suggestion 2) changes text that sits in the run's prompt before its first token — the cache prefix every run of the session pays; the doc note (suggestion 3) costs nothing.

## What would close it

1. Pick the channel-3 approach (my read: the lexer, confined to the delta path, rewriting only whole string values that exactly match an alias — the tradeoff then matches the report's own wording).
2. Add the whole-JSON rewrite on channels 1 and 2 (mechanical, once 1 is decided).
3. The doc note, and optionally the description hint.

## Verification

| Check | Result |
| --- | --- |
| Root cause lines re-verified at today's main | table above — all six mappings confirmed |
| Channels 1/2 carry whole JSON | :4134 (args from `mcpCall`), :4479 (`c.Input`) |
| Channel 3 streams fragments, guards repeats | :4553 + `told` at content_block_start |
| `onCall` only for tui sessions | single assignment at :4103 inside `if r.tui` |
| `mcpCall` is the execution loop's only entry | helper → `mcpCall` → `run.pending` waits for the client's result |
| Alias shape | pure `[A-Za-z0-9_-]`, ≤64 with prefix, hash suffix — bufferable, no JSON escaping of the alias itself |
| Live meta-tool reproduction (Maki/batch) | NOT-RUN — no Maki, no Claude subscription here; the failing path is established from the code structure above |

**Source**: internal/gateway/claude_subscription.go at upstream/main `036b69154` (bridge naming :5170-5231, `toolStart` :4017, `mcpCall` :6063/:6111, the three emit points :4134/:4479/:4553, `bridgeTools` :7536).
**Not verified**: a live run of Maki's batch through a real Claude subscription; which channel a specific client sees first in practice (the told/awaited state machine decides per call).
**Attribution**: AI-written analysis; I can answer questions on it myself.
