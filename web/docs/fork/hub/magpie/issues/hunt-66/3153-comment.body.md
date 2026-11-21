Verified the adaptation: [852182f6](https://github.com/skygunner/magpie/commit/852182f67446210d53f51ea776bdf87e20eb622c) carries the fix from my [patch above](#issuecomment-6319791623) (099cf6b2). I re-ran the ablation cycle myself (Windows, go 1.26.5), cherry-picking the commit onto f5b01574 — the upstream main my patch was written against, which is the newest state where the fix's precondition (`grokPluginBody`, merged with #3110 after the 10-16 snapshot) exists.

**Fidelity** — the product change is my patch kept intact, byte for byte where the code lives: `internal/provider/grok.go`'s three hunks (the `grokPluginBody` comment, the `keepNone`→`forPlugin` rename, the `!grokTools[ty] && !forPlugin` guard with its four-line comment, and the lone-none condition) are identical, as is the `migrate_side.go` mover's `min` note and the `plugins.go` comment. The one contextual difference is where the `plugins.go` comment sits: their stack splits `pluginProvider` into `pluginProviderServing`, so the same comment rides the same `a.body = grokPluginBody` assignment inside the split-out function — upstream evolution, not a changed decision. Theirs adds two things on top: the gateway-to-plugin regression the issue's repro asks for (`TestAllowedToolsReachesGrokPlugin` in `tool_choice_none_test.go`: a `/v1/responses` request with the `allowed_tools` choice, asserting the plugin's `fetch` receives that exact object) and two test names added to the `provider-plugins.md` paragraph, whose sentences are otherwise mine verbatim.

**Ablation at f5b01574 + the commit (cherry-pick applied clean), tests kept, the three provider product files reverted to f5b01574**:

```
--- FAIL: TestGrokPluginBodyKeepsUnsupportedToolChoice (0.00s)
    grok_test.go:141: plugin: tool_choice {Type: Mode: Tools:[]}
--- FAIL: TestAllowedToolsReachesGrokPlugin (6.30s)
    tool_choice_none_test.go:218: sent
        want {"type":"allowed_tools","mode":"auto","tools":[{"type":"function","name":"read_file"}]}
```

Both seams red — the shaper drops the object and the plugin's `fetch` gets nothing, the issue's exact symptom. Files restored: `go test ./internal/provider -run 'TestGrokPluginBodyKeepsUnsupportedToolChoice|TestGrokPluginBodyKeepsLoneNone|TestGrokBody'` ok, and `go test ./internal/gateway -run 'TestAllowedToolsReachesGrokPlugin|TestToolsOffWithoutTools|TestGrok'` ok (46.8s). The ordering the fix has to preserve holds: the built-in still drops an unsupported choice (`TestGrokBodyDropsLoneToolChoice` green, the `!forPlugin` guard is the only change at that site), the lone-`"none"`-with-no-tools branch after it is untouched (`TestGrokPluginBodyKeepsLoneNone` green), and the keep happens at shaping time — `a.body` runs at each forward, before the plugin's own rewrite reads `tool_choice`, which the gateway-level test demonstrates end to end.

**Attribution** — checked in the commit itself: author is `vincent <webmaster@palmit.com.au>`, and the message carries the trailer verbatim:

```
Co-authored-by: ggbdpq <ggbdpq@gmail.com>
```

Thank you.

**Drift / landing** — worth flagging for whoever lands this: on the `main` snapshot this thread's earlier patches were checked against (63be4771, Oct 16, what my stale local refs hold) the commit does not apply — `grokShaped`/`grokPluginBody` do not exist there, because #3110's plugin-path keeping was merged upstream after that snapshot (it is present at f5b01574, Oct 21, and everything newer). Upstream `main` has since moved past both (e00fbdbc, Oct 23); the commit's own base is a stack on that newer upstream. So the fix lands wherever #3110 is already in — any current main — and nowhere older. Checked today on `e00fbdbb`: upstream's own #3110 (`ba319a75`/`19527ca8`) is in, `grokPluginBody` sits in `internal/provider/grok.go`, and the commit applies clean everywhere except one `migrate_side.go` hunk (conflict). `gofmt -l` clean and `go vet` ok on both touched packages at the f5b01574 cherry-pick.

**Not verified here**: `-race` (this Windows host has no C compiler, so cgo can't build; the author reports `-race -count=3` green plus a local replay of the real plugin's `rewrite`), and no real plugin fetch or live Grok account — the plugin's own handling is the issue's account, as in my original verification.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
