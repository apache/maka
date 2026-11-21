<!-- 已发布（2026-10-17，用户确认）：fork 分支 hunt39-b2-gw-trigger-gate @37040572，评论 https://github.com/yetone/magpie/issues/2725#issuecomment-6234451515（回读 5104 字符）。本文件=发布底稿留档。 -->

Took route (a): the trigger is kept only when a key or account the plan would go over can be asked it, and where none is, magpie summarises through the listed key, as it does when native compaction is off. Nothing is sent to a key whose list lacks the model — the parity with ordinary routing holds by construction, and the fake-upstream objection doesn't arise: with the gate in, no request leaves the listed keys, so the tests prove the route and the route is all there is.

The four points, on the branch rewritten on today's `upstream/main` (`89521b03`):

**1. The gate judges where the contradiction is.** `nativeCompactionFor` now asks `planCarries`, which runs `compactionCarriers` over the same plan the request itself takes — `s.plan` for the provider asked and its fallbacks, `planGroup` for a group's members, held and capped accounts among them. Gate and carriers filter cannot disagree: when the gate passes, `compactionCarriers` keeps what it kept when the gate looked; when it fails, the trigger isn't kept, and `codexCompact` gives magpie's summary, which the listed key reads — the codex provider's own models decided so already (#2582).

**2. The writer case is untouched.** Only the trigger-keeping decision changed. `keepsCompaction` still judges at the candidate (#2642's writer evidence), `checkpointReaders` still takes the writer back from unlisted, and `compactsNatively`'s other reader — the `withoutCompaction` guard in `attempt` — keeps its provider-level meaning.

**3. No duplicated block.** The patch's unlisted branch is gone; `compactionCarriers` stays the one-liner it is on main and remains the only place the carriers decision is made. `planCarries` calls it; there is no second walk of `planned.unlisted` to keep in step.

**4. Tests that tell the outcomes apart.** The new fixture's fake is asked once, and only where the vendor's list serves the model: `TestNativeCompactionTriggerSummarisedWhenNoListedKeyCarriesIt` (the reviewed fixture) expects 200 with magpie's summary through the listed chat key, the unset key never asked; `TestNativeCompactionTriggerThroughTheListedKeyThatCarriesIt` pins the listed path unchanged — the trigger through the key that carries it, the key whose list lacks the model unasked, green before and after, as you asked.

| Check | Result |
| --- | --- |
| `TestNativeCompactionTriggerSummarisedWhenNoListedKeyCarriesIt` on base `89521b03` | red — 400 carrierError, the relay asked 0 times |
| The same with the fix | green — 200, magpie1: back to Codex, summary asked at `/v1/chat/completions` by the listed key, `/v1/responses` never asked |
| `TestNativeCompactionTriggerThroughTheListedKeyThatCarriesIt` on base | green (protective: the listed-key path unchanged) |
| Ablation: `internal/gateway/native_compaction.go` alone reverted to base, both tests kept | first red again, second green; restored, both green |
| Both new tests, `-race -count=3` | green |
| Targeted `-run 'NativeCompaction\|Compact\|Checkpoint\|CodexBackend'` | ok |
| `go test -tags nogui -p 2 ./internal/gateway/` | ok |
| `gofmt -l internal/gateway/`, `go vet -tags nogui`, builds darwin/linux/windows (`CGO_ENABLED=0 go build -tags nogui`) | clean / clean / ok |

Branch: [ggbdpq/magpie `hunt39-b2-gw-trigger-gate`](https://github.com/ggbdpq/magpie/tree/hunt39-b2-gw-trigger-gate) (head `37040572`, on `89521b03`). The old `hunt39-b-gw-carriers-unlisted` stands as the record of the patch this replaces; your tree can drop it once this one is in. Author or `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`, whichever helps.

---
**Source**: found by code audit (AI-assisted), not from a real failure I hit; reviewed by you above — still no user report of the refusal.

**Red without the fix** (base `89521b03`): with `internal/gateway/native_compaction.go` reverted and the new tests kept, `go test ./internal/gateway -run TestNativeCompactionTriggerSummarisedWhenNoListedKeyCarriesIt` fails:
```
--- FAIL: TestNativeCompactionTriggerSummarisedWhenNoListedKeyCarriesIt (0.50s)
    native_compaction_test.go:680: 400, the relay asked 0 times: {"error":{"message":"Codex asked fake/m1 for its own compaction (native compaction), and none of the keys or accounts that serve fake/m1 now can be asked it on the Responses API. ..."}}
```
With the fix: `ok`. The listed-key test is green before the fix too — protective only.

**Siblings**: `rg -n "nativeCompactionFor\(" internal/` → `gateway.go:1418` (`handle`) and `codex_backend.go:154` (`codexBackend`) — both are the trigger-keeping decision, both meant to see the gate. `compactsNatively`'s other reader (`gateway.go:2819`, the `withoutCompaction` guard) keeps the provider-level meaning; `keepsCompaction`/`checkpointReaders` untouched.

**When the read fails**: a provider whose lists never loaded serves every key (`Serving` counts unknown as serving), so the gate passes whenever the provider-level check does — such a provider is unchanged.

**Not verified**: a real multi-key relay with differing key protocols; the Routing page.

**AI**: I've read the whole diff and can answer questions on it myself.
