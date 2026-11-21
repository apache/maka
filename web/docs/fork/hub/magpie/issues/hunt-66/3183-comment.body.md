Verified the fork commit on top of `63be4771` (Windows, Go 1.26.8): cherry-picked b1ae66c7, ran the collaboration family in both packages, and reproduced both halves' regressions with the product files reverted.

**What was verified**

- Response side adapted from my `9fff5bab` faithfully: the `nsTidy.call` change and the first 167 lines of `native_relay_collab_test.go` are verbatim identical to my patch (the file is created fresh in this commit — its parent does not contain mine — so the commit is self-contained).
- The "other half" is the request side my patch explicitly deferred, and it has its own independent test: `forVendor` turns a plaintext `agent_message` into a user message via `provider.PlainAgentMessage` (the existing Grok converter, exported), `openaiOnly` gains an `"agent_message"` probe, and `TestNativeRelayPlainAgentMessage` locks the conversion, the preserved sender/recipient/image, metadata removal, and the sealed/unsupported negatives.
- One deliberate divergence from my patch, locked by `TestNativeRelayOpenAICallUnchanged`: the relay gate excludes a Codex account and `openai.com` hosts, so native OpenAI/ChatGPT replies are never touched, where mine read namespaces on every relay and relied on "a seal present stays untouched". More conservative on the official routes; behavior on third-party vendors is the same.
- Attribution in the commit is present and exact: `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`, with "Adapt ggbdpq/magpie 9fff5bab..." in the message. Author: vincent.

**Red without the fix** (gateway.go, grok_namespace.go, codex_backend.go, provider/grok.go reverted to base, tests kept):

| Check | Command | Result |
|---|---|---|
| Four new tests, product files at base | `go test -tags nogui -run '^(TestNativeRelayNamespacedCallSaysUnsealed\|TestNativeRelayLeavesOtherCallsBe\|TestNativeRelayPlainAgentMessage\|TestNativeRelayOpenAICallUnchanged)$' ./internal/gateway/` | 2 FAIL |
| Same, fix restored | same command | ok 1.983s |
| Relay/grok family with the fix | 8 gateway + 7 provider tests | ok |
| New tests under the detector | `-race -count=3` | ok 6.712s |

The two reds are the two halves:

```
--- FAIL: TestNativeRelayNamespacedCallSaysUnsealed (0.57s)
    native_relay_collab_test.go:122: stream true: Codex was given map[arguments: call_id:c9 id:fc_1 name:spawn_agent namespace:collaboration type:function_call]
--- FAIL: TestNativeRelayPlainAgentMessage (0.21s)
    native_relay_collab_test.go:191: task wasn't converted: {"input":[{"author":"/root",...,"type":"agent_message"}],...}
```

The first is my original patch's own red assertion, same line — the call reaches Codex with no `encrypted_function_args`. The second is the request half. The other two tests pass on the old code too (protective, not red evidence).

**Drift and landing**: the fork's parent is 467 commits ahead of `63be4771`; three conflicts on this base, all from later-upstream structure this base lacks — `forVendorChanges` does not exist here (its role is covered by the `openaiOnly` probe plus `forVendor` itself, both of which carry the change), `provider/grok.go` here has no `grokPluginBody`/`grokShaped` split (only the rename and comment are taken), and the docs paragraph arrives mixed with a `#3205` Kimi paragraph this base predates (dropped). Lands with those adjustments; the `nsTidy.call` hunk, the test file, and the `forVendor` conversion apply as written. On today's main (`e00fbdbb`, checked 2026-10-23) the commit's whole diff applies clean (`apply --3way --check`); neither half has landed upstream.

**Gaps**: unchanged from the report — no real Codex V2 session against a third-party vendor on either side; the stub's reply is the shape the reporter's probe recorded. The `gateway-routing.md` paragraph as written references the Kimi section that follows it on newer bases; on this base it stands alone. `gofmt -l` on the five files and `go vet -tags nogui` of both packages are clean. `rg encrypted_function_args` over non-test code shows exactly the four handling points the report names — no fifth reader.

Thanks — picking up the request side closes the loop my patch left open, and the OpenAI-route exclusion with its own test is a fair answer to a question my patch dodged.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
