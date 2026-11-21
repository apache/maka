Re-verified at current main (`8ce32d700`) — the two commits rebased with zero drift (range-diff identical).

| Element | Evidence at `8ce32d700` |
| --- | --- |
| Rebase | `hunt-20261111-rf-5782` = `8ce32d700` + the series, range-diff identical |
| git am | the series replays on a clean `upstream/main` to a byte-identical tree |
| Tests | the `TestDsh*` family green (fresh-generation spec's settled-read tests included); `internal/agent` in full: the only red is the pre-existing `TestMothX` (documented standing red, same on the base commit); `-race` on the family ok; `go vet`, `gofmt` clean; `GOOS` linux/darwin/windows `nogui` builds ok |
| Ablation | `dsh.go` reverted with the tests kept: `TestDshRouteAgainSkipsAFileBeingWritten` fails (a route re-issued onto a list mid-write) — restored, green |
| Siblings | `internal/agent/dsh.go` saw no upstream change in the window; the dsh readers/writers split stands as scanned |
| Real path | unchanged from the earlier posts: the tests drive the real half-write/stable-empty-list read paths; a real interrupted provider write stays not verified (needs the reporter's capture) |

Branch with the commit: [hunt-20261111-rf-5782](https://github.com/ggbdpq/magpie/tree/hunt-20261111-rf-5782) (head `c035ec5ce3ca4ccb`). Series SHA-256 first 16: `efb5a47c5859066a` (0001 mid-write), `fdaa96d7a8b574de` (0002 stable empty).

Attribution: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
