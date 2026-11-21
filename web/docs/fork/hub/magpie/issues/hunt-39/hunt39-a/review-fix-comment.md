All three are addressed — branch [`hunt39-a-compact-seal-review`](https://github.com/ggbdpq/magpie/tree/hunt39-a-compact-seal-review) (head `781381f4`, on current `upstream/main` `992f288e`; it supersedes `a8a468cf`, which your tree can drop for this one).

**1. A writer on in magpie answers the compact, signed as the writer.** The unified judgment you sketched is `sealedCompact` at the passthrough: `checkpointOf` on the body, the walk of `checkpointGone` for the writer's state — gone (signed out, lapsed, paused, switched off, kept from the model, provider or model gone) is refused with `checkpointError`'s words, the same the same request on `/responses` gets; on and serving the seal's model, its answer is `checkpointNotRouted` — your own words for a healthy writer — and the compact is relayed through `codexUpstreamOn` signed as the writer. Your temporary test's case now goes 200 through `biz@example.com`.

**2. The `compactOn` path is judged too.** The judgment sits before the `on != nil` branch, so a paused sign-in changes the signature, not the verdict: a seal of the account `compactOn` picks is forwarded as that writer; a seal of a gone writer is refused even though a healthy account stood ready to relay it.

**3. The email join and the key skip, both commented and tested.** The comparison stays on the account user — two Team seats of one email read as one and fall to the old forwarding; the code comment says so beside the match. A key-written seal has its subtest (relayed, not judged).

Reads that fail stay fail-open, as you had it: `provider.Find` error, no sign-in, or no readable logins (discovery off) relay as it came.

**Tests** — `TestNativeCompactionCompactJudgesItsWriter`, seven subtests, red on `992f288e` for the three behavior changes and green with the change:

| Check | Result |
| --- | --- |
| Writer on in magpie answers it, signed as the writer (the backend sees its account id) | red before (relayed to the sign-in), green |
| Writer gone refused here, saying why (`no longer signed in to magpie`, `sign in … again`) | red before (200, relayed), green |
| On the `compactOn` path (sign-in paused) a gone writer's seal is refused too | red before (200 via the other account), green |
| On the `compactOn` path the writer on answers it | green (documents the path) |
| The sign-in's own seal / a key's seal / a request naming another account relay as it came | green (unchanged) |
| `-race -count=3` on the test | green |
| Ablation: `codex_backend.go` restored to `upstream/main`, tests kept | the same three fail again |
| Mutations: the gone classifier inverted; the `chatgpt-account-id` skip dropped | five red (the healthy answers among them); the skip's subtest red |
| `TestNativeCompaction*` family; targeted `NativeCompaction|Compact|Checkpoint|TestCodex|ProxyDown`; full `internal/gateway` suite | green |
| `gofmt -l`, `go vet ./...`, linux/windows vet, darwin/linux/windows builds | clean (the known `trayimage` cgo warning aside) |

Your tree's hand-merged `45cc0d6d7` isn't on origin, so this branch stands on `992f288e` and carries the whole change — it can replace `a8a468cf` there directly.

---
**Source**: reported in #2727; reviewed by yetone in this thread.

**Red without the fix** (base `992f288e`): with `internal/gateway/codex_backend.go` reverted and the tests kept, `go test -tags nogui -run TestNativeCompactionCompactJudgesItsWriter ./internal/gateway` fails:
```
--- FAIL: .../a_writer_on_in_magpie_answers_it,_signed_as_the_writer
--- FAIL: .../a_writer_gone_is_refused_here,_saying_why
--- FAIL: .../on_the_compactOn_path_a_gone_writer's_seal_is_refused_too
```
With the fix: `ok`.

**Siblings**: `rg -n "checkpointOf\(" internal/gateway` → three entry paths judge a recorded seal: `/responses` in serve (`checkpointReaders`), `/responses` on Codex's own models (`codexSealedFor` → serve), and now the legacy `/responses/compact` (`sealedCompact`). Nothing else reads the record.

**When the read fails**: `provider.Find` error, no sign-in, no readable logins, or an unresolvable writer resolve to relay-as-it-came — a failed read relays, never refuses. The refusal text is `checkpointError`'s, which reads the writer's real state per account (`checkpointGone`).

**Not verified**: a real ChatGPT backend (the writer-signed compact against the actual `/responses/compact`), Windows GUI.

**AI**: I've read the whole diff and can answer questions on it myself.
