Verified @qiqll's fork branch `pr/claude-tui-allowance` (head a922ea3a03e3715f14f922733009294101ef021f, based on 6c201095) against current `main` (0ee424e3ee61ae545d93160084a8d930b88a8193). It applies cleanly and all claimed behavior reproduces. This is an endorsement of the reporter's patch, not a new fix.

## What's wrong

As @qiqll reported: since the interactive mode replaced `-p` for Claude subscription turns (43966a53, e5f66f8a), a turn that *succeeded* told no `rate_limit_event`, so `NoteClaudeLimits` never ran and the Usage page's 5h/7d figures only moved on a manual refresh (`/usage`). Only a turn ending in a `<synthetic>` API error told one.

## Root cause

The tap only surfaced limits from a transcript row of an errored turn; the successful reply's `anthropic-ratelimit-unified-*` response headers — which `-p` surfaces as `rate_limit_event` — were never read or relayed, so the gateway had nothing to feed `NoteClaudeLimits` with on the happy path.

## The fix

Exactly as proposed in the reporter's commit (a922ea3a0): tap.js copies the `anthropic-ratelimit-unified-*` headers of a main-class reply into the tap's `{s, open}` line (read-only); tap.go turns them into the `rate_limit_info` `-p` emits (status + unifiedWindows, each window only when both utilization and reset are numbers, reset rounded to a second); a streamed reply tells it just before `message_start`, a whole-told or never-started reply keeps it for `tap.settle`; an older kept reading is never told after a newer reply's (`toldOf`); a `<synthetic>` error settles the tap first, then tells its own reading so the error's stays newest. Gateway unchanged, as it already converts `rate_limit_event` into `NoteClaudeLimits`.

## Verification

Applied with `git am -3` onto current `main` (79 commits past the reporter's base; the same area gained the `MAGPIE_CLAUDE_GUARD` extra-body feature in tap.go/tap.js and doc changes — disjoint from this patch, and the 3-way merge resolved both cleanly, no conflicts). Result of my run at head 45b1eec99aa530a958e42f0f6c6b153354b45b25 (Apple Silicon, Go 1.26.8, macOS):

| Check | Result |
| --- | --- |
| `git am -3` of `format-patch 6c201095..a922ea3a` onto current main | clean, 3-way auto-merge, no conflicts |
| `TestTapTellsReplyLimits` | PASS |
| `TestTapLimitsOfMessageToldWhole` | PASS |
| `TestTapErrorLimitsLast` | PASS |
| `TestShimTellsTapLimits` | PASS |
| `TestTapKeptLimitsNotAfterNewer` (both subtests) | PASS |
| Ablation: revert tap.go/tap.js/transcript.go to base, keep new tests | all five FAIL (ablation-red confirmed) |
| Ablation: restore | all five PASS again |
| `go test -count=1 ./internal/claudetui/` | ok (86s) |
| `gofmt -l internal/claudetui/` | nothing |
| `go vet ./internal/claudetui/` | clean |
| `GOOS=linux go vet -tags nogui ./internal/claudetui/` | clean |

## Not verified

A real claude.ai subscription turn (headers were not checked against a captured reply) — same limit the reporter stated; Windows/WSL; `internal/gateway` suite (no gateway files touched); the full `go test ./...` suite.

## Attribution

This is @qiqll's work. Whoever lands it, please keep the commit's original authorship intact (as my verification branch does). Adding `Co-authored-by` for the verifying party is optional.

Branch (patch rebased onto current main, authorship preserved): https://github.com/ggbdpq/magpie/tree/fix/5084-tui-allowance-verify — head 45b1eec99aa530a958e42f0f6c6b153354b45b25; `git format-patch upstream/main..fix/5084-tui-allowance-verify` reproduces the identical single-commit patch.

AI use: verification, ablation and this comment were done with GLM-5.3-Flash (ZCode).
