**What's wrong**

The bridge was never misjudging the images — the router was. `turnIn` (the turn counter behind routing affinity and the groups' per-turn rules) counts a turn begun by any user message that carries an image or file. pi sends a tool result as a text-only `role:tool` message ("(see attached image)") and then the picture in a separate user message, `Attached image(s) from tool result:`. The bridge reads that message as the result's, and hands the picture to the waiting run with the results (match, `TestSubscriptionToolResultImages`) — but `turnIn` read it as the user's next ask: `turn++`, `within = false`, the turn over.

With the turn judged over, affinity stopped keeping the conversation to the account that answered it (`a.Why = "turn"` keeps it; without `within`, the router re-decides by rotation, spent share, cold cache, near caps — whatever the setup is). When the re-decision landed on another account, the bridge let the waiting run go — continuing another account's Claude Code would spend its quota and report its limits — and a new one was told the whole conversation: your `tool results account changed`, and the ~17,571-token fixed prefix re-read with everything after it rewritten to the cache on each of the 7 image reads. The same results as text carry no extra user message, `within` stays true, the account is kept, and nothing restarts — which is why only image reads broke.

**Root cause**

`turnIn` treated the image message as a turn of the user's. It is the result's, as the bridge's own parsing already says (match: an image sent beside the results "goes with the result before it"). One client shape, two judges disagreeing; the router's disagreement is the one that restarts runs.

**The fix**

- `turnIn`: a user message with an image beside the turn's results (no assistant between) carries the turn on, as the bridge tells it. The user's own image with no result of the turn's pending still begins a turn, as before (`TestTurnInCountsTheUsersOwnImage`). A user's text beside the results still counts as it did — unchanged.
- Ask 2: when a changed owner still lets a run go, the log names both sides instead of a bare "account changed": `tool results account changed: the run was on claude (a@example.com), this request goes to claude (b@example.com)` — own sign-ins and plan-named (unnamed) accounts marked, so the next report can see which kind of switch fired without guessing at hashes.

**Verification**

| Check | Result |
| --- | --- |
| `TestTurnInCarriesAnImageBesideItsToolResult` (new: pi's Chat shape, structured, and the user's own image beside a result) | red before the fix (`turn 2 within false, want 1 true`), green after |
| `TestTurnInCountsTheUsersOwnImage`, `TestToolResultsNameTheChangedOwner` (new) | green |
| Existing turn/affinity/bridge family: `TestTurnInSkipsWhatTheAgentPutIn`, `TestUserSaysPastAReminderWithASource`, `TestReadersOfAHeldBodyParseItOnce`, `TestHeldFactsGoWithTheirBody`, `TestChatAndMessagesFacts*`, `TestSubscriptionToolResultImages`, `TestClaudeToolResultsKeepTheSelectedAccount`, `TestClaudeRunTakesOnlyItsOwnSignInsName`, the Route/Affinity family | all green on upstream/main `e3ab7f3bf` + this commit |
| whole `internal/gateway` package, `-tags nogui` | ok |
| Ablation | the `said && results` case removed → `TestTurnInCarriesAnImageBesideItsToolResult` red at `turn 2 within false` (the reporter's shape), restored → green |

Sibling scan (readers of the turn/within facts, all of them): `affine` (affinity.go) — `a.Within` guards the mid-turn migrations and keeps the account; exactly the path that fired here. `ruleFor` (rules.go:195) — within the turn the turn's rule holds; an image result now holds it like a text result does, instead of re-asking the rules mid-tool-loop. `factsOf`/`parse_memo.go` — caches `turnIn`'s answer, no logic of its own. No other readers (`a.Within` is serialized nowhere: sticks persist `turn`, not `within`).

NOT-RUNNABLE here: the reporter's live session (Windows, pi in OpenBot, two-plus accounts behind the model — the routing setup isn't in the issue). The restart itself is reproduced at the unit level: before the fix the request reads as a new turn (`turn 2 within false`), which is the input `affine` used to re-decide the account and the bridge then to log `account changed`. If the restarts continue on your setup after this, the new log line will say exactly which two accounts the switch ran between — that would point at the remaining router-side pick, and I'd want the pair it names.

Patch (`git am` ready; applies cleanly on `e3ab7f3bf`):

- `git am < https://github.com/ggbdpq/magpie/commit/fb6554d67d06f80d726f45582c8bb062912b7679.patch`
- zero-commit file sha256[:16]: `5974476d46768489` · branch: https://github.com/ggbdpq/magpie/tree/fix/5767-claude-image-toolresult

Generated-by: GLM-5.3-Flash (ZCode)
