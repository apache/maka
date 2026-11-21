Re-verified at current main (`eb1b83000`) — rebased with zero drift (range-diff identical; nothing upstream touched `internal/davsync` in between), patch bytes unchanged.

| Element | Evidence at `eb1b83000` |
| --- | --- |
| Rebase | `hunt-20261114-d1-3356` = `eb1b83000` + the patch, range-diff identical |
| git am | replays on a clean `upstream/main` to a byte-identical tree |
| Tests | `internal/davsync` in full: ok (49s); `-race` on the rejoin test: ok; `go vet`, `gofmt` clean; `GOOS` linux/darwin/windows `nogui` builds ok |
| Ablation | `davsync.go` reverted with the tests kept: `TestSyncPartTurnedBackOnWithoutOffMark` fails — restored, green |
| Siblings | `internal/davsync` untouched by upstream since the patch post — the scan conclusions stand |
| Real path | unchanged from the patch post: the reporter's tested overwrite path is covered by the rejoin fallback; a real pre-upgrade state + live WebDAV/S3 server stays not verified |

Branch with the commit: [hunt-20261114-d1-3356](https://github.com/ggbdpq/magpie/tree/hunt-20261114-d1-3356) (head `e94c150839784940`). Patch bytes are identical to the post above — SHA-256 first 16: `301fbfd2f9e8108e`.

Attribution: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
