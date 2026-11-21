Verified the adaptation: [a6a2c260](https://github.com/skygunner/magpie/commit/a6a2c260e8a2425a8ea5276e46ac6753af9fd9c8) carries the fix from my [comment above](#issuecomment-6325966863) (52f5fba). Re-ran the cycle myself, the commit cherry-picked onto `main` @ 63be4771 (plus the two other hunt66 commits I was verifying beneath it) as 6f2d7eb5, Windows, go 1.26.5.

**Fidelity** — the regression is mine word for word: the 81 lines the commit adds to `passthrough_severed_test.go` (the `severedChat`/`chatEventsSevered` helpers and `TestPassthroughChatSeveredMidLine`/`TestPassthroughChatSeveredAtLineEnd`) diff empty against what my patch adds. The product change in `gateway.go` is the same mechanism reshaped, same semantics: an SSE relay holds the line a read left unfinished, forwards it on a clean end (`rerr == nil || rerr == io.EOF`, my exact condition), drops it on a read failure, bounds the hold at the sniffer's 1 MiB with the overage passed through unheld, and ends a severed Chat stream with `data: [DONE]\n\n` after the error event under my exact guard (`proto == provider.Chat && rerr != nil && rerr != io.EOF` — so a cleanly-cut reply still ends at the error event, `TestGeminiCompatRelayEndedShort` staying the pin). The shape differs: theirs wraps the original write as `rawWrite` and appends-then-splits at the last newline, mine splits-then-appends and keeps the `atLine` bookkeeping inline — two spellings of one behavior, and the ordering the bug is about holds in theirs the same way: the fragment is discarded before `apart()` lays the blank line and the error event down, so nothing can complete the half line into an event, and `[DONE]` follows the error only where the upstream actually severed. Their commit adds one thing mine didn't have: a 10-line paragraph in `docs/subsystems/gateway-routing.md`.

**Ablation, tests kept, `gateway.go` back to the pre-commit state** (`go test ./internal/gateway/ -run 'TestPassthroughChatSeveredMidLine|TestPassthroughChatSeveredAtLineEnd' -count=1 -v`), exit 1:

```
--- FAIL: TestPassthroughChatSeveredMidLine (0.43s)
    passthrough_severed_test.go:137: the severed stream left an event no client can read: "{\"id\":\"c1\",\"model\":\"m\",\"cho"
--- FAIL: TestPassthroughChatSeveredAtLineEnd (0.14s)
    passthrough_severed_test.go:172: the error event was not followed by [DONE]: connection lost mid-reply (unexpected EOF)","type":"api_error"}}
```

Same two failures, same messages, as my patch's red. Files restored: the two pass, and the whole streaming family with them — `go test ./internal/gateway/ -run 'TestPassthroughChatSeveredMidLine|TestPassthroughChatSeveredAtLineEnd|Passthrough|Severed|LoopCut|StreamCut|NonStream|GeminiCompat' -count=1` exit 0, 53 test blocks green, 35.1s.

**Attribution** — checked in the commit itself: author is `vincent <webmaster@palmit.com.au>`, and the trailer is present verbatim — twice, actually; one of the two

```
Co-authored-by: ggbdpq <ggbdpq@gmail.com>
```

lines is redundant and could be dropped when this lands. Thank you.

**Drift / landing** — the gateway.go hunks apply cleanly onto the 63be4771-era passthrough (only the doc paragraph conflicts there, its neighbours differing; the paragraph itself appends unchanged), and the commit applies whole on its own stack. On today's main (`e00fbdbb`, checked 2026-10-23) the commit's whole diff — doc paragraph included — passes `git apply --3way --check` clean, and the fix is still absent from it. `gofmt -l` clean, `go vet ./internal/gateway/` ok at the cherry-pick.

**Not verified here**: `-race` — this Windows host has no C compiler, so cgo can't build (the author reports the family green with `-race -count=3` on Go 1.26.8, and my original verification ran the family under `-race` on darwin); no real Z.ai account and no Pi run, as before — the fake replays the reported severance and the client-side reading rests on the pi-ai parser accounts.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
