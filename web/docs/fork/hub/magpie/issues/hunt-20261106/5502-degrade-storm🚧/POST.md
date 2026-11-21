I took this (take above) and read the walk end to end before writing any fix. The behavior you see is real, and I can point at the exact machinery; but the fix turns on one fact the issue doesn't have — the exact 400 body — and on a call that splits two open asks. So this is the analysis and the three facts I'd need, not a patch: a matcher written against a guessed message is how a fix for this walks into eating unrelated errors.

**Why one 400 asks every claude account (read on upstream/main `416305451`)**

A failed turn on a claude account becomes the reply stream's `error` event, carrying the HTTP status Claude Code got and the CLI's own words: `claude_subscription.go:2479` emits `Event{Kind: KError, Text: <the CLI's text>, Status: envelope.APIErrorStatus, Code: <Claude Code's kind>}`, and `anthropic.go:1670` writes it as the stream's error event, keeping the code beside the message. The route's hold reads that event as the try's failure (`fallback.go:2276`), and `holdWriter.failed` (`fallback.go:2594`) then asks `retryable(400, body)`. For a 400, retryable says yes when the words match `quotaWords` (`fallback.go:1235` — `usage.?limit`, `hit your .*limit`, `limit.?reached`, …), and the walk's plain failed branch (`gateway.go:3720`) rests the account and asks the next candidate — until every account of the claude route was asked once. That is the "把所有 claude 路由里的号都请求一遍": each account's own answer walks the route once more.

Claude Code's own limit answers match those words today: `You've hit your 5-hour limit` (the text in #4443's timeline), `You've hit your Opus limit`, `You've hit your weekly limit` (the error reference's wording) all match `hit your .*limit`. So if the 降级警告 is that limit text, the walk you saw is the routing group doing what routing groups are for: an account out of its window, the next asked — and the one that answered rests until its own reset stamp, which magpie already reads (`routing.go:244`).

**The decision a fix here needs**

The ask reverses that design for one kind of answer: recognize the claude degradation warning, don't forward, let the agent have the current account's answer at once ("就在当前号完成"). Two very different 400s both match `quotaWords` today, and they want opposite policies:

1. **The account's own window used up** — walking is intended; #4443 asks for *more* switching on exactly these texts.
2. **The account degraded or flagged by risk control** — the answer is about the account's standing, not its allowance; the same conversation replayed across every account of the route, from one address, one after another, is the batch-ban pattern, and "非常危险" names exactly that. Walking cannot help, and it puts every other account through the same review.

Which of these your 400 is decides everything, and the matcher has to be the warning's own words, not a guess — the last fix in this family that matched invented words was rewritten at land (#5346: the plugin's own words, not `\bqueue|排队` in any provider's 5xx).

**The shape I'd build once the body is known** (the pattern is already in the tree): `claudeNoRoom` (`gateway.go:3555`, `claude_room.go:57`) recognizes the bridge's own answer and — no mate asked, only a candidate of another provider asked once, nobody rests, and no re-ask after a pause. A claude degradation warning would take the same branch: the agent is told the current account's answer at once, and nothing else in the route is sent it.

**What I'd need to write it**:

1. the exact 400 body — one routing-log row for a request that walked (Recent calls keeps the try's error with the upstream words whole);
2. your magpie version, and whether the claude route's accounts are subscription accounts (driven through Claude Code) or API keys / relays to api.anthropic.com;
3. whether the warning sticks — once one account has shown it, does every following request show it again, or was it only the one request.

I'll hand the lane back with this; the slot shouldn't sit on me while the one fact that decides the matcher is on the reporter's side.

---
**Source**: reported in #5502; every check above read on upstream/main `416305451`, none run against a real claude account.

**Not verified**: the degradation warning's exact text (absent from the issue, from Claude Code's error reference, and from magpie's tests and history); whether the accounts are subscription or key.

**AI**: written with GLM-5.3-Flash (ZCode); I read the walk end to end and can answer questions on it.
