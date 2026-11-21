The two runs that were in flight when the post went up, both on `729664580` at this branch's head:

| What | Result |
| --- | --- |
| full `go test ./internal/provider` | ok 129.1s, zero failures |
| `go test -race ./internal/provider` | 2 failures, both the already-attributed parallel-suite timing reds (`TestPluginCheckinAsksAgainAtUntil`, `TestModelTestAsksTheAccountThatServesIt` — green single-run on the base); nothing new |
