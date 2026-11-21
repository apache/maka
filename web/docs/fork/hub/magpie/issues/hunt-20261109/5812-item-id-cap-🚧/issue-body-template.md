@JaxWeng — thank you for the complete chain: the report named all three gaps, and each one checks out on `main` as of `be9dbce02`. The request died where no retry could save it, and every turn of the session after it died the same way.

**Root cause**, restated on today's `main` (your line numbers had drifted; the shapes are yours):

1. **`itemIDRefusal` matches the character refusal's tail alone** (`internal/gateway/codex_backend.go:3111`). Since dae104bfa it is a function — the tail within 1000 characters of the `Invalid 'input[n].id'` head — and the one tail it knows is "Expected an ID that contains letters, numbers, underscores, or dashes". OpenAI's length refusal words itself "string too long. Expected a string with maximum length 64, but got a string with length 428 instead." — no such tail, so the reactive ask-again (`internal/gateway/gateway.go:6759`) never fired, `itemIDsRefused` was never remembered, and on a relay whose host magpie can't tell checks ids, there was no proactive `plainItemIDs` to fall back on either. Your suggested regex had the right tail set; the landed form is a tail list beside it.
2. **A translated request never went out with plain ids** (`forwardTranslated`): your gap 2, and it is narrower than the built request only — `buildResponses` replays a seal carried in a call's id (the reasoning_carry of #4798) as it was minted, and Copilot mints ids of 420 characters and more, so the translation carried the refusal inside it from the first byte.

**The fix**, two pieces at the shared root (the id's passage to an upstream that checks them, not any one call site):

- `itemIDRefusalTails` is the tail list: the character refusal's tail, and `Expected a string with maximum length`, which is OpenAI's own for a string over its schema's bound — the `input[n].id` head holds it to item ids alone (another field's "string too long" carries its own head, `input[n].content` and friends, and matches nothing). This one list is what turns the relayed path's ask-again back on: asked once more with ids it takes, and so from then on — the echo_ts shape, now reaching the length wording too.
- `forwardTranslated` now sends Responses the way `passthrough` does: an upstream known to check ids (`validatesItemIDs`) is asked with plain ids from the first turn; one that refuses is asked again with them and remembered (`markUnfit` + rebuild, where the proactive check reads the refusal), exactly the relayed path's contract. Your suggested fix stopped at the proactive half; on a relay it would still have lost the first turn (and every one after, with nothing remembered) — the reactive half is what makes a relay heal. The weave is: a seal carried in a call's id is an upstream's to have minted, and the build never bound what it replayed.

**Sibling-face scan** of every point an item id or call id is made or passed, each left or changed with its reason:

- `codex_backend.go:215` (Codex's own requests to the ChatGPT backend) and `codex_relay.go:60` (a Codex client relayed): both already go `plainItemIDs(boundCallIDs(callItemIDs(body)))` unconditionally; #4525/#4527 live here. Left.
- `gateway.go:6283`, the relayed path's proactive `plainItemIDs`: the `validatesItemIDs(p) || !s.fits(...)` condition is unchanged. Widening `validatesItemIDs` to relays (host unknown) would rewrite bodies for upstreams that never check them — the shape-checking relay of #292 asks to be passed through as it came — and the reactive-then-remembered path is the architecture's own answer to an upstream it can't classify (echo_ts). Left; healed by the tail list instead.
- `gateway.go:6759`, the relayed path's reactive match: it reads `itemIDRefusal`, which the tail list widens — this is the one match face that changed.
- `gateway.go:7889` and `gateway.go:8061`, the translated path's proactive and reactive: new, the fix itself.
- `boundItemID` (`codex_backend.go:3171`): the collision-safe binding — the whole id's sha256 under the kind's prefix, the same id to the same shorter one every turn, no two ids onto one (the bare-digest 400 of #5266) — is exactly the ">64 needs to be collision-safe" half of this issue's trade, and it already stood. The translated path now reaches it; the function itself is untouched.
- `callItemIDs`/`boundCallIDs` (`codex_backend.go:3045, 3312`): the call_id is another field, the pair a call and its output find each other by; `plainItemIDs` leaves it as it was on purpose, and `boundCallIDs` already holds it to 64. Left.
- every `"call_" + newID()` mint (`chat.go`, `chat_call_ids.go`, `gemini.go`, `responses.go`, `textcalls_relay.go`, `reasoning_carry.go`): `newID()` is ~24 characters of `[0-9a-f]`, under the cap by far. Left.
- `idOptional`/`itemKindPrefix` (`codex_backend.go:3186+`): the three-way disposition of an overlong id (left out, bound, character-swapped) is #4525/#4527's settled shape and is what the translated path now goes through like any relayed one. Left.

**Failure-read semantics**: `itemIDRefusal` reads a response body, and a body that doesn't carry a known tail (truncated, reworded) reads as *no item id refusal* — the ask-again doesn't fire and the 400 goes to the client as it went before this patch; nothing reads a refusal into an absence. The translation's proactive check adds two scans over the built body (`"id"` present, then any item over the cap or off the alphabet) and sends a clean request byte for byte unchanged — the same price the relayed path has paid since #4525.

<details><summary>patch: gateway: an item id refused for its length is asked again, and translated requests go with plain ids — git am applies it as is; SHA-256 first 16: 52796c40e89d82b3</summary>

```text
{{PATCH_BODY}}
```

</details>

**Branch with the commit**: [`fix/5812-item-id-length-cap`](https://github.com/ggbdpq/magpie/tree/fix/5812-item-id-length-cap) (head `8b997f76c9e2ef9c7a0a7d0e3c34eddbbc7ce596`), rebased onto current `upstream/main` (`be9dbce02` — fetched again before delivery; dae104bfa, the `itemIDRefusal` rewrite this patch builds its tail list beside, was already in the base). On a fresh checkout `git am` applies clean.

| Check | Result |
| --- | --- |
| `TestItemIDRefusalLengthTooLong` (new) | red before the fix (the length wording read as no refusal), pass after; another field's "string too long" and a tail beyond the 1000 characters read as no refusal, as they should |
| `TestRelayRefusingOverlongItemIDsAskedAgain` (new) | red before (`turn 0: 400 … Invalid 'input[0].id': string too long. Expected a string with maximum length 64, but got a string with length 428 instead.` — the issue's own error, word for word), pass after: asked twice the first turn, once the second, the answer's id gone and its words kept |
| `TestChatCarriedSealedAskedWithPlainIDs` (new) | red before (400, the carried seal's 428-character id replayed by the build), pass after: the refusal read, the seal replayed with its id bound to 64, and the refusal remembered |
| `TestItemIDRefusalAsTheRegexp`, `TestRelayRefusingItemIDsAskedAgain`, `TestCopilotTakesAnotherVendorsItemIDs`, `TestCopilotTakesAnotherVendorsOverlongItemIDs`, `TestCodexOwnModelTakesAnotherVendorsItemIDs`, `TestMuseKeepsItsOwnItemIDs`, `TestPlainItemIDsBoundItemIDs`, `TestPlainItemIDsBindsOtherKinds`, `TestCopilotTakesItsOwnOpaqueCallID`, `TestCopilotTakesItsOwnOpaqueSearchCallID` | pass — the character refusal, the bindings and every deliberate keep keep their pinned behavior |
| `go test -tags nogui -count=1 ./...` (temp HOME, pinned Go caches) | 86 packages ok; the failures fail the same on the clean parent: TestMothX in internal/agent, TestProxyCheckSaysAProxyPassedBy in internal/gui (the 502 through this machine's 7897 proxy), TestHostToldTheGatewayAddress in internal/plugin — the standing reds; internal/gateway as a whole package hit its 10-minute package timeout under the full run's load and passes clean alone (below) |
| `go test -tags nogui -count=1 -timeout 30m ./internal/gateway/` (alone) | ok — the whole package, the three new tests in it |
| `gofmt -l` over the touched files | prints nothing |
| `go vet ./...`; `GOOS=linux go vet -tags nogui ./...`; `GOOS=windows go vet ./...` | clean |
| `go build`; `GOOS=linux go build -tags nogui ./...`; `GOOS=windows go build ./...` | clean (the macOS link prints its usual Xcode version warnings, exits 0) |
| Ablation 1 — the length tail taken out of `itemIDRefusalTails` (product file only, tests kept, parent = branch parent) | all three new tests red again (the wording reads as no refusal, both paths stop asking again); restored, green |
| Ablation 2 — the translated path's two blocks taken out (product file only, tests kept) | only `TestChatCarriedSealedAskedWithPlainIDs` red — the relayed test and the unit stay green on the tail list alone, which is what says the two halves are each carrying their own path; restored, green |

**Not verified**: a real Copilot-minted 420–444-character id against a real OpenAI relay — NOT-RUNNABLE here (no Copilot account on this machine); the mock upstream refuses with OpenAI's own error, word for word, and the reactive contract it exercises is the one echo_ts's relay has run in production since the character refusal landed. Your session of 40+ turns stays with you; the patch makes the first refusal the last.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

Generated-by: GLM-5.3-Flash (ZCode)
