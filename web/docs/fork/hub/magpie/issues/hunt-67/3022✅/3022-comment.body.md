@Shane-Meng Thanks — the independent reproduction helps, and everything in it that can be checked locally checks out. I re-verified against current main (`be002aca`) today: the defect is still there, the branch is still needed, and one of the four newer redact commits now conflicts with the patch mechanically (details below).

**What I could verify of the new evidence**

The mechanism you describe is pinned locally on `be002aca`. Besides the branch's regression test (`TestMaskJSONKeepsArgumentsJSON`), I ran a throwaway probe in the shape of the fragment you quoted — `...possible new issue\n\n\n@pytest.…` as a tool call's arguments — and on unfixed main the arguments come out exactly as you describe, the backslash left right against the placeholder:

```
--- FAIL: TestMaskJSONKeepsArgumentsJSON (0.00s)
    escape_test.go:31: 2 masked, want 1: {"messages":[{"role":"user","content":"write {{EMAIL_eymlaavc}} about the demo"},{"role":"assistant","content":null,"tool_calls":[{"id":"call_1","type":"function","function":{"name":"pwsh","arguments":"{\"command\":\"print('before')\\{{EMAIL_daaqu6wd}}()\\ndef demo():\\n    return 1\"}"}}]},{"role":"tool","tool_call_id":"call_1","content":"done"}]}
--- FAIL: TestProbeTripleNewlineDecorator (0.00s)
    shane_probe_test.go:40: arguments no longer JSON (1 masked): {"command":"looked into a possible new issue\n\n\{{EMAIL_lbqbj3xb}}\ndef demo():\n    pass"}
FAIL
FAIL	github.com/yetone/magpie/internal/redact	0.789s
FAIL
```

With the branch's fix applied, both pass:

```
=== RUN   TestMaskJSONKeepsArgumentsJSON
--- PASS: TestMaskJSONKeepsArgumentsJSON (0.00s)
=== RUN   TestProbeTripleNewlineDecorator
--- PASS: TestProbeTripleNewlineDecorator (0.00s)
PASS
ok  	github.com/yetone/magpie/internal/redact	0.862s
```

(Red above: only the test files present, product files at `be002aca`; green: the branch's patch applied. `go test -tags nogui ./internal/redact/... -count=1` ok; `go test -tags nogui ./internal/gateway/ -run 'Redact|redact|Mask|Seen' -count=1` ok; `go test -tags nogui ./internal/redact -race -count=1` ok; `gofmt -l internal/redact` empty; `go vet -tags nogui ./internal/redact` clean. This round on Windows/go1.26.8; the darwin/linux builds of the branch itself were not re-run.)

What I cannot reproduce locally is the strict-vs-lenient vendor table (the real Ollama Cloud 400 against WorkBuddy's 200) and your bisection numbers (803 entries, the 431/429 cut, the 548/549-char cut) — those stand as reported in your environment. They are consistent with the mechanism: the breakage is inside `arguments` only, so a vendor that parses them strictly refuses and one that doesn't, doesn't.

Two of your side observations also hold in current source:

- The "send unredacted" provider switch indeed cannot cover Ollama Cloud: `provider.SkipsRedaction` (internal/provider/unredacted.go) requires every base URL to be loopback, a private address or `*.local`.
- Fallback indeed does not take this 400: `retryable` (internal/gateway/fallback.go) hands a 400 to another provider only when the body matches its quota/unserved/refused/shape/region word lists or an endpoint mismatch, and "invalid tool call arguments" matches none — so the conversation stays on the provider that refuses it. (The precise reading: a 400 is not categorically never retried, this message just matches nothing on the list.)

**Where the branch stands against current main**

| Check | Result |
| --- | --- |
| Branch head | `2c8996d6` — rebased onto `be002aca` today (was `2bf5b3dc`, unchanged since the last comment) |
| The one rebase conflict | `b00c82ac` (#1977, the Try it / per-kind actions work) had inserted a new `Preview` function between `Mask` and `mask`; the resolution kept `Preview` and its `mask(...)` call gains the new `false` argument (a plain-text path), which the merged tree also needs to compile |
| After the rebase | `go test -race -tags nogui ./internal/redact/` ok (6.4s); `go test -race -tags nogui ./internal/gateway/ -run 'Redact\|redact\|Mask\|Seen'` ok (16.2s); `gofmt -l internal/redact` empty; `go vet -tags nogui ./internal/redact` clean; author preserved (`ggbdpq`) |

Upstream's four redact commits since the branch's base (`88119d4f`… were the last batch; since then `b00c82ac`, `dd791524`, `0ddcf28a`, `ec7e50b8`) all rework *what* is masked or what happens to a masked value — none of them touches *where a match may start*: `takes` still has its old form, no escape-boundary guard, and the test above fails on `be002aca` exactly as it did on the older bases. So the defect is unfixed upstream; the branch now sits directly on current main and the commit applies as is.

**On your requests**

- Merge/version is the maintainer's call, not ours to promise; the branch has been kept current by rebasing on each upstream redact change so far, and was rebased onto today's main for this comment.
- Your regression wishlist against the landed test: covered — the `\n@` shape (the test), a real email elsewhere in the same request still masked, a Windows path in a plain string still masked. Not locked by tests in the branch, though the landed guard covers them by the same rule (a match may not start after an odd run of backslashes): the `\n\n@`/`\n\n\n@` shapes (today pinned by the throwaway probe only), several decorators in one string, a Windows path *inside* `arguments`, an address and a decorator in the same arguments string.
- Raw materials (session rebuild script, gateway log excerpts) — welcome, maintainer's call whether needed; the unit test already pins the mechanism deterministically.

Siblings, re-checked on `be002aca`: redact's `mask` has four write-in points — `Mask`, the new `Preview`, `scrub`, and `MaskJSON` — and only `MaskJSON`, for strings that are JSON of their own (`arguments`, a stream's `partial_json`, via the same `asJSON` the restore side reads), turns the guard on; the other three are plain-text paths and stay as they were. Nothing else calls `takes`.

Branch with the commit: [hunt53-f-redact-json-escape](https://github.com/ggbdpq/magpie/tree/hunt53-f-redact-json-escape) (head `2c8996d6`).

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
