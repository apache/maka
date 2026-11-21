I claimed this issue earlier for independent verification — now standing down: [@skygunner](https://github.com/skygunner)'s branch covers it. I verified his fix independently instead of opening my own. Verdict: **the mechanism is correct and every ring of his description checks out, but his branch predates #1475 and conflicts with one existing test when merged to the current tip** — needs a rebase plus an explicit decision on that test, so I'm handing the evidence to the maintainers instead of a full endorsement.

## Mechanism, ring by ring (read from the full diff of 91625dca)

| Claimed | In the diff | Verified |
| --- | --- | --- |
| A choice that delivered no calls ends `stop` when upstream ended `tool_calls`, streamed and whole | `chatTidy` adds `finish=="tool_calls" && !called → stop`; `chatWhole` adds `known && len(native)==0 → stop` | Yes — ablation-red below proves the phantom relay is the pre-fix behavior |
| Streamed state kept per choice | Uses the existing `t.called[choice]` map; `TestChatPhantomFinishPerChoice` pins two choices finishing in one chunk, in reverse order | Yes |
| Real native calls keep `tool_calls` | `chatWhole`'s upgrade now `known && len(native)>0`; the stream side keeps its `called` upgrade | Yes — `TestChatPhantomFinishKeepsRealCalls/native` (stream+whole) |
| Calls parsed from text (textCallTidy, after chatTidy) still end `tool_calls` | `chatTidy` downgrades first, then `textCallTidy` re-upgrades to `tool_calls` when it parses a block; on the whole side `wholeTextCalls` writes the calls before `chatWhole`'s downgrade runs | Yes — `text_parsed` stream+whole sub-tests pin exactly this ordering gap |
| Unreadable `tool_calls` value left as it came (unknown) | `chatWhole`: `known := !has \|\| decodeJSON(...)==nil`, unknown falls through both branches | Code is there; **no test fixture exercises a decode failure** — not verified |

Plus one change he didn't list separately: the streamed empty-array drop widens from `== "[]"` to *decodes as JSON and has no elements*, so `null` and `[ ]` are dropped before delivery and no longer recorded as a call in the per-choice "called" state.

## Verification

| Check | Result |
| --- | --- |
| His new tests at the fix (my run, 3-way onto `upstream/main` `e17b6cefc`) | `TestChatPhantomToolFinish` 16 sub-runs (absent / `[]` / null / `[ ]` × with/without tools × stream/whole) PASS; `TestChatPhantomFinishKeepsRealCalls` (native/text-parsed × stream/whole) PASS; `TestChatPhantomFinishPerChoice` PASS; `TestChatCallsEndToolCalls` PASS |
| Ablation (his new tests kept, `chattidy.go` reverted to tip) | RED confirmed: all 8 streamed phantom sub-runs + `TestChatPhantomFinishPerChoice` FAIL with `finish "tool_calls", want stop`; keeps-real-calls stays green — the tests do catch the reported phantom finish |
| textCallTidy ordering boundary (chatTidy before text parsing) | Pinned by tests, both surfaces: stream (`chatTidy` downgrades, `textCallTidy` re-upgrades) and whole (`wholeTextCalls` before `chatWhole`'s downgrade) |
| Full package: `go test -tags nogui -timeout 25m ./internal/gateway/...` | One failure: `TestToolCallsFinishWithNoCallsStaysWhole` — **introduced by this fix's intent, not pre-existing** (green under ablation); every other test passes (~11.5 min) |
| gofmt / `go vet -tags nogui ./internal/gateway/` | clean / exit 0 |

**The blocker.** `TestToolCallsFinishWithNoCallsStaysWhole` (in `chat_call_name_test.go`, from #1475, commit `82ff88933`, landed 2026-10-31) pins the old behavior: a whole reply that came with no calls at all keeps its `tool_calls` finish as it came (`content:"Done."`, no calls → finish stays `tool_calls`). That is precisely the behavior #3684 asks to change. His branch is based on `19253f67b` (2026-10-26), five days before #1475 landed, so his full-package run couldn't see this test. Merged onto the current tip, the fix turns that test red (`finish "stop"`, wants `"tool_calls"`).

Resolving it is a decision I shouldn't make on the author's behalf: either the test's expectation moves to `stop` per #3684, or #1475's conservative "a reply that came with no calls keeps its finish" carve-out survives for content-only replies and the downgrade is scoped tighter. Either way it needs @skygunner to rebase onto a tip containing `82ff88933` and update the branch, or maintainer arbitration. (For the record, no upstream commit references #3684 yet, and his branch head hasn't moved — re-checked today.)

How I merged it for testing (throwaway tree, not pushed): kept #1475's switch and appended his downgrade as an `else if` on `!t.called[choice]`; merged his doc sentence into the rewritten gateway-routing bullet; reconciled the "(a reply that came with no calls keeps its finish)" wording that his change contradicts.

Not verified: a decode-failure fixture for the "unknown stays as it came" ring; any real opencode-zen-free traffic (same as the author — fixtures are the wire shapes from the report's log, through the real HTTP stack).

Branch: [skygunner/magpie `fix/r25-empty-tool-calls-finish`](https://github.com/skygunner/magpie/tree/fix/r25-empty-tool-calls-finish) (head `91625dca0bb33ee696be639e659bdf4c8f1b6abd`, base `19253f67bca2310c32739a6eaac88546b3574dbc`)

Thanks @Terryli246 for the report and @skygunner for the fix branch.

AI use: verification performed with AI assistance; all commands and outputs above were run and read locally.
