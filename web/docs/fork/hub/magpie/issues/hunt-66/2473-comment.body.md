Verified — `9fd7a9d4` applies clean (`git apply --3way --check`) to current main (`e00fbdbb`, checked 2026-10-23; its merge-base `63be4771` took a 444-commit wave in between without touching the site), with the exact trailer `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` in the commit message. The product change is my 910522a7's: the title line `title := !tools && desktopTitle(body) && desktopAccepts(asked)` and the `byClaudeCode` removal (signature and call site) are byte-identical to mine, with the comments shortened but the same facts; `small` is rightly kept for `observe.go`, and `fromClaudeCode`'s three other callers are untouched. The regression adapts my fixture and extends it from one case to four — old provider off/on, streaming and non-streaming — keeping the pick-file-stays assertions and the real-title control, plus a docs bullet and a fixture touch-up that keeps an existing title case on the title path.

With `desktop.go` and `gateway.go` reverted to tip and the new test kept, all four cases fail with the report's shapes, and pass with the fix back:

```
probe: 404 {"error":{"message":"Any is switched off in Magpie, so \"fake/claude-sonnet-5\" is not served; switch it on again in Magpie's Providers to use it",...}}
probe: 502 {"error":{"message":"Any: Post \"http://127.0.0.1:1/v1/messages\": dial tcp 127.0.0.1:1: connectex: No connection could be made because the target machine actively refused it.",...}}
```

— the 404 is the report's own error; the 502 is the stale-provider connection attempt SivanCola reproduced on macOS. The Desktop family around it (`TestDesktop*`, `TestClaudeDesktop*`, `TestHasTools`): `ok`. `gofmt -l` clean, `go vet -tags nogui ./internal/gateway` clean. I could not run `-race` here (no C toolchain on this Windows box), so that stays on your recorded run.

One cross-check on my #3264 patch (`b55cf300`, tier picks): the two fixes edit the same line, and neither eats the other. #2473 changes what identifies a title (prompt shape instead of max_tokens); #3264 exempts tier picks from titlehood (`&& !desktopTierAsked(asked)`). Applying `b55cf300` on top of this commit conflicts only on that expected shared line; resolved they read `title := !tools && desktopTitle(body) && desktopAccepts(asked) && !desktopTierAsked(asked)` — a tier pick goes as asked, a real title still follows the session. Either variant of #2473 can land and #3264 stays needed and independent on top.

Thanks for the credit, and for covering the on/off and streaming halves my fixture didn't.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
