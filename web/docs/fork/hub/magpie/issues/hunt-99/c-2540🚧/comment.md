Re-checked the diff from the [10-19 comment](https://github.com/yetone/magpie/issues/2540#issuecomment-6257896583) against today's main — verified at `7b63feb9`; the five touched files are byte-identical at current `main` (`6e331afb`). It still lands, with one small adaptation, and the tests hold:

- Four of the five files apply cleanly: `internal/library/targets.go`, `mcp.go`, `skills.go`, and the new `hermes_profiles_test.go`.
- `internal/agent/hermes.go` needed a rebase: since 10-19, main gained a cold-place guard in `hermesProfiles` (#3924), and its own `hermesRoot(at place)` already encapsulates the `HERMES_HOME` resolution the diff re-inlined. Applied on top of that shape: the enumeration moves into `hermesProfileConfigs(root)` unchanged, the cold guard stays, and the diff's string-based helper lands as `hermesRootOf(dir)` with `hermesRoot(at)` delegating to it — the profiles-parent rule exists once. `agent.HermesProfiles(dir)` is the same export as posted; its only caller is the library's local `targetOf` (`wslTargetOf` has no hermes case), so the cold guard doesn't apply on this path.

| Check (Windows, `-tags nogui -p 2 -count=1`) | Result |
| --- | --- |
| `go test -run TestHermes ./internal/library` | ok, 12.6s — `TestHermesMCP`, `TestHermesMCPFound`, `TestHermesProfilesMCP`, `TestHermesProfilesSkills` all pass |
| `go test -run 'Hermes\|ProfileLink' ./internal/agent` | the same 3 failures as on untouched `7b63feb9` (pre-existing on this machine, in the 10-27 model-following area this diff doesn't touch); the rest pass |
| `go build ./...`; `gofmt -l` on the five files | clean |

The tombstone assertion nit from [my 10-22 comment](https://github.com/yetone/magpie/issues/2540#issuecomment-6345150219) still stands: `TestHermesProfilesMCP` passes here on Windows, and on macOS/Linux it fires — asserting the tombstone file itself instead of under it would pass everywhere. With that, either of the two landing options from the [status check](https://github.com/yetone/magpie/issues/2540#issuecomment-6458935765) works — taken directly, with the one `hermes.go` adaptation above folded in. @yetone

Re-checked with AI assistance — written with GLM-5.3-Flash (ZCode).
