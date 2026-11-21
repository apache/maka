Rebased onto `764a032f6` (current `main`). One conflict, in `responses.go`: upstream 79c8667c9 (Claude's signed thinking carried back through claudeseal) and this branch both extend the `responsesEncoder` struct and its reset line. Both features kept — the streamed-dedup logic (`thinkUp` in the encoder, `addedID` in the decoder) alongside the `sig`/`bare` seal fields; the reset now clears both.

Verification:

| Check | Result |
|---|---|
| `go test ./internal/gateway/ -run '^TestResponsesStreamForeignReasoningIDNotDoubled$' -count=1` | PASS (both subtests) |
| Ablation (product file reverted to parent, tests kept) | RED — the duplicate reproduces: 3 added reasoning ids, want 2 |
| Sibling faces: `TestCodexToolLoopGivesClaudeItsThinkingBack`, `TestResponsesStreamToolThenHiddenThinking`, the five sealed-reasoning tests | PASS |
| `gofmt` (CRLF-stripped copies), `go vet` local / `GOOS=linux -tags nogui ./internal/...` / darwin | clean |
| `go build ./...` local / `CGO_ENABLED=0 GOOS=linux -tags nogui` / `GOOS=windows -tags nogui` | ok |
| `go test -race` | not run — no gcc on this machine |

Branch with the commit: [hunt47-a-reasoning-dup](https://github.com/ggbdpq/magpie/tree/hunt47-a-reasoning-dup) (head `a5b6c8a435e327b203803508ac4887343c9660e4`).

written with GLM-5.3-Flash (ZCode)
