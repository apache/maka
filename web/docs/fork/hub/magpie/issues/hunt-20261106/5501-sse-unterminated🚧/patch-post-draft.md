#5501 PATCH 帖草稿（发布前补：head sha、sha256 前 16、race 结果、预存红对照）

---

A fix is on my fork, one commit on top of upstream `main` (`30a0bfe88`):

- Branch: [`fix/5501-sse-unterminated`](https://github.com/ggbdpq/magpie/tree/fix/5501-sse-unterminated)
- Commit: HEAD-SHA, whose body has the full record of what was run

`git am` applies the patch below as is; SHA-256 first 16: SHA16.

**What changed**

- `internal/gateway/linehold.go` (new): `lineMost` (32 MiB, the line `sse.go`'s readers take) and `lineHold` — the half line waits for its rest under the bound; a line past the bound is let go as it came: what is held goes on and the rest flows as it arrives to its end, holding again with the next line. What is let go is the line itself, not a cut of it; while a line flows, a failure's `dropHalf` can no longer spare the client its cut — the price of a route whose memory stays bounded.
- The line-shaped holders hold through it now: `chatTidy` (`chattidy.go`), the relay's `pending` (`gateway.go`), `textCallTidy` (`textcalls.go`), `reasoningTidy` (`reasoning_content.go`), `sigTidy` both modes (`gemini_signature.go`), `memberWriter`'s stream hold (`member.go`), `nsTidy` (`grok_namespace.go`), `intTidy` (`grok_integral.go`), `searchTidy` (`toolsearch.go`), `crTidy` (`tool_args_cr.go`), `sigFieldTidy` (`thinking_signature.go`). `crTidy`'s `looked` accounting (#5282) is kept: `give` searches only the bytes that came new for the line's end, as the hold never keeps one.
- The holders that keep an event, not a line (`phaseTidy`, `anthropicTextCalls`, `responsesTextCalls`, `geminiTextCalls`) are another shape and stay as they are; so are the already-bounded observers (`usageSniffer`'s 1 MiB drop, `codexLimitsTap`'s 64 KiB scan, `bareErrorReader`'s `bareLimit`).

**Tests** (provider.Chat, `text/event-stream`, the relay end to end over a hijacked upstream)

| Test | on main `30a0bfe88` | here |
| --- | --- | --- |
| `TestUnterminatedLinePastTheCapFlowsThrough` (upstream grows one line past 32 MiB without ending it, pauses; the client's bytes are counted, then the line ends and the reply must come out word for word) | FAIL: 24 bytes of a 33 MiB line before its end — the route held it whole, the issue's "0 bytes before EOF" | PASS: megabytes flow before the line's end, and the reply is byte-exact |
| `TestLineHoldKeepsLinesTillTheirEnd` | PASS | PASS |
| `TestLineHoldLetsARunawayLineGo` | FAIL (no `lineHold` to hold with — new) | PASS |

**Ablation**, caught by both runaway tests FAILing: the bound lifted past any line (`lineMost` 4096 MiB) — the client back to 24 bytes of a 33 MiB line the upstream has not ended, held whole again.

**Siblings** (compared, none of them left unbounded on a path they hold)

- the relay's filter chain is serial: under the bound, a holder that lets go hands its bytes to the next holder the same write, whose own bound lets them through in turn — the route releases as one.
- already bounded, untouched: `usageSniffer` (1 MiB drop), `codexLimitsTap` (64 KiB scan), `bareErrorReader` (`bareLimit`), `heldBody` (8 MiB), `sigTidy`'s whole-reply note (`nativeNoteBytes`), `sse.go`'s scanner (32 MiB).
- event-shaped holders — `phaseTidy` (a Responses message's phase), `anthropicTextCalls`, `responsesTextCalls`, `geminiTextCalls` — hold by event, not line (`tidyEvents`/`eventEnd`); a line bound does not fit them and they are not bounded here.
- the issue named `effort_update.go` and `draw.go` among the same-shape holders: neither holds a line on a relayed stream (no such buffer there), and `draw.go`'s upload buffer is already capped at `maxImageBytes`.

**Verified** (head HEAD-SHA, base `30a0bfe88`, darwin/arm64, go1.26.8): `go test -tags nogui -count=1 -run 'TestLineHold|TestUnterminatedLinePastTheCapFlowsThrough' ./internal/gateway` ok; `go test -tags nogui -count=1 -timeout 30m -race ./internal/gateway` RACE-RESULT. `gofmt -l` clean on `internal/gateway`; `go vet -tags nogui ./internal/gateway` clean on GOOS=darwin, linux and windows; `go build -tags nogui ./...` ok on the three. Not run: the GUI suite (no GUI change), run time on Linux or Windows, and a real upstream that grows lines past 32 MiB — the shape is the report's own synthetic one, replayed here.

Thanks @yncnx for the report, the measurements — 0 bytes before EOF, and a cap on pending alone changing nothing, which located `chatTidy` — and the two-way framing of the overflow policy. The bound follows the first of the two choices the issue laid out: memory bounded, accepting that while a line flows a later failure may leave its cut at the client; until such a failure the line still arrives whole, byte for byte.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: gateway: a line the upstream never ends is held under a bound — git am applies it as is; SHA-256 first 16: SHA16</summary>

```text
PATCH-BODY-PLACEHOLDER
```

</details>
