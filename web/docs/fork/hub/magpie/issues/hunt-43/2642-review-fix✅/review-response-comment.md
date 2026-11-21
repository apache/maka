Both points are addressed (new commit `e1646488`, force-pushed):

1. **Sibling path**: `planLevel`'s `keys` now records the unlisted accounts beside their rows (`pl.unlisted`/`pl.unlistedW`), as `plan`'s `add` does, and a group in the group planned by weight passes `sub.unlisted`/`sub.unlistedW` up with `sub.left`/`sub.capped` (the ordered branch plans nested groups into the same `planned`, so there was nothing to pass there). Added the routed-through-group case, `TestNativeCompactionWriterThroughAGroupWhoseListLacksTheModel` — the conversation's model is the group, its member the codex provider, the writer's list without the model: at 0ab41eba it was refused 400 "switched off, removed, or no longer serves" with nothing tried; now 200, the writer asked.
2. **Double display**: the rows of the compaction account chosen from the unlisted leave `pl.left` when they join the order (`checkpointReaders` drops them by row id), so the Routing page no longer shows the same account as both attempted and unlisted-skipped. Both cases now assert the writer isn't in the trace's `Left`.

The tests also now assert the spare was never asked — the direct case and the group case both.

---
**Source**: found by code audit (AI-assisted), following your review — not from a failure I hit.

**Red without the fix** (base `0ab41eba`, the branch's head before this): with `internal/gateway/fallback.go` and `internal/gateway/native_compaction.go` back to it and the new test kept, `go test -tags nogui -run TestNativeCompactionWriterThroughAGroupWhoseListLacksTheModel ./internal/gateway/` fails:

```
--- FAIL: TestNativeCompactionWriterThroughAGroupWhoseListLacksTheModel (0.51s)
    native_compaction_test.go:396: 400 tried "": {"error":{"message":"This conversation was compacted natively by codex@me@example.com, and only that key or account can read the compaction it sealed. The request for group/g can't go to it now: it is switched off, removed, or no longer serves group/g. ..."}}}
```

(the direct case stayed green at that base — which is how the sibling path slipped past my first patch). Ablation, one file at a time, tests kept: `fallback.go` reverted — the group case red again, the same 400; `native_compaction.go` reverted — both cases red saying the writer, tried, is still left out (`Unlisted: true` in `Left`); restored, green.

**Siblings**: the exits where a `planned.unlisted` candidate was dropped were `plan`'s `add`, `planLevel`'s `keys` and the weighted sub-plan in fallback.go — all three now record or pass it up; the ordered branch and `planGroup` build on one `planned`. `serve` (gateway.go:1966) is `checkpointReaders`' only caller.

**When the read fails**: unchanged from 0ab41eba — a stale list means the turn goes through; a real one means the vendor's own refusal reaches Codex, instead of magpie's 400.

**Not verified**: a real ChatGPT account whose plan dropped a model mid-conversation; the Routing page as drawn in the GUI (asserted through the trace's `Left`, not against the GUI itself).

**AI**: written with GLM-5.3-Flash (ZCode); I've read the whole diff and can answer questions on it myself.
