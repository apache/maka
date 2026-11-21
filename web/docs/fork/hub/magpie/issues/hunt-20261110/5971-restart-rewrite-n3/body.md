AI-written patch from ggbdpq's hunt — branch [`fix/5971-restart-shelf`](https://github.com/ggbdpq/magpie/commit/ae6b8d1b7) on main `db0f2f20d`, `git am` ready, sha256[:16]=`4e0019a45cf3cd5e`, patch: https://github.com/ggbdpq/magpie/commit/ae6b8d1b7.patch

**What's wrong** — the transcript in the report. A conversation's run waits for its next turn in the gateway's memory, and the sessions runs let go past `idleMost` wait on the shelf, in memory too. A restart — quit and reopen, magpie's own update's handover included — leaves the session *files* where Claude Code saved them but loses the mapping, so the conversation's next turn finds no run (`whyNoRun`'s "no run here has had this conversation") and `replaySession` writes the whole history before the last reply as one user message. Its bytes differ from what the old run sent, so Anthropic's cache matches only Claude Code's own system prompt and tools, and the conversation is written again — the measured 92K–212K `cache_write` rows, each restart, each conversation.

As the report says, this is separate from #5963: `ee818e8bc` lets Claude Code read its flags so Message Threads stop re-sending history *per turn*; this is the restart losing *which session a conversation resumes*. Not covered there.

**The fix** — the shelf becomes a file beside the providers' list (`claude-shelf.json`), written at each change of the shelf: a run let go onto it, one taken off (unshelve), one retired (retire), one waited out (its timer). The gateway shelves every waiting run as it ends, before its runs are aborted; magpie ending on a signal — SIGINT/SIGTERM/SIGHUP, where the gateway's own end never runs — shelves them too, next to `FlushSticks`. A turn that finds no run reads the file (`loadShelf`) and goes on from the session its run cached with `--resume`, told the turn alone, as an idle-shelved one does today.

The matching key survives the restart: `turnKey` hashes the request's conversation, so the next turn computes the same key after the restart as before it.

Left out of the file: entries past what their run would have waited (`idleLongest` — the cache is gone either way), entries this magpie took (the magpie that handed over writes last, and a taken session must not be handed out again), and ones naming no session of a folder. A session whose file is gone anyway resumes as nothing, a transcript as before. The startup sweep spares shelved sessions by construction: an entry is only kept while its run would have waited, and a session file newer than that is never swept.

**Verification** (macOS 15, darwin/arm64, `-tags nogui`):

| Check | Result |
| --- | --- |
| Red before the fix | conversation shelved, gateway replaced, next turn: told the whole conversation as one transcript message (`conversation_history` + `current_turn`), no `--resume` of the run's session — the reported shape |
| `TestClaudeShelfWaitsOutTheRestart` | shelved by the idleMost overflow → restart → `--resume` of the run's own session, told the turn alone — green |
| `TestClaudeWaitingRunsShelveForTheRestart` | run waiting at quit → shelveIdle + abortAll → session file left → restart → `--resume` — green |
| `TestClaudeRestartDropsStaleShelfEntries` | entry past `idleLongest` → not resumed, told whole, as before — green |
| `TestClaudeSweepSparesShelvedSessions` | the sweep at the next start takes a session a long-gone gateway left beside it and leaves the shelved one — green |
| Ablation | without `loadShelf` the two restart tests fail at "did not resume its session after the restart"; without `shelveIdle` the waiting-run test fails the same way while the idleMost one passes (its session was shelved by the overflow, not by the quit); without the stale-entry drop (its expiry timer neutralized with it, else the timer's immediate fire races the lookup) the stale entry is resumed past what its run would have waited. Whole, all pass |
| -race | the named set, 8 tests — green, no race |
| Whole package | `internal/gateway` and `internal/cli`, `-tags nogui`, on `db0f2f20d` + this commit: gateway ok but for `TestClientPathCoversHandler` and `TestReadOnlyKeyEveryRoute` — red on the parent commit alone too, upstream's just-landed HTTPS route table, not ours; `internal/cli` ok |
| `git am` | applies clean on main `db0f2f20d` |

NOT-RUNNABLE here: a real subscription across a real restart with `cache_read`/`cache_write` measured — the report's usage.jsonl table is the live evidence; the fixture pins the same shape (resume of the run's own session vs a transcript's rewrite).

The suggested shape is followed with two simplifications: the shelf persists at each change rather than only at quit (a crash keeps the already-shelved sessions), and no session file is moved — Claude Code's own project folders keep them, where the sweep's own rule leaves them while an entry wants them.

Generated-by: GLM-5.3-Flash (ZCode)
