Verified ddnio's patch from `ddnio:tapfix` (944da6c3) against upstream/main 3eb2bda4f. It works, and it is sound. Thank you, @ddnio — the two-machine real-run in the issue body is exactly the evidence this needed.

## What I applied

`git am -3` of the single commit 944da6c3 (base 6b8134430) onto upstream/main 3eb2bda4f (141 commits later). One conflict, in `internal/claudetui/tap.js` only: the file-header comment, where upstream meanwhile added the MAGPIE_CLAUDE_GUARD paragraph (extra-body safeguards) and the patch adds the allowance sentence — a comment-only clash, resolved by keeping both paragraphs. No code conflict. The applied tree is upstream/main plus exactly the patch's 4 files, +130/−8.

## Verification

Applied branch: [ggbdpq/magpie `fix/5012-setup-token-allowance-verify`](https://github.com/ggbdpq/magpie/commits/fix/5012-setup-token-allowance-verify), tip 03f3f6011 (author preserved: ddnio's commit, author Nio <ddnio777@gmail.com>).

| Check | Result |
|---|---|
| `TestTapTellsLimits`, `TestTapLimitsUnsaid` (`go test -count=1 -run 'TestTapTellsLimits\|TestTapLimitsUnsaid' ./internal/claudetui/`) | both PASS |
| Full package `go test -count=1 ./internal/claudetui/` | ok (85s) |
| `go test -tags nogui -count=1 ./internal/gateway/ -run 'Claude\|Tap\|TUI'` | ok (76s) |
| `gofmt -l internal/claudetui/` | clean |
| `go vet ./internal/claudetui/`, `GOOS=linux go vet -tags nogui`, `GOOS=windows go vet` | clean |
| Ablation: short-circuit the `{limits}` branch in `tap.line` (`&& false`), keep tests | `TestTapTellsLimits` red, as claimed; restored after |

## Relation to #5084

#5084 (qiqll's issue) has an independent patch for the same root cause — the interactive path dropping a successful reply's `anthropic-ratelimit-unified-*` headers — which we verified separately ([comment 6625505581](https://github.com/yetone/magpie/issues/5084#issuecomment-6625505581)). Upstream has picked up neither (no tap-allowance commit on main as of 3eb2bda4f), and the two do not conflict; they are complementary takes on the same tap line, and a maintainer choosing one still gets the other's ideas for free:

- **Where they agree:** both read the same headers in `tap.js` and turn them into a `rate_limit_event` in `tap.go` with the same `unifiedWindows` mapping (5h/7d/7d_oi → five_hour/seven_day/seven_day_overage_included), which the bridge's `claudeLimits` consumes unchanged.
- **What #5084's has and this doesn't:** timing — it attaches headers to the `{s, open}` line and tells the event before `message_start` as `-p` does, holds a whole-from-transcript or never-began reply's reading for turn end (`tap.settle`), and never tells a kept reading after a newer reply's (`toldOf`); plus a `transcript.go` reorder so a `<synthetic>` error's own reading stays the newest. ddnio's patch emits `{limits}` as its own line the moment the reply arrives, which is correct for the main-turn case its tests cover but doesn't address the kept-reading/ordering corner.
- **What this has and #5084's doesn't:** the refusal/representative-claim face — ddnio's `limitsInfo` also maps `representative-claim`/`reset` into `rateLimitType`/`resetsAt` and keeps a `rejected` status that says no share (so a turned-away request still lands), and handles a window whose `-reset` is missing independently of `-utilization` (#5084's `rateLimitInfo` requires both before telling a window). And it is proven against a real setup-token account: Claude Code 2.1.309's own `-p` `rate_limit_event` as the test oracle, plus hours of two-gateway real traffic (#5084's patch was verified against a captured reply without a live account; its header set is untested on a real one).

Both issues stay open for a maintainer's pick; neither patch should block the other.

Not re-verified here (as in the patch's own not-tried list): Windows/macOS hosts running the bridge, and a 429 reply through the tap.

Generated-by: GLM-5.3-Flash (ZCode)
