A provider configured by its URL alone speaks Chat Completions, so an Anthropic Messages or an OpenAI Responses request to it is translated — and the caller's correlation carriers never reached the provider: the body's `metadata` object, the `X-Cid` header and the URL's query string were all dropped on the way, which left a caller unable to pair its turns with what the provider served.

## Reproduced locally on current upstream/main

A recording stub (`url=` only, asked to stream, as the report describes), a request to `/v1/messages?cid=abc123` with `X-Cid: abc123` and `"metadata":{"cid":"abc123"}` in the body:

- the upstream got the query string `""`,
- `X-Cid: ""`,
- and a built Chat body with no `metadata`.

Same stub with `anthropic=` set as well (the relayed shape): the body's `metadata` came through, and the query string and `X-Cid` did not — on current upstream/main the relay preserves what the body carries but drops the other two carriers too, so the report's "passthrough keeps all three" holds for the body's fields alone here (0.1.2687 may have differed; the recording stub in the report is the better instrument and I would not argue with its captures — this is only what the code at 173b7e274 does, probe-verified).

## Root cause

- The IR holds an Anthropic client's `metadata` and renders it when the request is built again for an Anthropic upstream (#359); the Chat build left it out, and a Responses client's top-level `metadata` was not even read.
- `forwardOnce` copies only the headers a client shape is known by (Claude Code's, Codex's, bili's); a caller's correlation header had no ride at all.
- A translated request's path is `pathOf(target)`: fixed, and the inbound query was dropped there. (The relay's path is fixed too, its one exception Claude Code's `beta=true`.)

## Fix

- The translation carries the caller's `metadata` on: the built Chat request has it as it was sent. An upstream that turns the field away by name is asked again without it, and is not sent it again, as the cache key already is — `metadata` sits in `optionalFields`, so the refusal-retry contract is the codebase's own. A Responses client's `metadata` is read beside its `client_metadata` now.
- The caller's `X-Cid` header goes on every request to the provider, translated or relayed; the user's own header for the provider still replaces it in the signing, and OpenCode's free gateway keeps its exact header set as before (#3491).
- The caller's query string merges into the path a translated request goes by, the path's own parameters (Code Assist's `alt=sse`) standing, and no parameter a caller's credential travels by with it: a gateway key comes in the query (Gemini's clients hand magpie their key as `?key=`), and a caller's key is magpie's, never the provider's — `key`, `api_key`, `apikey`, `access_token`, `token` are filtered, everything else rides. `cid=abc123` now reaches the stub above.

## Sibling faces, changed and not

- Gemini: a Gemini inbound's translation goes by the same path, so the caller's `X-Cid` and query ride it too; the body's `metadata` is not carried there — Gemini's build has no field for it and the report covers the Chat face, so I left the body face alone rather than invent a mapping.
- Anthropic-in → Responses-upstream: the metadata is read now but `buildResponses` does not render it, unchanged. Same for Code Assist.
- The relayed request's query string stays as it was (dropped); only its `X-Cid` changes with `forwardOnce` being shared.
- The `cache_control` loss the report sets aside is untouched here.

## Verification

| Check | Result |
|---|---|
| `go test -tags nogui -count=1 -run 'TestTranslatedRequestKeepsCallerCarriers\|TestRelayedRequestKeepsCallerCidHeader' ./internal/gateway` | ok (5 subtests: Anthropic in, Responses in, streamed, refusal-named-drop retry, relayed header) |
| RED before the fix | all five red with the reported symptom (query `""`, `X-Cid ""`, no `metadata`; refusal left the client a 400) |
| Ablation: the seven product files from the parent 173b7e274, tests kept | all five red again; green with the commit restored |
| `go test -tags nogui -count=1 ./internal/gateway` | ok (one red, `TestCodexPoolSaysTheClientsVersion`: green alone and at `-count=3` on both this branch and the parent — a known full-suite flake) |
| `go test -tags nogui -count=1 ./internal/...` | ok (one red, `TestHostToldTheGatewayAddress` in internal/plugin: red on the parent too) |
| `gofmt -l`, `go vet -tags nogui ./internal/gateway ./internal/provider` | clean |
| `go build -tags nogui` darwin / GOOS=linux / GOOS=windows | ok |

Not verified: no live vendor behind the stub — the carriers' arrival is asserted on a recording upstream, and how real Chat vendors treat a caller's `metadata` values is only guarded by the refusal-retry, not exercised against any of them; the report's own harness was not run; the query merge is unit-covered on Chat targets only, so its behavior on Gemini and Code Assist paths (where the path already carries `alt=sse`) rests on the merge's own test-free reading of the code path.

---

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: translated requests keep the caller's correlation carriers (#4899) — git am applies it as is; SHA-256 first 16: c50afcfc08845ee4</summary>

```
PENDING_PATCH
```

</details>

Branch with the commit: [fix/4899-translation-correlation-carriers](https://github.com/ggbdpq/magpie/tree/fix/4899-translation-correlation-carriers) (head `f3416216a38d0a4727ca74296c93ad1c4ca62264`).
