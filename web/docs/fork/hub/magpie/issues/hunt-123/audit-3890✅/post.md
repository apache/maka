Judgment: this is already fixed. The fix is commit f8cd964ae ("plugin: a fetch past the host's 128 streams waits for one, not a local 502 (#3890)"), and as the maintainer corrected below, v0.1.1767's release job failed so that release was never published — the fix actually first shipped in **v0.1.1780** (published 2026-10-27, which was Latest at the time of the correction).

**What the fix does** (per the maintainer's comment above, confirmed in the commit): once the shared plugin host's 128 stream windows (64 MiB budget / 512 KiB window) are all held, a plugin fetch now waits for one to come free instead of failing immediately with `too many plugin calls are in flight` (which the gateway recorded as a local 502 try and retried). The wait is bounded at 1 minute (`streamWait`), ends early if the request context is cancelled or the plugin host goes away, and RPC calls keep their reserve and never wait. The 64 MiB budget is unchanged.

**Tip status** (verified at `e17b6cef`, current `upstream/main`, where f8cd964ae is an ancestor):

- `internal/plugin/host.go:167-168` — `streamWindow = 512 << 10`, `streamBudget = 64 << 20` (so `streamLimit()` = 128, line 213)
- `internal/plugin/host.go:182-188` — `streamWait = time.Minute` with the #3890 rationale
- `internal/plugin/host.go:1636-1652` — `beginStream`: bounded, cancellable wait for a free stream window; past `streamWait` it returns `errTooManyCalls` as before
- `internal/plugin/host.go:1937` — the fetch path admits through `beginStream`
- `internal/gateway/plugin_stream_admit_test.go` — `TestPluginStreamsPastTheBudgetWait` (192 concurrent streams through the real Bun plugin host; all 200 on one try, vendor never sees more than 128 at once) and `TestHostFetchWaitsForAStreamWindow` in `internal/plugin/host_test.go` are both present at tip. #3946 later hardened this test's dial behavior on macOS; nothing re-opened the original admission issue.

**Version check**: `git tag --contains f8cd964ae` shows the v0.1.1767 tag exists and contains the commit, but the GitHub release for v0.1.1767 is 404 Not Found (never published), and the v0.1.1780 release is published (2026-10-27T21:59:39Z) — consistent with the maintainer's correction.

**Upgrade guidance**: @NightGlowww reported observing CLI builds 0.1.1711/0.1.1714, which predate the fix. Upgrading to **>= v0.1.1780** picks up the fix; the current latest release is **v0.1.2890** (2026-11-04). In your 192-batch routing records you should now see one try per request; only after a 1-minute wait with all 128 windows still held would the old `too many plugin calls` error reappear.

Thanks @NightGlowww for the measurements.

Not verified: I did not rerun the 192-concurrent-stream scenario against a live plugin-backed provider myself; the above is code/commit/release verification against tip, plus the maintainer's test evidence in the commit message.

AI use: analysis performed with AI assistance; all code reads above were run locally at e17b6cef.
