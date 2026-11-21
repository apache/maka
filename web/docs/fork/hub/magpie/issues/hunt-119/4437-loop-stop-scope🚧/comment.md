I traced the code path behind this notice. Short version: the stop is intentional, it is not a dead end (the conversation resumes with one word from you), and there is a setting that turns it off. But the `write_stdin` case is a fair example of where the check's one progress signal — the tool result changing — says "stuck" when a human might say "waiting", so I'm leaving that trade-off here for @yetone.

**What the check compares**

`internal/gateway/tool_loop.go` (added in de281760e, after another user's model read the same code 308 times in half an hour, 537 credits for nothing): before a request is relayed, magpie hashes the newest turns of the conversation — each turn as tool name + arguments + the result the agent sent back, ignoring call ids and the run noise Codex writes into every result (wall time, chunk id, duration). When the last 8 turns all hash the same, the next request is answered by magpie itself and never reaches the model.

Your trigger fits exactly that: `write_stdin` with `{"chars":"","yield_time_ms":1000}` is the agent waiting about a second for more output from a process it started, and it did that 8 times in a row with a result that stayed the same modulo that noise. The check has no notion of tool names or wait-shaped calls — its only progress signal is the result moving. A poll whose answer changes is explicitly let through: `TestToolLoopLetsProgressBy` runs 200 rounds of a poll with a changing answer and asserts it is never stopped. A wait whose result does not change for 8 rounds is treated as no progress, because from the request alone the two look identical: same call, same result — whether the process is a long build that will eventually print, or a session stuck on output that never comes.

**Ways past it right now**

- Settings › Models › Replies › Stop looping replies → off, and the check never fires (`TestToolLoopShortOrOffGoesOn`).
- Or tell the agent to continue: the notice is itself a turn with no tool call, which resets the count — one word and the agent can wait another 8 seconds (also covered by a test).

**The trade-off I'd leave to the maintainer**

Whitelisting wait-shaped calls (say, `write_stdin` with empty `chars`) would also exempt the exact failure this check exists for: a model parked on a process that will never produce output, spending quota on every further turn. If the 8-second cut is real friction in Codex TUI sessions, a higher threshold for wait-shaped calls, or wording the notice to say "say continue to resume waiting", may be worth considering — happy to draft either as a patch if @yetone wants one.

Attribution: AI-written analysis (GLM-5.3-Flash via ZCode); every claim above checked against upstream/main at a3768cdd1. Posted by ggbdpq.
