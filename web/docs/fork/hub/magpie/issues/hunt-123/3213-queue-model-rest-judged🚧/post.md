The gap is real on current main, and one design decision needs the maintainer before a patch lands — so this is a judgment, not a patch.

The residual gap
---

Current main (`759b4d1d7`) still has no reading for a 5xx that says the *model's* queue took the request ("Qoder queued the request for <model> (this plan's queue: p3); try again in 30s"): it is not in `quotaCodes`, not 429, not `vendorOverloaded` — so it falls to `failOther` and `restAfterMarked`'s default branch rests the whole account (`restKey`), exactly as the report says. A sibling model the same account still serves is refused without being asked, and a two-account group fails over between accounts, paying a whole-account rest each time.

What changed under it since the report
---

Main has since grown a neighboring mechanism in the same branch: `vendorOverloaded` (a 529, or a 5xx whose words say "overloaded") rests nobody at the account — `!unserved && c.model != ""` reads it as the vendor's moment, not the account's fault. The Qoder wording does not match it ("queued", not "overloaded"), so the shape now has two neighbors:

| word family | branch | what rests |
| --- | --- | --- |
| "overloaded" / 529 | `vendorOverloaded` | nobody (any account would have met it alike) |
| "queued the request for <model>" | nothing — falls to default | the whole account (the report's bug) |
| per-model quota/credit/rate | `modelCooledDown` (#3039) | that model alone, its own ladder |

Two ways to close it, for the maintainer's call:

- **A (the branch's way):** a `queuedWords` reading — a 5xx saying the request was queued *for the model it names* is that model's own congestion: rest that model alone (`restID`, its own backoff), the account's other models still served. @skygunner's branch `fix/queue-model-rest` (`50eac57f`, rebased onto `be002aca`) implements exactly this, with `TestQueuedModelRestsAlone` (red before, green after) and a wording-based match, so any vendor answering its model's queue with a 5xx benefits. Its `restAfterMarked` has since moved and grown (`zcodeTrialBlocked`, `vendorOverloaded`, slow-start rests), so the branch needs one more rebase; the hunks sit beside the new `overloaded` line and no longer apply as is.
- **B (the narrower reading):** "queued the request for" is the vendor saying it *did not start the turn* — closer to `vendorOverloaded`'s "nobody rests, ask again" than to a model-scoped rest. The report's own "try again in 30s" then argues only for honoring the named time (the `resetsInWords` family), not a backoff ladder.

A stands closer to the report's ask (siblings keep serving); B is the smaller semantic step from what main already does for overloads. The design call — model-scoped rest vs. nobody-rests — belongs to the maintainer.

Not verified: a real Qoder upstream (the refusal bytes are from the report); the branch's own tests were not re-run here since its base has drifted.

AI use: analysis performed with AI assistance; all code reads above were run locally at `759b4d1d7`.

Thanks @liubai0106 for the report and @skygunner for the fix branch and the rebase.
