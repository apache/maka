Checked against current `main` (`d8b3749ef`): confirmed. A compaction turn that finds no run and no shelved session is served by `replaySession` (internal/gateway/claude_replay.go), which writes the conversation as Claude Code's own transcript whose user line carries the whole history as one message. That wire prefix Anthropic has never cached, so only Claude Code's own system+tools reads and the whole history is written again. Both measurements here are that signature — the same one #5043's retry tabled (`cache_read` 21,280 / `cache_write` 221,350): read ≈ system+tools only, write ≈ the whole conversation.

The chain, from this issue's log against main's code:

| Log line | What it is |
| --- | --- |
| `tool results no run waiting` | The compaction request carries the last turn's tool results (its tail is 64 messages past the last full reply). `match` finds no live run parked on those calls. |
| `no run waits for this turn: its run ended 20m36s ago: another run was kept in its place (6 wait at most)` | No idle run of the conversation, and no shelved session under the request's exact turn key (`unshelve` looks the key up exactly; its only fallbacks are the prompt-suggestion and rewritten-conversation cases). The line then names the latest death recorded among the conversation's keys (`b.lost`, filled at run removal) — the run it blames is the one shelved and resumed 3 minutes earlier, so the report's "the log points at the wrong cause" is right: the entry predates several healthy turns, and the run that died just before the compaction left no entry at all (why, below). |
| `a new Claude Code goes on with the conversation from a transcript of it (93 messages, 0 images), typed the last turn's 64` | `replaySession`: a two-line transcript, the history as one user message, `--resume`, the 64-message tail typed. A prefix Anthropic never cached: read 19,448 / write 198,192. |

Why there was neither a run nor a shelf. The bridge keeps a conversation going three ways: a run idle for its next turn (`keepIdle`, 6 conversations at most), a session shelved at the exact turn key the next request arrives under (`shelve`/`unshelve`, kept for the cache TTL, 1h), and a run parked on tool calls that is still alive when the results arrive (`match`). A run that ends while parked on tool calls falls through all three:

- `park` computes no shelf key, and `shelve` requires an idle key, so when the run is removed its session file is deleted (`removeRun`: `if !shelved { removeSession(sessions, sid) }`).
- No conversation entry is recorded for it either (`convKey` is set only when a run has gone idle or was let go oversized after a whole turn), which is why the log falls back to the earlier run's entry.

`oversized` documents the trade-off for letting a parked run go: "One waiting on its caller's tool results has no session to shelve there: let go, it is started anew with the whole conversation, which Anthropic's cache has not seen" (internal/gateway/claude_rss.go). A conversation at 427K preTokens is exactly the size that budget lets go — and exactly the size a client compacts at: the two meet at the same turn. (Inferred: the excerpt doesn't include the line that ended the parked run — `is let go while it waits on tool calls` would be the oversized path's; a plain exit would also fit.)

For the terminal path's history: it is brand new — `replaySession` (37d7913c2, Nov 1) replaced the one-message paste for #4778/#4780, which had the same cache economics. The compaction cost in this issue predates it and survives it; reliability improved, the prefix did not.

Relation to #5043 and #3808: same terminal path, different trigger. #5043's cancel-then-retry and this issue's compaction both end at `replaySession` once no run and no shelf remain. The fix there (40a287b21) stopped the loop; the replay write it left open (its item 1) is this same write, as is #3808's turn after a cancelled one. One fix at this path serves all three, and the work should be tracked together.

The direction the report names — go on from the run's session the way a side question branches (`branchAt`, #1638) — is right; the design choice is where the session comes from and under what key it waits. Two candidates, not mutually exclusive:

| Option | What it fixes | Weight |
| --- | --- | --- |
| 1. Shelve a parked run's session when it dies | The chain nailed above: at `park` the run has its turn's request, so the key the results request arrives under is computable; on a parked death (the oversized(3) let-go included) the session is shelved instead of deleted, and the results — and the compaction request carrying them — `unshelve` the way a normal next turn does, told only `since`, whose "messages after the last full reply" already fits. | A lifecycle change across `park`/`shelve`/`removeRun`; `shelve`'s idle-key precondition needs a parked variant. |
| 2. Let `unshelve` fall back to the freshest shelf entry of the same conversation | Turn-key drift between the shelved turn and the request — a compaction request whose system prompt, tools or model differ from the turn before, or a client whose prompt is not the run's (the bridge itself never hands a `-p` branch to an interactive run for exactly that reason). The shelf entries already carry the conversation key. | Small, but only helps while a session is actually on the shelf; combines with 1. |

What doesn't work on its own: making `replaySession`'s transcript byte-faithful. Clients send no thinking or signature blocks back, so a pasted history still diverges from the cached prefix at the first assistant message that had thinking — #3808's territory.

Two things would settle the remaining links, if you still have them:

1. The magpie log between the healthy turn (read 173,738) and the compaction request: whether a line like `is let go while it waits on tool calls` or a `stopped` line appears. That names what removed the run, and whether option 1 alone would have caught this instance.
2. A manual `/compact` through magpie on a conversation whose run is alive and idle, right after a healthy turn: if it reads the cache, the exact-key shelf is fine and the parked-death chain is the whole story; if it rewrites, dimension drift participates too and option 2 earns its place.

Not verified: no Claude Max account or 427K-token session was run; nothing was measured on the reporter's build or on 0.1.2627; the table reads this issue's log against `main` (`d8b3749ef`); no minimal repro was attempted. No code was changed.

AI use: written by a coding agent (GLM, via ZCode) from the repository and this issue's text, posted by ggbdpq.
