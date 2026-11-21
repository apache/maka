Took this one (the `take` above). This lands the skip you asked for in point 2 ("skip the child's classification when the parent already produced a pick"); point 1 (documenting the layer rules) is answered in `group set --help` as part of it; point 3 (warning at set time for slow `classifier=group/<id>`) needs its own look and is untouched here.

**Symptom**

A group reached through a parent group ran its own classifier on the same turn even after the parent's classifier had already picked the turn's reasoning — an answer the turn then throws away, since the effort sent is the outermost group's pick (a nested pick only fills in when the parent gave none). On your day the group in it answered 27 of 28 such turns, 2,031–8,001 ms each, and the 14 turns where the parent picked discarded the child's answer; both classifications sit on the request's path before its first byte, so those turns paid both waits. Neither answer was cached across the layers because the classify cache keys on the classifier model.

**Minimal repro**

`internal/gateway/nested_classify_test.go` (`TestNestedGroupClassifierNotAskedWhenTheParentPicked`) builds exactly your setup: parent group `r` (`effort=auto`, classifier `cp/cls`) holding `group/quality` (`effort=auto`, classifier `cc/cls`, member `f1/m`), one turn that asks for reasoning. Before the change the child classifier is asked and its answer (low) discarded while the request goes out at the parent's pick (high); the test fails with `the group in it asked its classifier 1 times though the parent picked`. After the change the child classifier is asked nothing and the request still goes out at high; with the parent's classifier failing, the child is asked as before and its low is what goes out.

**Root cause**

`nestedRules` runs `ruleFor` for each ruled group in the group, and `ruleFor` decided to ask the effort from that group's own config alone — nothing told it a pick already stood above it, so it asked for one the consumer (`gateway.go`, "the outermost group's that did") would drop.

**Fix**

`ruleFor` now takes the pick a group above it already made, and with one standing it does not ask the effort again. The intents, when the group's rules have them, are still asked — they route that group and are not the parent's to answer. The fallback keeps working: the group in it is asked as before whenever the group above gave no pick (its pick then stands, as on your 14 no-pick turns), and once the parent fails on later turns its own pick chain is kept as it was. The trace now says why nothing was asked (`classified.error` = "the group above already picked this turn's reasoning") instead of leaving the nested `classified` out. `magpie group set --help` says the rule under `effort auto`. The change's own cost per request is two string comparisons on the routing path; what it saves is the whole second classifier round on every turn the parent picks.

One corner worth stating: on the first fallback turn after a parent-picked turn, the child's own chain no longer remembers the pick it was never allowed to send. That memory never matched what the child's members had served (they served the parent's level), so the old kept level could send a reasoning amount the child's vendor cache didn't hold; the fresh pick sent now is the honest one.

**Verification**

| Check | Result |
| --- | --- |
| `go test -tags nogui -run TestNestedGroupClassifierNotAskedWhenTheParentPicked ./internal/gateway` | green; red before the fix, red again with the fix reverted and the tests kept |
| `go test -tags nogui ./internal/gateway` | one failure, `TestCodexPoolSaysTheClientsVersion`, which the parent commit's own full run fails the same way and both pass alone — every other test passes |
| `go test -race -tags nogui -run 'TestGroup|TestNested|TestIntent|TestJev|TestRule|TestClassifier|TestChatClassifier|TestFixedMember|TestDecide' ./internal/gateway` | pass |
| `gofmt -l internal/gateway internal/cli` | prints nothing |
| `go vet ./...`, `GOOS=linux go vet ./internal/gateway/...`, `GOOS=windows go vet ./internal/gateway/...` | pass (the cgo warnings vet prints in `internal/gui` print at the parent commit too) |
| `go build ./...` (darwin, windows) | pass |
| `GOOS=linux go build ./...` | fails inside the wails dependency's own linux sources, byte-for-byte the failure the parent commit gives; `GOOS=linux go build ./internal/gateway/...` passes |
| `go test -tags nogui ./internal/cli` | fails `TestSettingsCLISetsWhatTheWindowSaves` and `TestEveryRouteHasACommandOrIsNamed`, both failing the same way at the parent commit |

Not verified: no live traffic or real accounts — the latency and counts on my side are the test's (a classifier upstream asked 1 vs 0 times), the 2–8 s figures are yours; the Routing page's rendering of the new `classified.error` text is unchecked (no GUI suite run) — it already renders `classified.error` strings such as "the group has no classifier", so I expect it to read as-is; and `classifier=group/<id>` spending the whole classifier wait (your second finding) is unchanged by this patch.

**Attribution**: AI-written; I've read the whole diff and the tests pass. Please keep the author (`ggbdpq`) or add `Co-authored-by: ggbdpq <ggbdpq@gmail.com>`.

<details><summary>patch: fix(gateway): skip a nested group's effort classifier when the group above picked (#4358) — git am applies it as is; SHA-256 first 16: 109fcf27a27cd0f2</summary>

```patch
PATCH-BODY
```
</details>

Branch with the commit: [fix/4358-nested-group-classifier](https://github.com/ggbdpq/magpie/tree/fix/4358-nested-group-classifier) (head `9f22642943c362063e6716c426a6e049eba11ff0`).
