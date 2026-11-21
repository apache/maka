**What's wrong**

A subagent's task its lead sealed reaches the provider that can open it (`sealedReader`, #1109), but `attempt`'s downgrades to a translation didn't know a sealed task is in the request. When the provider has been marked as having turned Codex's custom tools away (`customToolRefused`), the request is translated from the start; when the refusal is met on the sealed turn itself, the fallback after `passthrough` translates it. A translation reads an `agent_message`'s text and images alone (`responsesParts` has no case for `encrypted_content`), so the `NEW_TASK` header went to the model and the sealed body — the task itself — stayed behind, with an HTTP 200 saying the task was there.

**Repro** (code audit confirmed by an assertion-level test on `upstream/main` `e2afa3931`)

The new `TestSealedTaskWithCustomToolStaysWithTheRelayWhenCustomToolsAreOff` extends `TestSealedTaskGoesBackToTheRelayThatSealedIt`: one relay answers the lead and its subagent, the subagent's turn carries the existing `sealedHandoff` fixture plus Codex's `apply_patch` as a custom tool, and the relay is marked `customToolRefused` before the turn. Without the fix, the relay is sent a *translated* request whose `agent_message` holds only `"Message Type: NEW_TASK\nPayload:\n"` — no `encrypted_content` — with the custom tool turned into a function. `TestSealedTaskWithCustomToolRefusedNowIsNotTranslated` covers the fresh face: the relay answers 400 "Unsupported custom tool", and the translated retry that follows drops the body and answers 200.

**Root cause and fix**

`attempt` already keeps a native compaction out of every downgrade (`keep`, #1099). A sealed task (`from == Responses && hasSealedAgentMessage(body)`, the same predicate the web-search downgrade has exempted since #1109) now gets the same treatment:

- `if (keep || sealed) && relayable` puts the request back on the relay after any downgrade set it aside;
- after a mid-turn refusal, `if keep || sealed` returns the upstream's refusal to the client instead of translating.

A request whose provider does take the request as Codex sent it behaves exactly as before; the seal reaches the backend that can open it, and a genuine refusal of the custom tools is Codex's answer as the upstream said it — not a 200 with the task gone.

**Verification** (darwin, go1.x per go.mod, base `e2afa3931`, head `c632654a1ae28dca`)

| Check | Result |
| --- | --- |
| `go test ./internal/gateway -run TestSealedTask` | ok, 12 tests incl. the 2 new ones |
| New tests without the fix (base tree, tests kept) | both FAIL at the assertions above |
| Ablation: `(keep \|\| sealed) && relayable` → `keep` | `...StaysWithTheRelay...` FAIL: relay got the header-only translated request |
| Ablation: `keep \|\| sealed` → `keep` (post-refusal) | `...RefusedNow...` FAIL: client got 200, third (translated) request sent |
| Restored | ok |
| `go test ./internal/gateway` (full package) | ok 1002.7s, zero failures |
| `go test ./internal/gateway -run TestSealedTask -race -count=2` | ok |
| `gofmt`, `go vet` | clean |
| `GOOS=linux GOFLAGS=-tags=nogui go build ./...`, same for windows | ok |

**Siblings**: `rg -n "hasSealedAgentMessage"` → the web-search downgrade (already exempted, now shares the one computed predicate), the serve gate (`codex_subagent.go`, refuses unreadable providers before anyone is asked — untouched), the grok plugin's namespace guard (plugin-side, untouched), `gateway.go:2797` routing detection (untouched). `rg '"agent_message"'` in translators → `responses.go:429` (the one lossy reader, now never fed a sealed task), `itemText` (the compaction text-summary path, #5181/#5259, upstream's own), `zed_body.go` (carries the content parts whole, nothing dropped). Codex's own models reach the ChatGPT backend without `attempt` and go as they came, streamed or whole — not a face here.

**When the read fails**: `hasSealedAgentMessage` returns false for a body it can't read, so the request takes exactly its pre-patch path; nothing new is inferred from an unreadable body.

**Not verified**: a real ChatGPT-backend relay (Sub2API-style) and a real provider that refuses custom tools; the tests use the repository's fixtures against local fakes.

---
**Source**: reported in #5198 (code-audit report by KaranocaVe); the loss reproduced here is at the assertion level above.

**Red without the fix** (base `f6c882ad7`, the tree the fix grew on; rebased onto `e2afa3931` with zero drift in the four touched files, `git am` replays to the delivered tree byte for byte, new tests kept, product files reverted): both new tests fail as quoted in Repro. With the fix: `ok`.

**Siblings**: listed above.

**When the read fails**: listed above.

**Not verified**: real relay account, real custom-tool-refusing vendor.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

**Branch with the commit**: [hunt-20261112-t1-5198](https://github.com/ggbdpq/magpie/tree/hunt-20261112-t1-5198) (head `c632654a1ae28dca`).

**Patch**: <details><summary>patch: gateway: a sealed subagent task is never downgraded to a translation (#5198) — git am applies it as is; SHA-256 first 16: 2c2b1a11a00dd67a</summary>

```
(fenced format-patch full text)
```

</details>
