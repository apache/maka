Rebased onto `764a032f6` — `3ce2a9819` had since changed `rtkClaudeDir` for WSL distros' own rtk, so the conflict was that signature against this patch's remover edits; resolved on the upstream shape, with the three-event drop (PreToolUse, PostToolUse, SessionStart) layered on it.

Verification, re-run on this window's head `836f39fc9` (Windows, Go 1.26.8 via `GOTOOLCHAIN=auto`):

| Check | Result |
| --- | --- |
| RED — `internal/library/rtk.go` reverted to the parent `764a032f6`, tests kept | `TestRTKRemoveClaudeOtherEvents` fails with the issue's own refusal: `rtk's hook is still in Claude Code` (`rtk_test.go:257`); `TestRTKRemove` stays green (pre-existing surface, unchanged) |
| With the patch | `TestRTKRemove` and `TestRTKRemoveClaudeOtherEvents` pass, the whole `RTK` family `ok` |
| gofmt (CRLF-normalized) and `go vet -tags nogui` (windows, linux, darwin) | clean |
| Builds (native, `CGO_ENABLED=0 GOOS=linux`, `CGO_ENABLED=0 GOOS=windows`, each `-tags nogui`) | ok |
| Targeted `-race` | not runnable on this box (no C toolchain); the original delivery's darwin run covers it |

Branch with the commit: [hunt50-d-rtk-hook-off](https://github.com/ggbdpq/magpie/tree/hunt50-d-rtk-hook-off) (head `836f39fc9`).

written with GLM-5.3-Flash (ZCode)
