**Summary**

With `tools` declared and the model answering in text alone, the streamed reply's final frame carries `"function_call":{"name":"","arguments":""}` where OpenAI's contract has `null` (or the field absent). A client that checks every frame's shape reads the empty object for a legacy function call and refuses the whole turn — OpenMausBot's `legacy function_call is unsupported; use structured tool_calls` — so every text-only reply a tools-carrying request got was a turn lost. Loose clients merge the empty object into nothing, which is why this stayed hidden.

**Minimal repro**

The issue's curl against a WorkBuddy/DeepSeek route (`tools` + `stream: true`, the model told to answer in words) prints `"function_call":{"name":"","arguments":""}` from the last frame, 2/2 runs, while no-tools streams keep `"function_call":null` all through and a non-streamed message carries no `function_call` at all. In-repo, the new `TestStreamedEmptyFunctionCallLeftOut` reproduces it with no network: a Chat upstream that ends its stream the way WorkBuddy's does, a tools-carrying request, and the client's body read back.

**Root cause**

The frame crossed magpie's Chat relay untouched. chatTidy mended the frame's other quirks on the way — the `"finish_reason":""` became null, the empty `tool_calls:[]` was left out — but it had no rule for `function_call`, so an empty object went through as it came. Nothing on a relayed stream constructs that object in magpie: the tidy paths keep every field byte for byte or write null for null (I traced the encode paths and searched for any type or map that could marshal it), so the empty object is the upstream's own frame — its wire is a Go-style map encode, and the same final frame on a no-tools stream carries `"function_call":null`. Whichever end writes it, the gateway is where a client-facing frame gets mended, as #1475 did for a tool call that names no function: an empty `function_call` says nothing and runs nowhere, so it is no call.

**Fix**

chatTidy leaves out a delta's `function_call` that carries nothing — a name and arguments both empty strings or null, either absent (#4659). A `null` is the contract's own nothing and goes as it came. A call whose name or arguments hold something is one a client may still be reading, and a name or arguments of another kind than a string is not read: both untouched. Lines with `"function_call":null` never enter the mending path — the shape gate matches `"function_call":{` only — so the common frame costs one byte scan, like the gates already there.

**Verification**

| Check | Result |
| --- | --- |
| `TestStreamedEmptyFunctionCallLeftOut` (WorkBuddy's final frame, tools + text-only) | RED before the fix — "an empty function_call object went out where the contract has null"; GREEN after |
| `TestStreamedNamedFunctionCallKept` (a legacy call naming a function, its arguments fragment, its `function_call` finish) | GREEN, untouched by the mend |
| Ablation: `chattidy.go` reverted to the base commit, tests kept | the symptom test went RED again with the same output |
| `go test ./internal/gateway/ -tags nogui` (whole package) | ok |
| Targeted tests under `-race` | ok |
| `gofmt -l` on changed files, `go vet` on the package | clean |
| Builds: linux/amd64, windows/amd64, darwin/arm64 (`-tags nogui`) | ok (pre-existing C enum-conversion warnings in internal/gui on darwin) |
| `git apply --check` of the patch on upstream/main (5416fdb76) | applies cleanly |

**Not verified**

- Against the signed-in WorkBuddy route itself: the repro needs a real WorkBuddy/DeepSeek account with tools, so the vendor-side frame comes from this issue's capture and the repo's recorded WorkBuddy wire, not from a fresh run. The mend holds whichever end writes the empty object.
- No dedicated end-to-end run of the group and translated paths against a vendor: both are covered by the package suite, and the translated encoders never write a `function_call` field at all.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a Chat legacy function_call carrying nothing is left out (#4659) — git am applies it as is; SHA-256 first 16: bc0d0899e33cc3f3</summary>

````
{{PATCH}}
````

</details>

Branch with the commit: [hunt115-a-4659](https://github.com/ggbdpq/magpie/tree/hunt115-a-4659) (head `10865c44c58d6b98c364ee0bddfcb25663589e1f`).
