This post and its patch are written by an AI (GLM-5.3-Flash via ZCode) and authored by ggbdpq. The report's mechanism analysis pointed straight at the gap; this is the fix built on it, with the tests and the evidence below run here.

**What's wrong**

On a headless `magpie serve` (the report's systemd gateway), a Claude subscription re-login plus a Max 5x upgrade left the Usage card at the sign-in before: `plan: max` — the plan is read with the credential, fresh — while the windows stayed `7 days: 100%` for some 45 minutes, the account's real allowance being 0% on every window. A separate `magpie accounts claude --json` process read 0% at once and wrote a fresh reading to `quotas.json`, which the running daemon never adopted; only `POST /api/usage/quotas/refresh?provider=claude` corrected the card (#5921).

**Root cause**

What Claude Code's `/usage` told magpie is kept per account in `claudeUsage` (a per-user map in `internal/provider/subscription_usage.go`) and served to the page's timer, the switch list and routing. The keeping knew no credential. The invalidation net around sign-ins misses it at both ends:

- `addLogin` (a sign-in magpie made) clears the credential cache, `claudeStatus`, `subscriptionUsageCache` (`forgetAccountCaches`) and the per-user usage/used caches (`StaleAllowance`) — never `claudeUsage`. The switch to a saved account doesn't either.
- A re-login made behind the gateway's back (`claude auth login` in the service env, the report's case) reaches no magpie path at all, and the unasked re-read gate (`claudeWindows`'s `due`) stays shut on a proxy-only host: no local session `.jsonl` (`claudeUsedSince`), no qualifying `rate_limit_event` — so the kept entry served for the 45 minutes. It also outranked the fresh disk reading: `withHeardClaude` puts a kept hearing over a card reading by sequence, and the daemon's own hearing was the newer number.

**The fix**

The keeping now knows what told it:

- Every reading records the sign-in it was told by (`claudeCredMark`: a digest of the live credential's access token) — the `/usage` read, and what Claude Code said as it answered (`NoteClaudeLimits`) alike. `claudeWindows`, before serving the account Claude Code is signed in to, drops a kept reading told by another sign-in of the same account: the next look reads again, on the new plan's allowance. A move to another account takes nothing away — the kept reading is that account's own and stands for it while Claude Code is signed in elsewhere (the moved-off semantics, nil_1024), so switches behave as before. Kept with no mark under the old code, an existing entry counts as another sign-in's too: a daemon already holding the stale reading is re-read on its first look after this upgrade — the report's 45-minute state heals itself without a hand refresh.
- A sign-in magpie made itself now drops the account's kept allowance where it already gave the folder's older sign-in way (`forgetClaudeUsage` beside `forgetClaudeDir` in `addLogin`, and in the switch that puts a saved account's sign-in on Claude Code).

`provider: a re-login for a Claude account gives way the allowance the sign-in before told (#5921)`, branch [`fix/5921-stale-claudeusage`](https://github.com/ggbdpq/magpie/commit/1724af304661a8efb0bb97a6f77cd7e04b961d4d) on `4623f5419` (current main):

```sh
git am https://github.com/ggbdpq/magpie/commit/1724af304661a8efb0bb97a6f77cd7e04b961d4d.patch
```

sha256[:16] = `e733696720f7fb48` · `git am` into a clean tree at `4623f5419`: zero conflict.

**Verification** (this machine, darwin, `-tags nogui`)

| Check | Result |
| --- | --- |
| `TestClaudeUsageOfASignInBeforeGivesWay` (new; the report's shape) | red before — after a same-account re-login (fresh tokens, the tier moved) the unasked look still served the kept `100%` windows and ran nothing — then green: read again on the new sign-in (5%/20%), one run |
| `TestSignInDropsTheKeptAllowance` (new) | red before — `claudeReadAt` still the hour-old reading after `addLogin` — then green: nothing kept, the next look reads |
| `TestClaudeUsageOfAnotherAccountNotKept`, `TestClaudeSeatKeepsItsOwnUsage` | green — the moved-off and seat semantics stand (a switch leaves each account's own reading standing) |
| `./internal/provider` whole | green, and green on the parent commit `4623f5419` too — nothing pre-existing hides here; the four named tests green with `-race`; gofmt clean |
| `gateway` reads of the kept limits (`TestRefusedMidReadRestsByWindow`, `TestClaudeSubscriptionFailedTryKeepsItsTokens`, client-cache usage tests) | green |
| real headless systemd gateway, real Anthropic | NOT-RUNNABLE here — the fixtures pin the report's shape (same account, fresh tokens, moved tier, no local sessions); the report's own evidence stands: fresh 0% read by a separate process at once, `POST /api/usage/quotas/refresh` correcting the card |

**Ablation**

- The kept-reading drop taken out of `claudeWindows`: `TestClaudeUsageOfASignInBeforeGivesWay` red again (the `100%` windows served), `TestSignInDropsTheKeptAllowance` still green.
- The sign-in drop taken out of `addLogin`: `TestSignInDropsTheKeptAllowance` red again, the first still green.
- The moved-off guard taken out (drop regardless of who Claude Code is on): `TestClaudeUsageOfAnotherAccountNotKept` and `TestClaudeSeatKeepsItsOwnUsage` red — a switch to another account must not take the account's own reading away. Restored: all green.

**Sibling scan**

Every reader of `claudeUsage` takes the drop without change: `withHeardClaude` stops overriding the card with the old hearing (the disk reading shows instead, and a fresh hearing outranks it again as before), `KeptClaudeLimits` weighs routing without it until an answer tells it again, `claudeReadAt` nil, out-soon nothing to say. Every writer stamps it. `StaleAllowance` stays untouched on purpose: `NoteClaudeLimits` calls it after writing a fresh hearing, and dropping there would erase the fact just told. The other caches around the card were already in the net (`loginUsageCache` holds a minute at most, `subscriptionUsageCache` in `forgetAccountCaches`, per-user usage/used in `StaleAllowance`); Codex's usage is read from the vendor each time and keeps no such per-account memory, so no sibling gap there.

Generated-by: GLM-5.3-Flash (ZCode)
