This is already fixed on `main` by b641868e ("gateway: TestHeldClock passes each zone in instead of writing time.Local (#2949)"), which is exactly the cure this issue asks for: `heldClock` now delegates to `heldClockIn(t, now, loc)`, and `TestHeldClock` passes each zone in, so nothing in the package writes `time.Local` any more. It should be safe to close.

## The race, precisely

One writer, many readers, one global. At the commit CI went red on (b749cffbb), the only writes of `time.Local` in the whole `internal/gateway` test binary were the two lines in the old `TestHeldClock` (`git grep "time.Local =" b749cffbb -- internal/gateway/` returns just `zhipu_resets_test.go:92` and `:94`). Meanwhile background goroutines read the same package variable:

- ubuntu CI (run 39242954115): write by `TestHeldClock` at `zhipu_resets_test.go:92` vs read by `time.Now` inside a `narrowWhenRead` goroutine an earlier gateway test had left running (`restAfterMarked` → `go narrowWhenRead` → `context.WithTimeout` → `time.Now`, which reads `Local`).
- I also reproduced the same class locally on darwin/arm64 (Go 1.26.8) by restoring the old test body: the reader there is the darwin-only stand-in goroutine `testenv.StandIns` spawns (`os.StartProcess` → `record` → `os.Stat` → `time.Unix` → `unixTime`, which also reads `Local`) — the very pair `testenv.Zone`'s doc comment warns about, which is why `Zone` waits out the stand-ins before swapping. `TestHeldClock`'s raw assignment waited for nothing.

## Reproduction

```
go test -race -count=20 -run 'TestHeldClock' ./internal/gateway/
```

- with the old test body restored (the two `time.Local` writes back): tripped `WARNING: DATA RACE` in 4 of 6 runs, write stack `TestHeldClock zhipu_resets_test.go:96`, read stack `testenv.record → os.Stat → time.Unix`;
- as merged (b641868e, nothing writing `time.Local` in the package): 6 x 20 runs, all clean.

Reads alone never race; removing the only writer kills the race for every reader at once, on every OS.

## Verification

| Run | Command | Result |
| --- | --- | --- |
| Repro, old body | `go test -race -count=20 -run TestHeldClock ./internal/gateway/` x6 | 4/6 DATA RACE (stacks above) |
| Fixed | same command x6 (120 test executions) | all `ok`, 0 races |
| Package, race | `go test -race -count=1 -timeout=30m ./internal/gateway/` | see note below |
| Package, plain | `go test -count=1 ./internal/gateway/` | see note below |
| gofmt | `gofmt -l internal/gateway/` | clean |
| vet | `go vet -tags nogui ./internal/gateway/` with GOOS=darwin/linux/windows | all pass |

Verified on darwin/arm64, no change of mine to apply — the numbers above are against `main` as it stands (fix already in).

**AI**: verified with an AI coding agent; the fix itself is b641868e by yetone, and the diagnosis above is against that diff, which I've read in full.
