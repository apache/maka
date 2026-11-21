Verified — `ec3c82b1` carries my 7112fe69's semantics with the exact trailer `Co-authored-by: ggbdpq <ggbdpq@gmail.com>` in the commit message (checked on the commit itself, not the branch). The plumbing is byte-identical: `innerAffinity`'s body, the candidate's `affinity` field, and the `planLevel` assignment (comments shortened). `affine`'s answerer-mode override is there too. Added on top, deliberately: `strictKeep` now re-derives the mode from the capped or credit-held answerer through a shared `lastAnswerer` match (account/model/fixed-effort, most specific first), so an inner `off`/`session`/`turn` also overrides an outer `strict` at the cap boundary — my patch kept such a conversation whenever the asked group was strict, so this is the more consistent direction, and it is what the commit message says it is. `TestNestedGroupStrictAffinity` is kept with every assertion intact (only an unused variable dropped), plus four more tests (nested modes, a cap/credit-hold matrix, answering-model precision, a held account through the gateway) and the routing-doc row.

Cherry-picked onto the branch's merge-base `63be4771`; there `affinity.go` merges clean and `fallback.go`/docs needed a hand resolution only because the branch carries its own #2410 work — which upstream has since merged (`ae98cda6`), so on today's main (`e00fbdbb`, a 444-commit wave later) this commit's own diff applies clean with `git apply --3way --check`. On the cherry-pick, with the product file reverted and the tests kept, all five nested tests fail, and pass with it back:

```
--- FAIL: TestNestedGroupStrictAffinity
    nested_affinity_test.go:79: second turn, the inner group's strict: 200 {"id":"x","choices":[{"index":0,"message":{"role":"assistant","content":"from k2"},"finish_reason":"stop"}]} tried k1,k2
```

— the issue's own shape (the other four fail in their own assertions), then `ok` with the fix. The strict/affinity/cap/sink families around it: `ok`. `gofmt -l` clean, `go vet -tags nogui ./internal/gateway` clean. I could not run `-race` here (no C toolchain on this Windows box), so that one stays on your recorded run.

No sibling left behind: `strictKeep` and `affine` are the only two readers of the mode (gateway.go), both covered; `trace.go`'s `GroupRef.Affinity` is display only. Still missing from main as of `e00fbdbb` (checked 2026-10-23).

Thanks for the credit and for tightening the cap boundary my patch left inconsistent.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
