Yielding to @skygunner's branch — I took this issue earlier only to verify their fix independently, and it verifies. No patch from me; this is a verification endorsement.

## Mechanism, claim by claim

| skygunner's claim | What the code does | Verified |
|---|---|---|
| The guard only read turns that had results: `exchanges`/`exchangeOf` stop at a turn with no tool result, and `mayLoop` parsed only a body holding 8 tool results | True of `upstream/main` before this branch; the ablation below reproduces the gap (8/8 red) | yes |
| `toolLoopUnansweredOf` walks the request's own messages back from the newest and counts the calls asked in a row with no result after them, same name and arguments, call ids ignored | Key is `Name + "\x00" + steadyArgs(Args)` (argument key order normalized, `ID` never read); a non-assistant message carrying parts (a result or a word from the user) breaks the walk; a turn asking a different call breaks it; a reply that says something breaks it; a reasoning-only turn in between does not | yes |
| Eight in a row answer the turn in the agent's own protocol, with a notice that says the result never came back (nothing claims the call did not run), and the turn goes nowhere | The `unanswered` branch of `why()`/`notice()` says "no result came back" / "never sent back a result … nothing says whether the call ran"; the turn exits through the existing `answeredHere` path, so the Routing trace is the same "Tool loop stopped" and the usage row is provider `magpie`, rejected, error starting `tool loop:` (the test asserts all of it) | yes |
| No new setting and no new string: Settings › Models › Replies › Stop looping replies turns it off with the reply guard | No settings/GUI/i18n change; the notice text is in-agent, not a GUI string; the off switch is the existing `noLoopGuard` | yes |
| `mayLoop` reads a body with 8 tool calls as well as 8 tool results, matched loosely | `toolCallMarks` counted alongside `toolResultMarks`; a mark that also matches a result only costs an extra parse, it cannot change the verdict (the verdict is `toolLoopOf`/`toolLoopUnansweredOf`, both reading parsed messages) | yes |

## Verification (all run locally on darwin/arm64, tip `e17b6cefc`)

| Check | Result |
|---|---|
| 3-way am of `125a5e08` onto current `upstream/main` tip | Applied; one conflict, and it is a side-by-side addition: tip has since added the wait/poll exemption (`allWaits`/`isWait`, "a turn whose calls are all waits is never a loop") at the same spot. Both blocks kept, the fix's semantics untouched |
| `TestToolLoopStuckWithoutResults` (RED before, GREEN after) | RED: with `tool_loop.go` reverted to tip and the test kept, all 8 protocol subtests fail with exactly "the agent wasn't told of the loop in its API" — the vendor's reply reaching the agent. GREEN after: 8/8 subtests pass (Responses stream + whole, Codex, Chat stream + whole, Anthropic stream + whole, Gemini), 7 turns go on, the 8-turn turn stops with the vendor asked 0 times, usage row `magpie`/rejected/`tool loop … no result` |
| `TestToolLoopStuckNeedsTheSameCallAndNoWord` | Passes: differing arguments pass through, a word from the user between the calls passes through |
| Full `-run 'TestToolLoop'` set on the am'd tip | 40 tests, 0 failures (including tip's own `TestToolLoopLetsWaitsBy`, so the wait exemption survives beside the new check) |
| Full package `go test -tags nogui -count=1 ./internal/gateway/` | **Clean: exit 0, 0 failures, 706s.** The five base-reds in the branch's own notes (`TestClaudeClientCacheAbsentUnchanged`, `TestCodexFittedImagesPastTheBudget`, `TestMarshalRawIsEncodingJSON`, `FuzzMarshalRaw`'s `\u2028` escaping, `TestServeWSLListensBesideLoopback`) did not reproduce on today's tip on this machine — that second full run their notes left unfinished is now done, green |
| Reset conditions | Pinned by tests for differing arguments and a user's word; a **result** resetting the count has no dedicated test case — I pinned it with a throwaway white-box probe (a result after turn 4 of 10 resets; alternating names never count as one call; differing call ids are ignored; a reasoning turn in between does not reset; 7 turns stay under the threshold). All pass |
| Over-blocking edge (legit repeated same-name calls) | A retry or poll only counts when its result never comes back *and* the arguments are byte-identical: any result resets the count, any argument difference resets it, and tip's `allWaits` exemption already covers answered waits in the result-shaped check. Only a client that asks the same call 8 times and sends back no result at all is stopped — that is the #3615 shape itself. One observation for the maintainer: the unanswered check has no wait exemption, so `sleep(60s)` asked 8 times with results never sent back would stop too; the wait exemption's premise ("answered the same by design") does not hold in that shape, and a normal client always sends a wait's result back, so I do not read this as a defect — leaving it as a recorded observation |
| `gofmt -l` (both touched files, also via `tr -d '\r'`) | Clean |
| `go vet ./internal/gateway/` and `GOOS=windows go vet ./internal/gateway/` | Both clean |
| Freshness | `upstream/main` has no commit mentioning 3615; not merged yet |

Branch: [skygunner/magpie `fix/3615-loop-guard-does-not-cover`](https://github.com/skygunner/magpie/tree/fix/3615-loop-guard-does-not-cover) (head `125a5e087ef882a6223dff6645589b0ee33cdbd6`)

Not verified: a real zcode session against the reporter's 1088 routing entries (not available; the fixtures carry the shape their numbers describe), and Windows itself.

Thanks @easonlao for the report and @skygunner for the fix branch.

AI use: verification performed with AI assistance; all commands and outputs above were run and read locally.
