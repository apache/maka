Fix for #4530 — the fake vendor's done channel holds one send, and a second ask blocked its handler forever. Reported by hheei.

## Source & environment

- Upstream `yetone/magpie`, issue #4530 (reporter hheei, no comments when taken).
- Patched on current `main` (`8413267097c8bbef6e47409f936c21c173e140d3`), Windows 10, Go 1.26.5 (toolchain 1.26.8), `go test -tags nogui -count=1 ./internal/gateway`.
- Before this post I re-fetched `origin/main` and checked: no new upstream commit touches `internal/gateway/thinking_streams_test.go`, and the issue's comment count was unchanged, so nobody else had delivered a fix.

## Minimal repro

The natural repro is the reporter's: a full `go test -tags nogui -count=1 ./internal/gateway` hangs until `go test`'s own 25m timeout, with the test body long finished; run alone (`-run TestThinkingStreamsWithNoOneElse`) it passes in ~17-18s. I could not cheaply pin which retry path fires a second ask under full-run load, so the repro I committed is an injected one that encodes the reported mechanism verbatim — two sequential asks of the same `slowThinker` fake:

- `TestSlowThinkerDoneChannelDoesNotHoldASecondAsk` (new, in `internal/gateway/thinking_streams_test.go`) asks the fake twice and requires the second handler to return. On the old code it fails in 10s:

```
--- FAIL: TestSlowThinkerDoneChannelDoesNotHoldASecondAsk (10.00s)
    thinking_streams_test.go:151: a second ask of the same fake vendor never finished: its handler is stuck on the done channel's send
```

- On the old code, the targeted run with `-timeout 60s` panics with the reporter's stack verbatim: `goroutine ... [chan send] ...(*slowThinker).ServeHTTP ... thinking_streams_test.go:35`, under `testing.(*common).runCleanup` waiting in `httptest.(*Server).Close` — the exact shape of the reported 25m hang (no test failure, only the timeout panic).

## Root cause

`slowThinker.done` is `make(chan time.Time, 1)` and its handler ends with a blocking `s.done <- time.Now()`. Every test reads that channel at most once, so after the first ask the single slot is typically still full. A try that asks the same fake vendor again — a retry, a re-ask in place, a reloop (the gateway's ask count is timing-dependent, not fixed by the test) — blocks its second handler on the send forever. The test body has already passed by then, and `t.Cleanup(vendor.Close)` waits on the stuck handler until `go test`'s timeout: no failure, no output. `TestThinkingStreamsWithNoOneElse` and `TestThinkingStreamsThroughGroup` share the fake; `TestChatReasoningRelayedAsItComes` (another file) uses it too, so all three hang the package the same way once a second ask happens.

## Fix

Test-only, one site, chosen from the reporter's two directions:

- Taken — non-blocking send (reporter's first suggestion): `select { case s.done <- time.Now(): default: }` in `slowThinker.ServeHTTP`, with a comment saying why. `done` is a "the vendor finished" signal each test reads at most once, so a timestamp arriving when the slot is full is safe to drop; the first ask's timestamp still lands, so every existing read keeps its meaning.
- Not taken — sizing the channel for the asks the test allows: the number of asks is decided by the gateway's retry paths at run time, not by the test, so no fixed capacity is provably enough; the same hang could come back under different load.

One line covers all three tests that share the fake. No product file is touched.

## Verification

RED/GREEN/ablation were each read in full from the run output; command and result excerpts:

| Check | Command (in `internal/gateway` unless noted) | Result |
|---|---|---|
| RED, injected (old send) | `go test -tags nogui -count=1 -v -run TestSlowThinkerDoneChannelDoesNotHoldASecondAsk .` | `--- FAIL: TestSlowThinkerDoneChannelDoesNotHoldASecondAsk (10.00s)` — "its handler is stuck on the done channel's send" |
| RED stack, old send, short timeout | same + `-timeout 60s` | `panic: test timed out after 1m0s`; `[chan send]` at `thinking_streams_test.go:35`; `runCleanup` in `httptest.(*Server).Close` — matches the report |
| GREEN (fix applied) | `go test -tags nogui -count=1 -run 'TestSlowThinkerDoneChannelDoesNotHoldASecondAsk\|TestThinkingStreamsThroughGroup\|TestThinkingStreamsWithNoOneElse\|TestChatReasoningRelayedAsItComes' .` | `ok 24.5s` — the new test passes in 0.00s and all three existing consumers pass (12/12 `TestThinkingStreamsWithNoOneElse` subtests) |
| Ablation (old send restored on top of the commit, new test kept) | targeted `-run` of the new test | `--- FAIL ... (10.00s)` again; fix restored, targeted run `ok` |
| Changed package, full | `go test -tags nogui -count=1 -timeout 45m ./internal/gateway` | PLACEHOLDER_FULL |
| gofmt | `gofmt -l internal/gateway/thinking_streams_test.go` | prints nothing |
| vet | `go vet -tags nogui ./...`; `GOOS=darwin/linux/windows go vet -tags nogui ./...` | PLACEHOLDER_VET |
| build | `go build`; `GOOS=darwin/linux/windows go build -tags nogui` | PLACEHOLDER_BUILD |
| `-race` | `go test -race -run 'TestSlowThinker...'` | Not run: this Windows box has no C compiler, and `-race` needs cgo (`cgo: C compiler "gcc" not found`). The change removes a block, it adds none; the fake's `sent` slice is only ever appended by one handler at a time, as before. |

Not tried: reproducing the reporter's natural full-run hang on Linux (this box is Windows; the injected RED carries the mechanism, and the stack above matches the report word for word).

PLACEHOLDER_FOOTER
