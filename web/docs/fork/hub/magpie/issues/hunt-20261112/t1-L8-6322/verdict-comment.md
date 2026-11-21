The rows your screenshot marks `499 · 已取消` are requests **the client hung up on** — on current `main` there is no path in magpie that interrupts a request because another session asked the same model, so the previous session is being ended on the client's side, not magpie's. What would pin which client behavior it is, is at the end; there is nothing in magpie to patch here.

**What 已取消 already tells you.** A gateway request that ends without an answer is logged 499, nginx's "the client closed the request" (`internal/usage/ledger.go:61`), and the ledger counts a call as canceled only when the error is exactly `the agent canceled the request` (`CanceledBy`, `internal/usage/ledger.go:68`). Its own words: "a person stopped the reply, **or sent the next message while it was coming and the agent asked again**". magpie's own limit on a request it asked of itself is logged 499 too, but worded `magpie stopped waiting: …` (`internal/gateway/side_deadline.go:71`), and the pages keep the two apart — the agent's cancel is no error, magpie's own is (`TestContextLeavesCanceledOutOfErrors`, `internal/gui/context_canceled_test.go:15`). So every 已取消 row above is one whose incoming connection closed first: magpie records that, it doesn't cause it. The gateway also sets no read or write timeout on an active request (`internal/gateway/gateway.go:871` — header 30s and idle 5m only), which is the same conclusion yetone reached on the same shapes in #2641.

**No path interrupts the previous session.** Everywhere a second request could touch a first one:

- A provider's or key's requests-at-once cap (`lanes.take`, `internal/gateway/concurrency.go:147`) queues newcomers strictly first-come-first-served; a waiting request leaves only when its own context ends, its queue or wait bound hits, or routing moves it to another account. An in-flight request is never revoked to make room.
- Near a usage cap an account takes one turn at a time and the next turn **waits** for it (`internal/gateway/cap_near.go`); it does not evict the turn running.
- A gateway key's cap (`internal/gateway/key_slots.go`) queues the same way — "its agent gone while it waits, it leaves the queue and nothing is sent".
- Nothing keeps another request's cancel around: the only `context.CancelFunc` the gateway stores is each request's own (the Codex socket keep, the vision wait, the side deadline, a relay's abort).

So two sessions on one model share a lane and take turns; neither is cut by magpie.

**Why sharing a model can still raise these aborts** — hypotheses, for the data below to tell apart:

1. If that provider or its key has a requests-at-once cap (one you set, or one the account's plugin declares — a Start-Plan-style GLM entry is a plugin account), the later session's request waits in the lane and sends no byte while it waits. An agent that hangs up when no first byte arrives within its own watchdog (~60s reported in #4433) produces exactly these rows, and the routing trace says it at once: the try carries a Queued wait, and a request waiting for its lane reads phase "slot" in Active.
2. Two sessions also share one plan's speed: slower first tokens under concurrency fire the same watchdog on requests already at the vendor.
3. The client's own doing — sleep, its own queueing, or "sent the next message while it was coming": #2641's reporter pinned macOS sleep this way from the client's own transcript.

The clean alternation in your screenshot — one succeeds, the next is cancelled — is what two sessions sharing one lane or one plan look like in the log, whichever request happens to be the one waiting when a client's patience runs out.

**About 刚升级 (the upgrade)**: nothing in the upgrade path writes a cap — the Providers page saves one only when you set it (`internal/gui/providers.go:2084`) — and a gateway key's own cap is new (Nov 8, `e215d335a`, first in v0.1.3317) and applies only when set. If the cancellations began exactly with the upgrade, the traces below will show whether requests started waiting; otherwise the change is likelier on the client's or the plan's side.

**To pin it down**, for one cancelled row:

1. Its routing trace (open the row on the Requests page; or `GET /v1/magpie/usage/requests`): which agent it names, and whether the try shows a Queued wait or went straight to the vendor.
2. Whether that provider or its key has a requests-at-once cap — the Providers page shows both your setting and what the account's plugin declares.
3. Which app the sessions run in (and its version), and the error text the client itself shows when a session is interrupted — that wording names the aborter (timeout, sleep, abort), as in #2641's checklist.
4. The version you upgraded from, and whether the 499s start with it.

Same family, for the record: #2641 (these semantics, diagnosed on undici clients), #4433 (the first-byte watchdog, and no failover after a 499), #3791 (an opt-in cooldown for client cancellations — the magpie-side lever if a plan really can't serve two at once), #2902 (canceled rows counted apart from failures).

Not verified: your client's identity, timeout configuration and its own error text; whether your provider or key carries a cap; the routing traces of the cancelled rows; a real two-session run (no Windows and no GLM account here — code read at `a5e5f539a`).

Attribution: written with GLM-5.3-Flash (ZCode); I've read every path cited above. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
