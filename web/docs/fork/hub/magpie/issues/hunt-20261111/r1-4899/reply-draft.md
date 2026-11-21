Each point of the review, and what the third form does about it:

- **metadata.user_id** — the body's metadata is untouched now: `buildChat` renders none and a Responses client's metadata is not read, so Claude Code's `user_id` (the account uuid and session) has no ride to any Chat provider, and none is sent again after a refusal either (that whole refusal-retry shape is gone with the carrying).
- **`?beta=true`** — the query merge is gone entirely: a translated request goes by the path `upstreamPath` names, byte for byte as main, and nothing of the caller's URL rides it.
- **`X-Cid` to subscription vendors** — the header no longer goes on `forwardOnce`'s shared path, where every ask got it: it is set only for a translated ask, and only when the provider is not a signed-in account's (`p.Account == nil` is part of the only place the mark is made). A relayed request carries none even when the provider is opted in, so the vendor a caller reaches as itself — most of all a subscription's — is never handed it.
- **the query filter's list of key names** — gone with the merge; nothing filters, nothing merges.
- **narrow opt-in** — carrying is now one field the user turns on for one provider, `carry-cid=yes` (provider.CarryCid, off by default). Off, the default, the request is byte for byte what main sends today: no metadata, no query, no header. On, only the header rides, only on the translated route, and only if the caller sent one — none is invented. What still needs your call, and why the shape is where it is:
  1. the field's name (`carry-cid`) and the header's (`X-Cid`, the report's own);
  2. whether the header alone is worth carrying at all, given the other two carriers stay dead — we propose leaving the body's metadata and the query dead until you say otherwise, since no filter or mapping of theirs can be made safe against the names magpie doesn't know;
  3. whether a relayed provider should be able to opt in the same way (this patch says no: the report's loss is the translated route's, and the relay's vendor sees the caller's traffic as itself).

The caller's own header for the provider still has the last word: the user's `X-Cid` in SentHeaders replaces it in the signing, as any user header does.

## Verification

| Check | Result |
|---|---|
| `go test -tags nogui -count=1 -run 'TestTranslatedRequestCarriesOnlyTheOptedInCidHeader\|TestTranslatedRequestCarriesNothingByDefault\|TestRelayedRequestCarriesNoCallerCidEvenWhenOptedIn\|TestOptedInProviderInventsNoCidHeader' ./internal/gateway` | ok (4 tests, also at `-race`) |
| RED, clean main `da169135a` | `p.CarryCid undefined (type provider.Provider has no field or method CarryCid)` — there is no way to opt in |
| RED, field+CLI only (gateway not reading) | `the opted-in provider's upstream got X-Cid "", want the caller's` (T1); T2/T3/T4 green there — the zero-change faces hold before the fix too |
| Ablation: gateway.go reverted to the parent, field/CLI/tests kept | T1 red again with the same line; green with the commit restored |
| `go test -tags nogui -count=1 -timeout 25m -v ./internal/gateway` | 4085 pass, 1 red: TestKeyLimitReservationsStayInTheirWindow/total/tokens — red on the parent `da169135a` alone too (this machine), not this change; an earlier full run hit the default 10-minute suite timeout while a severed-passthrough test waited on IO, and that test passes alone in ~1s on both this branch and the parent |
| `go test -tags nogui -count=1 ./internal/provider` | ok |
| `go test -tags nogui -count=1 ./internal/cli` | 4 red: TestHealthcheckFindsTheRunningGatewayWithoutMagpieAddr, TestUpdateRestartsTheGatewayItFindsWithoutMagpieAddr, TestEveryRouteHasACommandOrIsNamed, TestUpdateFindsAMagpieThatWroteNoRecord — red on the parent `da169135a` too (this machine's own gateway on :3425 answers the find-tests; the route test wants a command for `/api/plugin-pages/arrange`), not this change |
| `go test -tags nogui -count=1 ./internal/gui` | 2 red, TestProxyCheckSaysAProxyPassedBy and TestSessionReadsRoutes — both known reds on main |
| `gofmt -l` (5 touched files), `go vet -tags nogui ./internal/gateway ./internal/provider ./internal/cli ./internal/gui` | clean |
| `go build -tags nogui` darwin / GOOS=linux / GOOS=windows | ok |

**Source**: the report's three carriers at a translated provider (url= only); the review's four named harms and the opt-in call.

**Red without the fix** (parent `da169135a`): the caller's `X-Cid` never reaches a translated provider's upstream; with the field and the CLI word alone (no reader) the same request still shows `X-Cid ""` upstream — the config is silently ignored, which is what the ablation re-reds.

**Siblings, changed and not**: the GUI's provider save keeps fields its editor doesn't show (`in.X = old.X` for what the CLI or TUI set) — CarryCid added to that keep-list, or one save in the editor would strip the opt-in. Not changed: `forwardOnce`'s per-client header copies (Claude Code's relay, Codex's, bili's, OpenCode's, Cline's, Kilo's — each an established shape contract; X-Cid is in none of them and they are byte-for-byte as they were); `passthrough` (relayed asks carry none, test-locked); `countOn`'s count_tokens; the Bedrock branch that already strips `metadata` (#176, the existing per-endpoint care this shape follows); the IR's reading of an Anthropic client's metadata (inbound parsing; its rendering stays Anthropic-endpoints only, #359); a Responses client's `client_metadata`; `session_parent`'s `x-codex-turn-metadata` (internal bookkeeping); `AddCopy`'s flag propagation and `accountSettings`' inheritance (an opt-in is one provider's word, and the `p.Account == nil` gate makes inheritance moot); `normalize` and storage (whole-struct, the field rides).

**When the read fails**: a caller that sent no `X-Cid` gets none invented (test); an unmarked provider behaves byte for byte as main (test); magpie's own probes, drawings and searches pass empty headers, so they never carry one; a request whose context holds no mark — relayed, counted, a subscription's — builds none in.

**Not verified**: no live vendor behind the stub — whether a real Chat endpoint accepts or ignores an `X-Cid` header is unexercised, and the opt-in is the user's word for it; no signed-in account in the test rig, so the `p.Account == nil` gate is code-read and sibling-reasoned, not run; the GUI keep-list line is code-read, not driven through an editor save.

---
**Attribution**: AI-written; I've read the whole diff and can answer questions on it myself. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>Patch details: gateway: a translated ask of a provider marked carry-cid=yes carries the caller's X-Cid header (#4899) — git am applies it as is; SHA-256 first 16: ffbee0f8225bed57</summary>

```
{{PATCH}}
```

</details>

Branch with the commit: [hunt-20261111-r1-4899-rework](https://github.com/ggbdpq/magpie/tree/hunt-20261111-r1-4899-rework) (head `6e4e0ae428e39356d46055c662549ed6548edef6`).
