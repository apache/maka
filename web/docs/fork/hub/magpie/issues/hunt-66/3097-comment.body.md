Verified the adaptation: [a0b3c8f6](https://github.com/skygunner/magpie/commit/a0b3c8f6ad99d34d6e412f9b410ecfd3f5ef7942) carries the fix from my [patch above](#issuecomment-6319847049) (e5b407b) onto `main`. Re-ran the whole cycle myself on `main` @ 63be4771 (Windows, go 1.26.5), with the commit cherry-picked as 039eb1e4 on top of it.

**Fidelity** — the product change in `internal/gateway/gateway.go` is the same one, logic and placement identical: `compat := geminiCompat(p.Host(), model)` worked out once, a top-level `withoutFields(body, "options")` under that predicate, and `chatCallSignatures(body, compat)` reusing it; only the inline comment is shorter (one line instead of six). Scope is the same targeted drop, not a whitelist: only the top-level `options` name, only for a Gemini OpenAI-compatible upstream. A real Ollama upstream or any other vendor's Chat API keeps `options` untouched (the predicate's scope decides), and the Ollama routes' own builder (`ollamaChatBody`) is not involved — so the field's Ollama semantics survive everywhere they mean something. The regression is mine extended: same test name, now a strict local upstream that turns the request away with the reported 400 whenever `options` reaches it, ten cases (runner/empty/null/absent options and another vendor, each streaming and whole) plus assertions that the nested tool parameter named `options` and the ordinary fields survive. The `gateway-routing.md` line is byte-for-byte the one from my patch.

**Ablation on 63be4771 + the commit, test kept, `gateway.go` reverted to 63be4771** (`go test ./internal/gateway/ -run TestGeminiCompatRelayLeavesOutOllamaOptions -count=1 -v`), exit 1 — exactly the six Gemini cases with content in or shapes of `options` fail, `absent` and `other-vendor` pass:

```
--- FAIL: TestGeminiCompatRelayLeavesOutOllamaOptions (2.39s)
    --- FAIL: .../runner/stream=true, .../empty/stream=true, .../null/stream=true
    --- PASS: .../absent/stream=true, .../other-vendor/stream=true
    --- FAIL: .../runner/stream=false, .../empty/stream=false, .../null/stream=false
    --- PASS: .../absent/stream=false, .../other-vendor/stream=false
    gemini_compat_cut_test.go:213: status 400: {"error":{"code":null,"message":"UP: Invalid JSON payload received. Unknown name \"options\": Cannot find field.","param":null,"type":"invalid_request_error"}}
```

The 400 names the reporter's exact wording. With `gateway.go` restored: same command, exit 0, `ok`, 10/10 subtests.

**Siblings** — `withoutFields` is the pre-existing top-level-field drop (15 call sites at 63be4771: Qwen's `enable_thinking`/`thinking` at gateway.go:4010, Mistral's `stream`, Anthropic's sampling fields, …), so the fix rides the established helper; `geminiCompat`'s other readers (thought signatures at gateway.go:3994, thinking config at :4409/:4788) are untouched. The translated path never carries the field (`parseChat` decodes into a typed struct), which the `absent`/`other-vendor` cases and the existing Gemini-compat tests pin from their sides. `keep_alive`, the other Ollama-only field, stays out of scope as in my patch — nothing reported sends it on this route.

**Attribution** — checked in the commit itself: author is `vincent <webmaster@palmit.com.au>`, and the message carries the trailer verbatim:

```
Co-authored-by: ggbdpq <ggbdpq@gmail.com>
```

Thank you.

**Drift / landing** — the commit sits on the author's stacked batch branch (parent 4671590d-adjacent, `main` @ 63be4771 is under it); `git apply --3way --check` of the commit on 63be4771 is clean for all three files (doc line included), and the cherry-pick applied with no conflicts. Today's main (`e00fbdbb`) still lacks the fix and takes the commit's whole diff clean (`apply --3way --check`).

**Not verified here**: `-race` (this Windows host has no C compiler, so cgo can't build; the author reports the ten cases green with `-race -count=5`) and no live Google endpoint — the strict fake turns the exact reported 400, as in my original verification.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
