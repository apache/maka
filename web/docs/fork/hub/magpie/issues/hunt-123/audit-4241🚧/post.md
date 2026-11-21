Verified @Niko-Wu's fork patch for this issue — commit `8d6c39e7` on `fix/oss-batch` of their fork, based on `4534561f` — against current `main` (`d17a0b3ca`, 1,300 commits past that base). It applies cleanly (`git am -3`, 3-way, no conflicts) and every claimed behavior reproduces: the three tests are red on the unpatched sources and green after. This is an endorsement of @Niko-Wu's patch, not a new fix.

## What's wrong

As @LovelessCodes reported: an enterprise seat billed by usage (`enterprise_usage_based`, `hasExtraUsageEnabled: true`) has no 5-hour or 7-day window. Its one reading is the top-level `rateLimitType: "overage"` of the run's `rate_limit_event` (utilization 0.84, renewing at `overageResetsAt`) — and magpie throws it away. `claudeKinds` (`internal/provider/claude_limits.go`) has no `overage`, so `NoteClaudeLimits` drops it; `ratelimitWindows` (`internal/gateway/claude_subscription.go`) has no `overage` either, so no `anthropic-ratelimit-unified-overage-*` header ever reaches agents. With the reading gone, the seat's `/usage` — which prints only *"You are currently using your subscription to power your Claude Code usage"* — fails with "temporarily unavailable": a healthy account shown as unreadable.

## Root cause

Both ends of the path, exactly as traced in the report: the kind is unknown at the keep (so nothing is kept) and unknown at the relay (so nothing is said on), and a `/usage` that names no window then has nothing to fall back to — `claudeWindows` returns the kept reading only when one exists.

## The fix

@Niko-Wu's single commit, small and to the point:

- `claudeKinds` gains `{"overage", "Extra usage", "", 0}` — no span of its own, since the credits renew with the billing period.
- `claudeLimits` (`internal/gateway/claude_subscription.go`) reads `overageResetsAt` as a new field and renews the overage limit at it when Claude Code names one — for the utilization and the `rejected` branches both. Without this, taking top-level `resetsAt` would restart the credits at the wrong time (in the report's payload the two happen to be equal, which the new gateway test separates).
- `ratelimitWindows` gains `"overage": "overage"`, so `anthropic-ratelimit-unified-overage-{utilization,reset}` go out beside 5h/7d/7d_oi.

Defect 2 closes with no change of its own: with the window kept, `claudeWindows`'s existing heard-fallback (kept reading stands one hour unless the account was refused; the subscription notice is not a refusal) shows the credits instead of the error. Tests: `TestClaudeOverageSeatKeepsItsWindow` (provider — the report's seat exactly), `TestNoteClaudeLimits` (now expects the fourth window), `TestClaudeOverageSeatSaysItsWindow` (gateway — the event's utilization and `overageResetsAt` reach the reply's headers).

## Relation to #4532 and the in-flight #5084/#5012 patches

Upstream `main` gained `7b6b7492a` (#4532) between the patch's base and today: it fixes the `/usage` line *"using your overages"* by adding a Text row "Extra usage" (used 100, "In use"), and routing skips Text rows. That is the sibling path, not this one — #4241's seat prints the *subscription* notice and its reading arrives as a `rate_limit_event`, which #4532 does not cover. The two compose: `TestNoteClaudeLimitsFable` (#4532's test in the same file) stays green with this patch applied. Separately, the in-flight #5084 and #5012 patches (claudetui tap, reading the same `anthropic-ratelimit-unified-*` headers for claude.ai's status line) touch only `internal/claudetui/` — no file overlaps this patch (`internal/provider` + `internal/gateway`), so they stack cleanly. One integration note: the tap's window list maps `5h`/`7d`/`7d_oi`, so a claude.ai status line will not display the new `overage-*` header until that list learns it — an extension, not a conflict.

## Verification

Applied with `git am -3` onto current `main` `d17a0b3ca` in a clean tree; my run at head `319851618baf259f59bcf5e8d434e495aae12ee1` (Apple Silicon, Go 1.25.5, macOS):

| Check | Result |
| --- | --- |
| `git am -3` onto `main` (1,300 commits past the patch's base) | clean, 3-way auto-merge, no conflicts |
| `TestClaudeOverageSeatKeepsItsWindow` | PASS |
| `TestNoteClaudeLimits` | PASS (fourth window expected) |
| `TestClaudeOverageSeatSaysItsWindow` | PASS |
| Neighbors: `TestNoteClaudeLimitsFable`, `TestClaudeSubscriptionReplySaysTheAllowance` (stream true/false) | PASS |
| Ablation: revert `claude_limits.go` + `claude_subscription.go` to `main`, keep new tests | all three FAIL (ablation-red confirmed) |
| Ablation: restore | all three PASS again |
| `gofmt -l` (the 4 changed files) | nothing |
| `go vet ./internal/provider/ ./internal/gateway/` | clean |
| `go test -run Claude ./internal/provider/ ./internal/gateway/ -count=1` | ok (25.7s / 66.6s) |
| `go test -race -run Claude` (both packages) | ok (29.4s / 89.3s) |

## Not verified / Not done

No real enterprise usage-based seat here — the payloads are @LovelessCodes's, the same limit @Niko-Wu stated. The usage endpoint's second source remains unread, verified absent at `main`: no `extra_usage`, `spend` or `representative-claim` reading of `/api/oauth/usage` exists in the Go sources; the card and headers work from the `rate_limit_event` alone. GUI rendering untouched (no gui files in the patch); full suites beyond `-run Claude` not run.

## Attribution

This is @Niko-Wu's work — whoever lands it, please keep the commit's original authorship intact (as my verification branch does; author `Niko Wu <wwh930329@163.com>` preserved through the 3-way rebase). The diagnosis, payloads and live readings are @LovelessCodes's; the reporter has also published their own parallel branch (`claude-overage-window`, commit `3fa5b15`, which additionally keeps a heard answer via `keptAnswersFor` and documents the allowance) — this post verifies @Niko-Wu's.

Branch (patch rebased onto current `main`, authorship preserved): https://github.com/ggbdpq/magpie/tree/fix/4241-overage-window-verify — head `319851618baf259f59bcf5e8d434e495aae12ee1`; `git format-patch upstream/main..fix/4241-overage-window-verify` reproduces the identical single-commit patch (sha256 `f33c6e0a9d740275`).

AI use: verification, ablation and this comment were done with GLM-5.3-Flash (ZCode).
