Thanks for putting this together, @leox8136 — the per-item table with commits, tests and honest caveats makes each item easy to evaluate on its own. I audited all eleven against current main (`db7c57670`). My read:

| # | Item | What main does today | Verdict |
|---|---|---|---|
| 1 | Auth file cache + prebuilt index | `access.Check` re-reads and re-parses `caller-keys.json` on every request (`access.Check` → `load`, `internal/access/access.go:202` at `db7c57670`). Slow but correct; having no cache is also what makes a revoke take effect on the very next request. | Performance feature, not a defect. |
| 2 | Per-key budget locks | One global mutex covers the whole budget state, and a key's first window read of the window parses the ledger while holding it (`internal/budget/budget.go`, `state` / `reserve` → `sumsFor` → `read`). One slow caller can delay every other key's admission. Correct, just serialized. | Performance feature (a lock-granularity redesign), not a defect. |
| 3 | Per-caller chunk index for the ledger | Main already keeps immutable compressed blocks and skips whole blocks by time window (`visitBlocks`) and by session (`blockSessions`, #4370) in `internal/usage/log_index.go`. A caller-key set per block is the same mechanism with one more dimension; your own caveat that gains shrink as keys spread across blocks applies here too. | Performance feature extending an existing mechanism. |
| 4 | Reliable budget reads + merged multi-window scan | **The first half is a real bug on main** (details below). The second half — one scan serving several windows instead of one read per window (`budget.sumsFor`) — is a performance feature. | Bug (first half) + performance feature (second half). |
| 5 | Write-failure protection and explicit recovery | `usage.Append` documents the current behavior as deliberate: "Errors are swallowed: accounting must never break a call." (`internal/usage/usage.go:285`, `db7c57670`). Fail-stop reverses that choice. | Design change — the call belongs to the maintainer. |
| 6 | Body reuse / unified memory admission | — | Performance feature. |
| 7 | Per-caller concurrency isolation, bounded queues | — | New capability (429s, queue and wait limits). |
| 8 | Non-streaming responses handled per content block | — | Performance feature. |
| 9 | History expansion counted into admission/budget | — | Budget-semantics change: charge the expanded request. |
| 10 | WebSocket resource guards | — | Robustness/performance features (four commits). |
| 11 | Path prefix for the whole service | — | Deployment feature. |

**On the bug in item 4.** I reproduced it on clean main (`db7c57670`) independently, before looking at your commit. With a 500-token daily cap and one recorded 800-token call, a torn write that leaves half of that record's line undecodable — what a crash mid-append leaves behind — makes the next read sum the window as zero, and the over-cap key is admitted:

```
=== RUN   TestReserveRefusesWhenLedgerLineIsTorn
    torn_ledger_red_test.go:74: a torn ledger line reads as no use: a key over its cap is let in
--- FAIL: TestReserveRefusesWhenLedgerLineIsTorn (1.14s)
```

The dropped line is `readLogSnapshot`'s silent `continue` on a record that fails to parse (`internal/usage/log_index.go:200`, `db7c57670`), and the sums go straight into `budget.read`'s zero. This is exactly the case docs/code-standards.md calls out: "A failed read, parse or hash means "unknown". It never means "empty", "none" or "equal". … A list that guards access (an allow list, a key limit) fails closed when its file can't be read." That paragraph in the standard lists four earlier fixes of the same family.

Your b8ee83a07 already covers it, and more completely than a narrow patch would: unreadable, malformed, incomplete and unverifiable ledger data all refuse cold admission, with the 503 path, CLI and GUI reporting unknown use. I am not sending my own patch for it — a second, narrower implementation of the same fix would only collide with yours. If items get picked from this branch one by one, this is the one I'd treat as a bug rather than a preference: it is the only item that contradicts the project's own written standard. The other ten stand or fall on benchmark numbers and design taste, which remains a preference call for you and @yetone.

**On item 5**, worth an explicit decision rather than a quiet merge: it reverses a documented choice ("accounting must never break a call"). Both readings are defensible — availability versus billing integrity — and whichever way it goes, the comment in `usage.Append` and the subsystem docs should be updated to say so.

**Attribution**: written with GLM-5.3-Flash (ZCode); the reproduction above I ran myself on a clean checkout at `db7c57670`.
