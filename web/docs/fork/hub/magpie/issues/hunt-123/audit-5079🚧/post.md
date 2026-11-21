Independent verification of the root cause, plus an overlap note with #5085. I am not attaching a patch: @uiuing has already pushed a complete fix (`uiuing/magpie@19b1bd926`, branch `fix/claude-careful-unread`), so this stays with @yetone to review and take.

**The chain, verified by reading at `1e1068c86` (current main):**

- `carefulDoubt` (`internal/gateway/cap_careful.go:44`) holds an account whose usage was never read or whose last read failed, per `UsageRead` (`internal/provider/routing.go:798`).
- After a restart a saved Claude account has only its disk reading, and `loginUsageEntry.state()` (`internal/provider/login_usage.go:45`) counts any reading with `AsOf` set as failed — so every saved account reads as "its usage couldn't be read".
- `readCareful` (`cap_careful.go:73`) answers the hold with `ReadUsageNow` (`routing.go:810`), which drops the caches (`StaleAllowance`) and waits for a reload — but the reload lands in `claudeWindows` (`internal/provider/subscription_usage.go:819`), which runs Claude Code's `/usage` only on a card refresh (`savedRefresh`), a spare read (`spareRead`), or the keep-alive. A careful re-read ask is none of these: the saved account is handed the kept disk reading again, `state()` still says failed, and the hold repeats on every request — the local 429 until a manual card refresh, matching the timeline in the report. The signed-in account can stay held alongside (its re-read needs the failure wait plus Claude Code having been used, and a fully held pool sends nothing through Claude Code), which is why the pool is stuck as a whole.

**On the proposed fix (read at `19b1bd926`, not run):** it looks correctly scoped to me.

- The ask record (`readAsked`) is written by the general `ReadUsageNow` and only `claudeWindows` consults it — no Claude branch in the general entry point; readers without the extra schedule keep reading through the dropped cache as before.
- The ask is honored only when there is no good reading yet (`e.ws == nil && e.err == nil`) or after a failed read's wait, which keeps the 30-second floor, the failure wait, and the `carefulRetry` throttle in `readCareful` — an account whose read keeps failing does not start `/usage` on every request it holds.
- `unreadBack` only shortens an existing `Retry-After` longer than `carefulRetry` (15s), preserving a sooner reset and an absent header, with the mixed spend-cap candidates covered.

**Overlap with #5085** (related: #5085 — deferred readings not folded into failure; different facet): #5085 changes `state()` so a kept reading nobody asked for again is not counted as failed, which releases the hold and routes on the stale reading; this issue keeps the hold but makes the re-read ask actually reach `/usage`. The semantic faces are disjoint (`login_usage.go` vs `routing.go`/`subscription_usage.go`/`fallback.go`); the only file both touch is `docs/subsystems/gateway-routing.md`, one line each, so a trivial rebase either way. If both landed they compose: deferred kept readings stop being held (#5085), genuinely failed reads re-read for real (#5079). The sequencing call is the maintainer's.

**Not verified:** I read the patch and traced the chain, but did not run `19b1bd926`'s tests or its real-world acceptance; the reporter's verification stands as theirs. Client retry behavior against the shortened `Retry-After` (expectation 3) remains unverified here too.

AI use: analysis written by GLM-5.3-Flash (ZCode); keep author ggbdpq or Co-authored-by: ggbdpq <ggbdpq@gmail.com>.
