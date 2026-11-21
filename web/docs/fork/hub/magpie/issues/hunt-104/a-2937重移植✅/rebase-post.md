Rebased onto main `764a032f6` and re-verified on this box (Windows, amd64). Since the last update main reworked the very seam the patch sits on: `2d11cde05` replaced `WithExtraBody`'s session argument with a `Conversation` value, which now also carries `${threadId}` for headers and extraBody. The patch takes the new shape instead of a third argument: `Conversation` itself carries the subagent (`Conversation{Session, Thread, Subagent}`), `forwardOnce` fills `Subagent: subOf(in)` where it builds the conversation, and the extraBody walker replaces `${subagentId}` in string values after `Conversation.expand`. The placeholder stays extraBody's alone — a header naming it goes out as written — so the opt-in semantics are what they were, byte for byte: a value without `${subagentId}` goes out exactly as before, Test and Detect fill it with `""` (`tested` builds an `OwnConversation`, whose subagent is empty), and a non-Claude-Code agent gets `""`, never the literal. The docs row now names `${subagentId}` beside `${threadId}`.

Also re-checked the seam with main's default cache-key fill (`6e331afb`): still orthogonal. `ownCacheKey` keeps skipping a provider whose extraBody names `prompt_cache_key` (the user's value is the one sent), and a provider without extraBody gets the conversation digest in its body on the lead's turns and a subagent's alike — the default path never touches the subagent.

Branch with the commit: [hunt50-e-sessionid-cache](https://github.com/ggbdpq/magpie/tree/hunt50-e-sessionid-cache) (head `b25c8ab82`).

Verification — the gateway and provider packages isolate themselves in their `TestMain`, so nothing touches a live config:

| Check | Command | Result |
| --- | --- | --- |
| Red, ablation | product files reverted to `764a032f6`, tests kept; `go test -run TestExtraBodySubagentId ./internal/gateway` | red as wanted — lead and worker-a both took the literal `"sess-1:${subagentId}"` (raw output below); `TestWithExtraBody` in provider stops building (`unknown field Subagent`) — the field is the carrier |
| Green, restored | `go test -run 'TestExtraBody\|TestWithExtraBody\|TestOwnCacheKey' ./internal/gateway ./internal/provider` | `ok` both, 13 tests — the `TestExtraBody` family, main's `TestExtraBodyThread`, and `TestOwnCacheKey` |
| ownCacheKey control | no-extraBody provider through the gateway: one turn as the lead, one with `x-claude-code-agent-id: worker-a` | both upstream bodies carry the same conversation-digest `prompt_cache_key` — the default fill is untouched by the subagent |
| Format | `gofmt -l` on the changed Go files, CRLF stripped first | clean |
| Vet | `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=darwin go vet -tags nogui ./...` | `ok`, three targets |
| Builds | `go build ./...`; `CGO_ENABLED=0 GOOS=linux go build -tags nogui ./...`; `CGO_ENABLED=0 GOOS=windows go build -tags nogui .` | `ok`, three targets |
| Race | targeted tests with `-race` | not run — no gcc on this Windows box |

Two environment notes, both outside the diff. Plain `GOOS=darwin go vet ./...` fails inside the wails module — all 11 errors are in `wails/v3@v3.0.0-beta.24` (its darwin CGO files are out of reach when cross-vetting from Windows without cgo), none in a magpie package; with `-tags nogui` darwin vets clean. And in the red run the third assertion of `TestExtraBodySubagentId` (worker-b's, a "distinct from the other two" check) passes on the literal — which is why the raw output below shows two red lines for three identical keys.

```
--- FAIL: TestExtraBodySubagentId (0.13s)
    extrabody_test.go:119: the lead's key "sess-1:${subagentId}"
    extrabody_test.go:122: a subagent's key "sess-1:${subagentId}"
FAIL
```

written with GLM-5.3-Flash (ZCode)
