Re-verified at current main (`f53c4a1a1`) — the patch rebased with zero drift (range-diff: 1 commit, identical; nothing upstream touched `internal/provider/logins.go`/`claude_dirs.go` in between), so the patch bytes are unchanged. Full six-element chain, each fresh at this tip:

| Element | Evidence at `f53c4a1a1` |
| --- | --- |
| Rebase | `hunt-20261114-d1-3254` = `f53c4a1a1` + the patch, range-diff identical |
| git am | replays on a clean `upstream/main` to a byte-identical tree |
| Tests | `internal/provider` in full: the only red is the pre-existing `TestResolveVia` (gw.invalid EOF), which fails the same on the base commit without this change; the forget/switch lock family green, `-race` on it ok; `go vet`, `gofmt` clean; `GOOS` linux/darwin/windows `nogui` builds ok |
| Ablation | the `ForgetLogin` guard reverted with the tests kept: `TestClaudeForgetRefusedWhileAnotherMagpieRunsTheFolder/held` fails (`nil`, the forget went through under the run) — restored, green |
| Siblings | `forgetClaudeDir` callers re-scanned at this tip: `forgetLogin` (this patch), the switch hand-over (behind its own wait, `403323af7`), the fresh-sign-in replacement in `signin.go` (rebuilds a directory at once) — unchanged from the patch post |
| Real path | unchanged: the held-lock fixture is the repo's own convention for another process's run (#4532's tests); a real two-process run across two magpie instances stays not verified |

Branch with the commit: [hunt-20261114-d1-3254](https://github.com/ggbdpq/magpie/tree/hunt-20261114-d1-3254) (head `d6f72ab0900d5e98`). The patch is byte-identical to the one posted above — SHA-256 first 16: `b14aeb1bb6b32591` — so `git am` from either post lands the same tree.

Attribution: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
