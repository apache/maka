<!-- hunt93 L4 audit draft — NOT posted. Baseline: upstream/main 4a1cd776 (fetched 2026-10-27). Seven-question gate: passed (Q1 is the one judgment call — see the last paragraph). Test file: stop_restart_test.go (red at head, race-clean, no sibling disturbed). -->

## Turning the local masking model off starts it again for the requests still queued for it

When the local masking model is turned off in Settings → Privacy while requests are queued for it, the request pf-serve is on fails as it should — but the request waiting behind it starts pf-serve all over again and is answered by the model the user just turned off, after loading it again: up to `loadTimeout` (3 minutes) of disk and CPU, then the GPU or CPU busy with its chunks, all for a model that is off. The Settings page says off lets the model go ("a download is stopped, the model let go and kept"); for as long as requests are queued, it doesn't stay let go.

Minimal reproduction: with the model on, put one request on pf-serve (a hung one, so it stays), put a second behind it (the Routing-page wait, `Now().Waiting == 1`), call `Stop()`. The request on pf-serve fails with `errStopped`, the turn passes to the queued one, `heldBack` knows of no failure (`Stop` cleared `lastErr`), and `classifyTurn`, finding `srv.h == nil`, starts pf-serve again. The new test below does exactly this with the stand-in pf-serve; before any fix it sees a second `start pf-serve` in the stand-in's log where one is wanted, and the queued request never comes back (it is hung in the load the restarted stand-in never finishes).

```
--- FAIL: TestStopKeepsAQueuedRequestFromStartingServeAgain (0.19s)
    stop_restart_test.go:45: pf-serve started 2 times, want once: the queued request started a turned-off model
```

Root cause, as far as the chain goes: `Stop` (internal/pii/serve.go) ends the helper, closes `srv.stop`, and clears `lastErr`/`fails`/`retryAt` ("turned on again, it is tried at once"). A request already waiting in `backend.find`'s turn queue (`internal/pii/find.go`) then takes the freed turn: its `heldBack` check passes (no `lastErr`), `stopCh()` makes a fresh, unclosed channel for it, and `classifyTurn` starts a helper for a request whose masking options were read while the model was still on. Only the request pf-serve was *on* is told of the stop (its read fails, `stopped(stop)` holds, `errStopped` comes back); the ones behind it are not, though they were queued behind it when the model was turned off. AstrLink Guard has the same shape one reload cheaper: `guardModel.Stop` unloads, and the queued request loads the 37 MB int8 model into the process again and answers.

The incoherence is the point: of two requests queued at the moment `Stop` runs, the one that had the model fails with "the local masking model was stopped", and the one that didn't have it yet is served by it minutes later. A user turning the model off because it is slow (the #3682 reports' shape: a weak GPU, requests queued minutes behind each other) gets the opposite of what they asked on both counts — the machine keeps churning on the model, and the queued turns come back model-masked after the off. Something that says "stopped" to a find whose turn comes after the stop — a generation the find loop re-checks when it takes the turn, the way it re-checks `heldBack` between chunks — would make the two requests agree; the details are yours.

Verification (macOS 15.6 arm64, go1.26, at upstream/main `4a1cd776`):

| Check | Result |
| --- | --- |
| `go test ./internal/pii -run TestStopKeepsAQueuedRequestFromStartingServeAgain` (new) | red: `pf-serve started 2 times, want once` |
| the same with `-race -count=1` | red the same way, no race reported |
| `go test -count=1 ./internal/pii` whole package with the new test kept | only the new test red; the other 20, `TestStatusAndStopDontWaitForARequest` and `TestStatusAndStopDontWaitForALoad` among them, green (16.3s) |
| `gofmt -l internal/pii` | clean |
| `go vet ./internal/pii/...` darwin, `GOOS=linux`, `GOOS=windows` | exit 0 each |

## Source

Found auditing `27b4f412` (pii: a model's find, cache and download as a backend of its own, #3578): the turn queue moved into a per-model `backend`, and what a queued request does when its model is stopped had no test. The shape itself is older — `find.go` at `e9c1066c` has the same `heldBack`-then-`classify` loop — the refactor carried it over per model, which is what makes it worth a look now.

## Not verified

No real pf-serve against real settings toggling: the reproduction is the stand-in pf-serve the package's own tests use (`PII_FAKE_SERVE=hang`), read at the stand-in's log, not a 1.6 GB load watched through. Whether the maintainer means the queued requests to be served anyway ("a request reading it finishes with the model it has" — though a queued one is not reading it yet) is the one thing this issue could be wrong about; the two requests' opposite answers at the same `Stop` is what says otherwise. A patch can follow if the behaviour is agreed to be a bug.
