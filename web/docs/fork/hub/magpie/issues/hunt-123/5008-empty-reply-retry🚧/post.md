I took this and read the retry tree at current main (`7785c4278`). The report's mechanism is confirmed, and one part of the code-level reading has moved since 0.1.1620 — the retry counts are the maintainer's calibration in three layers, so I'm not attaching a patch; two options below, both small. Credit @l1shen for the analysis — the `Output: u.Candidates + u.Thoughts` reading is exactly how Code Assist usage is summed (`codeassist.go`), and 0 output tokens does mean not one thought token.

**Where the same-account asks happen, at current main**

- **In place** (`continuation.go`, the empty-reply re-ask): a Gemini/CodeAssist reply that said nothing and didn't end at its length or a filter (`emptyFails`, #667) is asked again on the same account before it fails. How often is `emptyRetries`: **1** while the stream is still held and the request could still ask again or fall to another account (`mayAskAgain`/in a group try), **3** when only reasoning went through (`thoughtOnly` — added 2026-10-20, `592899467`, after your build), else **2** (`streamRetries`, the cut reply's budget). Each ask here is a full upstream call — in your record a ~58k-token prefill at ~24s.
- **Request level** (`gateway.go`): an empty-reply failure already does what your first choice asks — the account is **not rested** (#1221: "a failure of the model or request, not the account"), the next candidate is asked (`failOther`), and same-model mates, likely to end empty too, are asked last (`matesLast`). So "换下一个成员" is already the serve loop's behavior.
- `lastRetries = 2` is the hold's ask-again budget and the last account's request-level rounds ("asked again after a moment, as for any 503"), not a per-empty counter — your ~6 calls are the in-place budget on each account plus the last account's rounds, not one layer's 1+2.

**The distinguishing signal you want exists.** Per-try usage lands in the re-ask's decision (`this.add(ev.Usage)`): a completely-nothing try is `this.Output == 0` with nothing gone through (not `thoughtOnly`); a reasoning-only one counts `Thoughts` in `Output` or rode `thoughtOnly`. So the two kinds of empty are statically apart today.

**Options**

| Option | Change | Consequence |
| --- | --- | --- |
| A — your first choice, as a new rung of the existing gradient | in `emptyRetries`: after the `thoughtOnly` branch, `this.Output == 0` → 1 in-place re-ask instead of 2 | ~4 lines; compatible with the pinned tests — `TestGeminiEmptyReplyIsAnError`'s "asked again at least once" floor (calls ≥ 2) holds, `TestGeminiEmptyRepliesAskedAgain` rides `thoughtOnly` and is untouched, #1221's failover empty carries `thoughtsTokenCount: 5` (Output 5 > 0) so it's untouched. Saves one full prefill per account in the not-held shape. |
| B — fail a nothing-at-all empty in place at once | 0 in-place re-asks for `Output == 0` | fastest for your case, but it breaks #667's own floor ("asked again, not again" in `TestGeminiEmptyReplyIsAnError`) — a reversal of that calibration, not a refinement. |

Either way, the last account's request-level rounds are generic failure machinery (any 503 gets them); touching them for empties alone is a bigger policy change than A.

**One thing that would settle A-vs-B:** "每次都一样" rests on one request's tries. A second record (or the `app.log` of another occurrence) showing the 0-token STOP repeating across asks would be the evidence for B; without it, A is the conservative rung.

**Not verified:** no Antigravity account here — the per-shape call accounting is reconstructed from the code at `7785c4278`, not reproduced end-to-end; your build (0.1.1620) predates the thought-only rung, which is why your constants check holds while the tree has since grown a branch your arithmetic never saw.

AI use: analysis written with GLM-5.3-Flash (ZCode) from a code read of the repo; no requests were sent to any upstream.
