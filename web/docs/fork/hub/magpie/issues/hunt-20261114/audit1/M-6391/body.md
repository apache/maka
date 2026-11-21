Re-verified at current main (`eb1b83000`) — rebased with zero drift (range-diff identical; nothing upstream touched `internal/provider`'s claude-dir files in between), patch bytes unchanged.

| Element | Evidence at `eb1b83000` |
| --- | --- |
| Rebase | `hunt-20261114-d1-6391` = `eb1b83000` + the patch, range-diff identical |
| git am | replays on a clean `upstream/main` to a byte-identical tree |
| Tests | the new test green, `-race` on it ok; `go vet`, `gofmt` clean; `GOOS` linux/darwin/windows `nogui` builds ok (the `internal/provider` full run's only red is the documented pre-existing `TestResolveVia`, same on the base commit) |
| Ablation | `claude_dirs.go` reverted with the tests kept: `TestClaudeDirOlderSignInKeepsTheSavedOne` fails — `logins.json took the directory's tok-max@x.com over the saved tok-max-fresh` — restored, green |
| Siblings | `takeClaudeDir`/`syncClaudeDir` callers re-scanned at this tip; the guard's placement stands, no new callers upstream |
| Real path | unchanged from the patch post: reproduced at the state-file level (the test drives the real read/take path); real two-machine sync with a live WebDAV/S3 stays not verified |

Branch with the commit: [hunt-20261114-d1-6391](https://github.com/ggbdpq/magpie/tree/hunt-20261114-d1-6391) (head `cb4ff36a655edbfe`). Patch bytes are identical to the post above — SHA-256 first 16: `853983c6d927ffa1`.

Attribution: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
