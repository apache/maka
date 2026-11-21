Re-verified at current main (`eb1b83000`) — rebased with zero drift (range-diff identical; nothing upstream touched `internal/agent` in between), patch bytes unchanged.

| Element | Evidence at `eb1b83000` |
| --- | --- |
| Rebase | `hunt-20261114-d1-4258` = `eb1b83000` + the patch, range-diff identical |
| git am | replays on a clean `upstream/main` to a byte-identical tree |
| Tests | `internal/agent` in full: the only red is the pre-existing `TestMothX` (documented standing red, same on the base commit); the new test green, `-race` on it ok; `go vet`, `gofmt` clean; `GOOS` linux/darwin/windows `nogui` builds ok |
| Ablation | the three product files (`claude.go`, `codex.go`, `stash.go`) reverted with the tests kept: `TestDisconnectFailureKeepsStashedOriginals` fails on both its `claude` and `codex` subtests — restored, green |
| Siblings | the `peek`/`forgetValues` consumers re-scanned at this tip: the 5 call sites stand, no new `unroute`-family callers upstream |
| Real path | unchanged from the patch post: mode 1 (delete + restore-write before the restored write) is reproduced by the test's subtests; a real cross-process concurrent stash write (mode 3) stays not verified, listed as left |

Branch with the commit: [hunt-20261114-d1-4258](https://github.com/ggbdpq/magpie/tree/hunt-20261114-d1-4258) (head `57ef507fd47213d8`). Patch bytes are identical to the post above — SHA-256 first 16: `c9663118cd5ad6ac`.

Attribution: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
