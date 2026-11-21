Verified the combined commit (`d5b46244`) locally — cherry-picked onto `main` (`63be4771`), exercised through the gateway's in-process fake only, no real account touched.

**Attribution checks out.** The commit carries both trailers, verbatim:

```
Co-authored-by: ggbdpq <ggbdpq@gmail.com>

Co-authored-by: realfirst <174605+realfirst@users.noreply.github.com>
```

**Fidelity.** Byte-for-byte identical to their sources: `withReasoningOnToolTurns`'s move-and-strip body and comment (from 130b761b), the `deepseekAliasSerde` fake and `TestChatToolTurnReasoningCarriedOnce` (from 130b761b), and `foldReasoningAliases`'s function body (from 84c2b3a). Adapted, none of it functional: the docs line merges both patches' wording; `TestChatBothReasoningSpellingsRelayed` runs against `deepseekAliasSerde` instead of the extended `deepseekRefuseToolTurns` (84c2b3a's duplicate-field refusal inside that shared fake is not carried — the switched fake covers the same detection); `foldReasoningAliases`'s comment is shortened. A true combination of both halves, not in name only.

**Ablations** (tests kept, product files reverted one half at a time):

| State | `TestChatToolTurnReasoningCarriedOnce` (tool turn) | `TestChatBothReasoningSpellingsRelayed` (non-tool) |
| --- | --- | --- |
| combined | PASS | PASS |
| fold call removed (tool-turn half only) | PASS | FAIL — `400 … duplicate field \`reasoning\`` |
| tool-turn strip removed (fold only) | PASS | PASS |
| both removed | FAIL — `400 … duplicate field \`reasoning\`` | FAIL — `400 … duplicate field \`reasoning\`` |

The red lines are the issue's exact shape, e.g. `400 after 1 calls: … messages[1]: duplicate field \`reasoning\` at line 1 column 70565`. Restored, all six regression tests pass again.

One asymmetry worth recording: with the tool-turn half removed, **all six committed regression tests still pass** — the fold alone covers every committed test, including `TestChatToolTurnReasoningCarriedOnce` (the injection still copies, then the fold deletes the echoed `reasoning`). What only the tool-turn half contributes shows on a wire probe — a tool turn whose thinking the client echoes in `reasoning_details`: fold-only leaves `reasoning_details` standing beside the injected `reasoning_content`, the combined form strips it. Neither parent patch added a regression test for that face, so in this combined commit the tool-turn half is the only half whose remaining unique contribution no committed test locks.

**Five-facet probe on the combined form** (the assistant message the upstream receives):

| Facet | Received |
| --- | --- |
| tool turn echoing `reasoning` | `reasoning_content` only |
| tool turn echoing `reasoning_details` | `reasoning_content` only |
| tool turn with own `reasoning_content` + echoed `reasoning` | `reasoning_content` only |
| non-tool message carrying both spellings | `reasoning_content` only |
| non-tool message with `reasoning_content` + `reasoning_details` (no `reasoning`) | **both fields pass through unchanged** |

So the gap noted above is unchanged in the combined form: a non-tool message carrying `reasoning_content` + `reasoning_details` is rewritten by neither half, and whether a DeepSeek-style serde reads `reasoning_details` into the same field remains unverified.

**Landing.** `d5b46244`'s parent sits 474 commits past `63be4771` (its merge-base with `main` is `63be4771` itself, strictly an ancestor). Cherry-picking onto `63be4771` conflicts in `internal/gateway/chattidy.go` and `docs/subsystems/gateway-routing.md`: the fork's base carries later upstream work that `main` doesn't have yet (the #2599 silent-assistant rule, in both files). Plain `git apply --check` of the original patch fails on the same two files; `--3way` reports conflicts there too. It lands after a small resolution — keep `main`'s structure, insert only the two #3165 halves, drop the not-yet-upstream blocks the merge drags in. Post-resolution on `main`: the six regression tests pass, `go test -tags nogui ./internal/gateway -run Reasoning -count=1` passes, `gofmt -l internal/gateway` clean, `go vet -tags nogui ./internal/gateway` clean including `GOOS=linux`/`GOOS=windows`. The whole gateway package (`-tags nogui`, `-timeout=25m`) finishes on this Windows machine with four failures, each reproduced identically on vanilla `63be4771` and all environmental, nothing in the changed area: `TestClaudeAsRootEnv` (expects an `IS_SANDBOX` env this machine doesn't set), `TestSweepBridgeProjectsTakesOnlyTheBridgesFolders` (Windows symlink privilege), `TestCommandCodeGoSaysTheAgentsFolder` and `TestPluginToldWhereTheAgentWorks` (this machine's temp dir is misdetected as inside a git repo). Everything in the reasoning/Chat-relay area passes. Run here as well: the Reasoning family under `-race -count=1` (CGO enabled, the local mingw64 toolchain) — `ok`, 39.7s, matching the `-race` pass the commit message claims. Still not run: the real upstreams (the issue's engine, the JD Cloud relay, api.deepseek.com).

Thanks for doing the combination — it settles the "either half fixes the reported failure, the halves are complementary" question from the thread, and whoever lands it gets both faces plus the docs in one commit. The one thing left open is the `reasoning_details` row above.

Verified with AI assistance (GLM-5.3-Flash via ZCode); I've read the diff and re-ran the checks above.
