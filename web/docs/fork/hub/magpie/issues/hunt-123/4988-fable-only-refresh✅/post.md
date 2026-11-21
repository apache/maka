I took this. Your forensic chain is complete and every step checks out against current main (`7785c4278`) — I can name the exact line where your card went 100%, and one artifact from you decides the fix. Credit @XcodeFish for the two-path observation; that's what splits this open.

**The mechanism, confirmed**

- The two readers are different paths, as you suspected. `magpie quota --json` reads the live cache — the windows Claude Code told **as it answered** (`rate_limit_event` → `NoteClaudeLimits`, which merges by name and keeps the others). `quota refresh` runs Claude Code's `/usage` (`readSavedClaudeUsage` → `parseClaudeUsage`) and **replaces the whole entry** on success: `c.m[key] = claudeUsageEntry{… ws: ws, whole: true}` (`subscription_usage.go`) — every window the parse found becomes the account's only truth, and the snapshot you read follows it.
- The parse is line-based: `^Current (session|week(?: \(([^)]+)\))?):\s*([0-9.]+)% used(?:\s*·\s*resets (.+))?$` (`claude_usage_cli.go`). "Current week (Fable): 0% used" matches and becomes `7 days · Fable`. Your session and week lines did **not** match — the parse returned `[Fable]` alone, the replace wiped 5 hours / 7 days, and 0% rendered as 100% / 还没用过. The quota-history gap and the warm-up that never converges both fall out of the same poisoned reading (the warmer judges the 7-day window idle at 0%).
- Why the two main lines missed: the regex is anchored — `% used` then optionally `· resets …`, nothing else. A phrasing drift in the CLI's panel ("until" instead of "resets", a different label for a team plan, a new first line) fails both main lines while the Fable line still matches.

**The one thing that decides the fix**

Paste the raw text of `claude -p /usage` for that account (run it in that account's config dir, or `magpie quota refresh claude` while watching; percentages and dates only — nothing secret in there). Three outcomes, three fixes:

| What the lines look like | Fix |
| --- | --- |
| Main lines present in a new phrasing | widen the matcher to the new phrasing (and keep the old) — the reporter-visible half |
| Main lines absent from the panel entirely (Fable alone is all the panel says) | the parse is faithful and the bug is the wholesale replace: a read that found only model-scoped windows must not claim `whole` over an entry that had main windows — keep them until a read that actually speaks of them |
| Main lines present in the exact old phrasing | then the parse should have matched — that would be my error to chase, with your text as the fixture |

Either of the first two also un-poisons the warm-up, since it reads the same cache.

**Not verified:** no team-plan Claude account here, so I could not run `/usage` on your tier to see the panel myself; everything above is your artifacts plus the code at `7785c4278` (`claude_usage_cli.go`, `subscription_usage.go`), and the phrasing-drift candidates are inference, not observation.

AI use: analysis written with GLM-5.3-Flash (ZCode) from a code read of the repo; no requests were sent to any upstream.
