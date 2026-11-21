**Verified, and stepped aside** — the report's three claims hold, reproduced independently here; the fix belongs to whoever carries it (the report says a patch can follow, and #5910's review already treats this ask as its declared leftover), so this is the evidence, not a competing patch.

## What I reproduced (upstream/main `db0f2f20d`, this machine, no fix applied)

Two throwaway tests of my own, in the shape the report sketches, against the existing `intented` helper (group `group/r`, rule `b/big` on intent "writing or fixing tests", classifier `c/cls`):

```
--- FAIL: TestClassifierAskRecordedUnderTheTurnsKey
    the classifier's ask is recorded under caller key "", want the turn's key "9b13d05f36010956438649ef"
--- FAIL: TestKeyLimitHoldsTheClassifiersAsk
    the classifier was asked 1 times for a key with nothing left: {"id":"x",..."content":"from kb"...}
```

- **Not held**: a key limited to 1000 tokens a day with 999 used (its turn's own reservation counted) still has the classifier asked — the turn answers from `b`, the rule picked, exactly as the report's first test says.
- **Not counted**: the classifier's one usage row carries `CallerKeyID: ""` while the turn's own row carries the key — the report's second test, same shape.
- **Not narrowed** (code reading, as the report also says): `askChat` builds its request on `context.Background()` (`internal/gateway/classify.go`, ~line 609) and serves it with no identity on the context, so nothing in `serve` can narrow the accounts the ask may use — the classifier provider's whole pool is in play.

## Where the fix goes, agreeing with the report

Carrying the turn's caller into `askChat`'s context makes all three collapse into one: with an identity on the context, `serve` records the row under the key, narrows its accounts to the key's, and `reserveSide` — the seam #5910 just added for asks that already carry their caller — reserves the ask against the same key with no further machinery. A refusal is then the key's own and the turn proceeds as if the classifier couldn't say, which is the right shape. This is indeed a larger change than #5910's: `classify`/`askChat`'s callers (routing, effort, the desktop probe) all have to thread the turn's context through, where search and vision already had it.

The Claude Code run's web search (`mcpCall` let in by its token, no gateway key) is the same class — code-read here too, not tested, same as the report.

## Verification

| Check | Result |
| --- | --- |
| Not held to the limit | reproduced: capped key (999/1000), classifier asked once, turn 200 |
| Not counted under the key | reproduced: classifier row `CallerKeyID ""`, turn's row has the key |
| Not narrowed to the key's accounts | code reading only (`askChat` on `context.Background()`, serve sees no identity) |
| Claude Code run's search, same class | code reading only, as in the report |
| Fix attempted here | none — the report says a patch can follow; making one would race it |

**Source**: internal/gateway/classify.go (`askChat`, `classify`), internal/gateway/gateway.go (the `withCaller(keyLimited(…))` chain), internal/gateway/key_limit.go (`reserveSide` from #5910's reviewed branch), internal/usage (row recording) at upstream/main `db0f2f20d4dda003c153922a94932ab8d212d96f`.
**Not verified**: which accounts a real classifier provider would draw from for a keyed turn (needs a real group with keyed accounts); a capped key against a real Claude Code run's search.
**Attribution**: AI-written verification; the problem and the fix's shape are the reporter's — I can answer questions on what I reproduced.
