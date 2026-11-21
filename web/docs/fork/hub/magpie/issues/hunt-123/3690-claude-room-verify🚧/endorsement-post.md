I was on this one too — yielding to @skygunner's fix branch and verifying it instead of posting a competing patch. I can endorse it: the mechanism is right, it applies to current main cleanly, and every check I ran on it passes.

**Mechanism, link by link** (checked against current main, e17b6cefc):

1. **The second remake site is `release`.** `release` (internal/gateway/claude_room.go:298-299 on main) does `close(c.freed); c.freed = make(chan struct{})` unconditionally — no `waiting` guard — while `nudge` (lines 285-286) guards the same pair with `if c.waiting > 0`. Those are exactly the two sites the report names; `release` is the unguarded one.
2. **The crash path.** `claudeRoom` is a package-level var, so a `take`+`release` inside a synctest bubble leaves the replacement `freed` owned by that bubble; the next `release` outside it closes a foreign channel: `fatal error: close of synctest channel from outside bubble`.
3. **How the branch blocks each link.** `take` makes `freed` only on the waiting path, under the same lock hold that increments `c.waiting`, so no observer ever sees `waiting > 0` with `freed == nil`; each leaving waiter decrements the count and the last one sets `freed = nil`; `wake()` — now called by both `release` and `nudge` — closes only while `waiting > 0 && freed != nil`. A release nobody waits on closes nothing, so no channel is made that doesn't have a waiter, and none outlives its waiters.
4. **Same shape as #3632's filememo fix** (4842f69be): channel made lazily by the consumer that waits (`take` / filememo's `Written`), closed only if one was taken by a single shared helper (`wake` / filememo's `endWaits`). #3632's own commit message already flags this disease: "internal/gateway's claudeRoom closes and remakes its freed channel the same way … #3690."

**Verification** (darwin/arm64, go1.26.8 via the repo's toolchain directive):

| Check | Result |
| --- | --- |
| New test on pre-fix code (their fix reverted to parent code, test kept) | RED — `fatal error: close of synctest channel from outside bubble` at `(*claudeRoomT).release` claude_room.go:298, from the test's run ending after its bubble (claude_room_test.go:454) — the report's exact signature |
| Branch as pushed, at its own base (`fix/3690-claude-room-freed`, head 56b4f3174 on 6afbe3f3) | `go test -tags nogui ./internal/gateway/ -run TestClaudeRoom` → ok |
| Applies to current main | base lags main by 1721 commits; the only commit touching claude_room.go since (9a951eb03, cgroup walk) is a disjoint region — `git am -3` applied clean, no conflict (as 569fee17b) |
| New test with fix on main + am | `TestClaudeRoomEndsOutsideItsSynctestBubble` PASS — the woken-ask path really runs (log: "second waits for room" → "second had room after 0s") |
| All room tests | `TestClaudeRoomLetsAnIdleRunGoAndItResumes`, `TestClaudeRoomFullIs503`, `TestClaudeRoomEndsOutsideItsSynctestBubble` all PASS |
| Full touched package | `go test -tags nogui -timeout 25m ./internal/gateway/` → ok, 0 red |
| gofmt (CRLF-safe, `tr -d '\r'` piped) | clean on both changed files |
| `go vet -tags nogui ./internal/gateway/` | clean |
| Freshness | no upstream commit fixes #3690 (grep over upstream/main finds only #3632's cross-reference); main's `release` still closes/remakes unconditionally |

Branch: skygunner/magpie `fix/3690-claude-room-freed` (head 56b4f3174abc0643854d4d82c1dc8a9b8660dc33)

Not verified: packages beyond internal/gateway, `-race`, and GOOSes other than darwin/arm64.

AI use: verification performed with AI assistance; all commands and outputs above were run and read locally.

Thanks @yinwu01 for the report and @skygunner for the fix branch.
