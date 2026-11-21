The mechanism is read, the evidence is good, and this one is a policy call on the gateway's most sensitive knob — so here is the analysis, the trade, what exists today, and the two fix shapes I see, for whoever sets the default.

**The chain, as the code has it.** A transport error — the upstream took the whole request and closed with no HTTP reply (`Post "...": EOF`) — fails the try as a 502 whose body is magpie's own words, not a vendor's. `busy()` (patience.go:70) reads that as busy: the status is in `busyStatus` (502), `failure() == failOther`, and none of the exclusions apply (the body carries no `didNotStream`, no `cutVoidWords`, no queue answer, no protection words — it carries the error text itself). `noteBusy` puts the member on the replan list, and after the same-one ladder `passing()` runs (your trace's `again=1000 → 16000`), patience asks the members again in rounds (2s, 4s … 30s, ≤12 rounds, each member's own budget) — every round re-sending the whole body, which is your `up_bytes: 611226` = 7 × 87318. The report's window is exactly the shape the exclusion precedents answer: `didNotStream` ("it fails the same every time it is asked"), the Qoder queue answer (#5346: 656 tries, 20 GB a day), the token walls (plugins#512) — each added when a real case showed a failure whose every ask reads the same.

**Why I did not patch it.** The exclusion you propose — a 502 that carries no vendor response at all — is honest as a class, and the fix shape exists (`didNotStream`'s marker, applied in `busy` and `passing`). What stays my hand is the other half of the class: an upstream that is *restarting* (a relay bouncing for a few seconds, a LB draining) fails as the same no-response 502, and riding that out is what patience was built for (#1418: Codex's turn ended on `server_is_overloaded`, to be told "continue" by hand). From `(status, body)` the two are indistinguishable — the discriminating fact in your window, that the far side cut *after* the whole body was uploaded, on its own 5-second timer, is not a field `busy()` receives. Making it visible means plumbing bytes-written (or upload-completed) into the try's failure record — a wider change than a marker word, through the path every provider's transient behavior flows through. That trade, and the default for every upstream, is the maintainer's to set.

**What the operator has today.** Each provider and group carries its own patience: `PatienceOff` (-1) leaves a member out of the replan rounds (`waitsOf`, patience.go:131 — `patience < 0 → 0`), so `magpie provider set <id> patience=off` (or the same on the group) stops the 7-try loop for that upstream now, at the cost of also not riding out its genuine blips. For an upstream whose failures look like your 37-minute window, that is the knob; the issue's ask is really that the *default* read the failure's shape.

**The two shapes a default fix could take**, for the record:

1. the marker-word shape: a no-response transport failure carries its own marker (as `didNotStream` does), excluded from `busy` and `passing` — cheap, honest about the class, and it also stops riding out restarts;
2. the precise shape: the try records whether the request was fully written when the transport died, and only a fully-uploaded-then-cut failure is excluded — matches your window exactly (the far side read everything, then cut), leaves the at-once blips inside patience, and costs the plumbing named above.

A middle line — one replan round for no-response failures instead of none — exists too, if the worry is only the *multiplication* and not the waiting itself.

**Verification.**

| Check | Result |
| --- | --- |
| `busy()` read (patience.go:70-77) | 502 + no vendor words → busy |
| `passing()` read (fallback.go:2260-2293) | same-one ladder (`again < lastRetries`) runs on the same 502 |
| Patience entry (gateway.go:5029) | requires `busy(...)` true (or `lastSpent`) — the exclusion would need both sites |
| `PatienceOff` escape hatch (patience.go:131, provider/group.go:146) | present today: `patience<0 → 0`, member left out of replan |
| Exclusion precedents | `didNotStream` (patience.go:14), `queued` #5346, `wallCodes` plugins#512 — each evidence-first |

**Source**: read at `upstream/main` `036b69154`, clean worktree; the trace and byte counts are the issue's own.
**Siblings**: `codex_backend.go:1667` classifies by the same `busy` — a default-level change lands there too; `affinity.go:1541` reads `busy` for the seal-keeping decision — it would see fewer busy failures of this class; both want the maintainer's eye if the exclusion is taken.
**When the read fails**: a connection the vendor refuses outright (`couldn't connect`) already names itself and rests the account; the no-response-after-upload case is the one that today reads as a moment's trouble.
**Not verified**: a replay of the 37-minute window (no such upstream here); the restart-blip counter-case is argued from #1418's design intent, not measured — the reporter's full trace JSON would let the maintainer weigh both sides.
**Attribution**: AI-written; I've read the paths cited and can answer questions on them myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.
