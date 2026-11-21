Taken — here is a patch that fails a 200 whose reply counted no token, instead of handing its body to the agent as the answer.

## Summary

- The reply said so itself. Its `usage` member was on the wire, and every count it named was zero: nothing was generated, so whatever the body carries beside the counts — today a billing notice, tomorrow a quota page — is not the completion the agent asked for. What magpie kept of a usage was the counts alone (`cUsage.usage()` returns a value), so reported-and-zero collapsed into never-reported, and every decision that could have failed the try keyed on something else: the #733 arm on an error member, the empty-reply checks on nothing said, #2086 and #2471 on their own protocols. A well-formed `choices` body that says something walked past them all — booked `done: true`, `status: 200`, no fail, the conversation's stick dropped on the seat, turn after turn the same notice (the reporter's three attempts, three real upstream calls, byte-identical).
- The member's own saying is kept now, the way the cache counts' is (`cacheCreationReported`, ir.go): `usageReported` is wire evidence, not a counter, carried from the Chat decoder (which dropped an all-zero usage event) and the relay sniffer, through `Usage.add` and `plus`. Reported and every count zero fails the try as its words would have with their own status (errorReply's reading) — a billing notice as the 402 it owes, the seat resting as out of credit (creditRest) — at the seams where a reply can still be judged:
  - held whole (settle): the next member answers in the turn; the agent never sees the notice;
  - a translation read whole (translate's tail): the same;
  - a streamed reply, already passed (the walk's accounting): what the agent has stays as it is — a stream's text can't be taken back — but the failure is booked, the stick dropped, and the seat rested, so the session's next turn is answered elsewhere instead of the same notice again.
- The class the report asked to guard against stays exempt: a reply that never reports a usage — one that ignores `stream_options`' `include_usage` — is taken as it came, the fields said are what is read (emptyCompleted), so the rule needs no per-provider list. `TestUsageNeverReportedStaysAnAnswer` pins it, relayed and translated.
- A counted-nothing Chat reply whose words are innocent still fails, as #2086 counts a reply that counted nothing no reply at all; it fails as a 502 for the next member, and rests as any 502 does. Anthropic, Responses and Gemini keep their own precedents (#2086, #2471, #667); this patch is the Chat wire only. The seam the settle check lands on is the one this issue's reproduction probed (aron-intframe); the streamed half lands in the walk's accounting, as that comment anticipated.

## Verification

| Check | Result |
| --- | --- |
| new `TestCountedNothingFailsOver` (relayed: notice as a completion; next member answers, try failed as credit) | RED before, GREEN after |
| new `TestCountedNothingTranslatedFailsOver` (translated: notice never reaches the agent) | RED before, GREEN after |
| new `TestCountedNothingStreamDropsTheStick` (streamed: first turn leaks, try failed, seat rested, next turn of the session answered by the other member) | RED before, GREEN after |
| new `TestCountedNothingTranslatedStreamDropsTheStick` | RED before, GREEN after |
| new `TestUsageNeverReportedStaysAnAnswer` (the exempt class, relayed and translated) | green before and after |
| ablation (product files back at d8b3749ef, new tests kept) | red again (all four counted-nothing tests) |
| `go test -tags nogui -timeout 25m ./internal/gateway/...` | pending |
| `go test -tags nogui -race -run 'TestCountedNothing|TestUsageNeverReported'` | ok |
| `gofmt` / `go vet` / `go build ./...` | clean |

## AI use

Patch written by GLM-5.3-Flash (ZCode); author ggbdpq.

<details>
<summary>Patch (git am format) — SHA-256 (first 16): PENDING</summary>

````
PENDING
````

</details>

Branch: https://github.com/ggbdpq/magpie/tree/fix/3967-billing-200 (head PENDING)
