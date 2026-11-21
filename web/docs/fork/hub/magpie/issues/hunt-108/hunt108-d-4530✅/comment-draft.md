The fake vendor in `internal/gateway/thinking_streams_test.go` ends its handler with `s.done <- time.Now()` on a `make(chan time.Time, 1)`. Any try that asks the same fake vendor a second time (a reply that only reasoned is asked again in place, #667; a full run's state may have any ask retried) finds the buffer full from the first serve: the second handler blocks on that send forever, the reply it serves never ends, and `t.Cleanup(vendor.Close)` waits on the stuck handler until `go test`'s own timeout — the test body and its assertions passed, no failure, no output, the whole package hung with it (#4530).

**Fix** (test-only, no product file touched; the send idea is Jackzigen's from this thread, adopted with thanks): the send becomes non-blocking —

```go
select {
case s.done <- time.Now():
default:
}
```

The tests read the time once, under a `select` with a 5s timeout; later sends can drop. `TestThinkingVendorAskedAgainStillEnds` is added so the re-ask path is regression-guarded instead of silent: it points the gateway at a Gemini fake that streams only reasoning and ends with its `finishReason`, whose reply is asked again in place (#667), and reads the reply to its end — with the blocking send it hangs exactly as the full run did:

RED (before the fix, `-timeout 60s`):

```
panic: test timed out after 1m0s
	running tests:
		TestThinkingVendorAskedAgainStillEnds (1m0s)

goroutine 90 [chan send]:
github.com/yetone/magpie/internal/gateway.(*slowThinker).ServeHTTP(0x5637f5c8edc0, {0x105b793b0, 0x5637f617e1e0}, 0x5637f617e1e0?)
	/private/tmp/magpie-hunt108-d/internal/gateway/thinking_streams_test.go:35 +0x328
FAIL	github.com/yetone/magpie/internal/gateway	60.459s
```

GREEN (after the fix, same command):

```
ok  	github.com/yetone/magpie/internal/gateway	2.528s
```

| Check | Result |
|---|---|
| `-run '^TestThinkingVendorAskedAgainStillEnds$'` -tags nogui | ok 2.528s |
| slowThinker set (ThroughGroup, WithNoOneElse, ChatReasoningRelayed, HeldFor, new) | ok 24.040s |
| same set with `-race` | ok 7.464s |
| full `go test -tags nogui -count=1 ./internal/gateway` | 616s, no hang; two pre-existing failures outside this diff (TestClaudeAbortAllowsLockCleanup, TestClaudeForksAnsweringTheLeadsCallsEachGetAnAnswer — claude subscription area, file order long before this file). Reported `TestMarshalRawIsEncodingJSON` did not fail in this run |
| ablation (send reverted to blocking, test kept) | back to red: `panic: test timed out after 45s`, `goroutine 86 [chan send]` at thinking_streams_test.go:35 |
| `gofmt -l internal/gateway/` / `go vet -tags nogui` | clean / ok |
| builds | `GOOS=linux -tags nogui ./...` ok; darwin, windows `./...` ok; `./internal/gateway/...` ok on all three (untagged linux `./...` fails in the wails GUI dep, pre-existing) |

Notes: the sibling sweep found the same idiom already in `plugin_stream_regression_test.go` (`produced` is sent non-blocking there), and every other test-fake channel in the package is a gate/release the test controls explicitly — not this class. Failure-read semantics unchanged: each test reads `done` exactly once; the new test counts `up.sent` for both serves after the response has ended, which a blocked serve can never reach. Hot-path cost: none — only a test file changed.

```
<format-patch of 17e87bf4c and 5b9c9c314 goes here — git format-patch 47173f593..17e87bf4c --stdout>
```

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway tests: a re-asked slowThinker drops its done send instead of blocking (#4530) — git am applies it as is; SHA-256 first 16: TODO_SHA256_16</summary>

```
<patch content>
```
</details>

Branch with the commit: [hunt108-d-4530-slow-thinker-done](https://github.com/ggbdpq/magpie/tree/hunt108-d-4530-slow-thinker-done) (head `17e87bf4c…`).
