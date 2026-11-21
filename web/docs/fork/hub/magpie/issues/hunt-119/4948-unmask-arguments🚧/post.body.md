I read the restore side to see where a placeholder can survive into a file an agent writes, and the paths I checked all put values back — so before guessing at a fix, three things about your flow would pin where yours leaked.

## What I checked (main at `c86fa2a34`)

The reply goes back through `redactedHits`' writer (`internal/redact/writer.go`), which restores at the byte level, per SSE event:

- Tool-call arguments are restored: a Responses `function_call_arguments.delta`'s `delta` and Chat's `arguments`/`partial_json` read as JSON-of-JSON (`asJSON`, `internal/redact/json.go:520`), so a value coming back inside a file-write's arguments is unescaped and restored like any text.
- A placeholder the stream splits across two events is put back whole: the event holding a possible start is kept until the next confirms it (`writer.go:14-18, 227-239`) — a long file's arguments, arriving as many small deltas, stay covered.
- Even a request that masked nothing installs the writer, for a conversation the vendor holds part of (`redact.go:67-71`).

Three faces keep a placeholder on purpose, and one of them may be what you hit:

1. `kept` keys (`json.go:19-25`) — `name`, `id`, `call_id`, `url`, `status`… — are restored but never held across events, so a placeholder of theirs split across two events survives whole only if split (a tool's name is short; unlikely in a file body).
2. Sealed text (`sealedText`, `writer.go:285-288`) — signatures, `data:`-prefixed and long encoded blobs — goes back as written.
3. The value isn't in the store: the restore puts back what **this magpie process** masked (`values`, `writer.go:291-295`). If the md was written in a session that crossed a magpie restart (or a second magpie instance served some turns — #4938's multi-instance shape), the later turn's process holds no values, and its answers keep whatever placeholders the model echoed.

## What would pin yours

1. What is REA — a tool of your own agent, an MCP server, Codex's own? And who wrote the md: a tool call Codex executed (its arguments came through magpie), or the model's message text you copied?
2. A snippet of the md with the placeholders, redacted as you like: are they magpie's shapes (`{{KIND_8charhash}}`, or `KIND_8charhash` bare)? A `{{…}}` of some other shape would mean the placeholder was never magpie's to restore — the model invented it from seeing one earlier in the conversation.
3. Did one magpie process serve the whole session (no restart, no second instance)? The routing log's rows for the turns around the md's writing would say.

My working suspicion is 3 (a store that doesn't hold the value) or a placeholder shape that isn't magpie's — both are answerable from the snippet, and neither is a patch on the restore paths, which the probes above say are covered.

---
**Source**: reported in #4948 (WangJinglin, screenshot only); the audit is a code read on main `c86fa2a34`, no repro of your flow.

**Not verified**: your session's shape — REA's identity, the writer of the md, the placeholder shapes, and whether one magpie process served it all.

**Attribution**: AI-written; I've read the paths cited and none of them is patched yet.
