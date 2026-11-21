**Independent verification of @wrke1990's `77e9f7bd` — rebased onto today's main, every check below re-run on this window's head.**

Main moved repeatedly during the review window (a large batch landed mid-verification) and the range touches several of the patch's files, so I rebased the cherry-pick onto main `7c900f46` with the authorship preserved (wrke1990 stays the commit author; it applied cleanly, no conflicts, at both window tips). Reviewed as a cherry-pick of wrke1990's `77e9f7bd`, verified independently on Windows (Go 1.26.8 via `GOTOOLCHAIN=auto`), reading the whole diff.

Branch with the commit (cherry-pick, authorship preserved): [hunt99/a](https://github.com/ggbdpq/magpie/tree/hunt99/a) (head `e24c1195`).

| Check | Result |
| --- | --- |
| RED — the six product files reverted to the base `7c900f46`, tests kept | all three new/strengthened tests fail with real assertions: `TestResponsesInstructionRolesThroughSearch` (developer and system — "instruction item moved into the prefix"), `TestResponsesInstructionsOtherAPIsUnchanged` (chat, anthropic and gemini each diverge from the legacy mapping, got/want in the log), `TestCodexSearchAnsweredOnResponses` ("search round 1 changed instruction authority": the Default item arrives as a `<system-reminder>` user text) |
| Same tests with the patch, on `e24c1195` | `ok` together with the untouched guards `TestCodexLaterDeveloperMessageKeepsTheSystem`, `TestCodexThreadKeepsItsClaudeRunAcrossAMemoryCall`, `TestSearchOfferedStaysOnTheClientsAPI` (6/6 green) |
| Byte-identical probe — a translated Responses turn with no instruction items (web_search offered, custom Responses-only provider), upstream body SHA-256'd | identical `3318a8fb…` at the parent and at the patched head, on both base windows: no wire change for ordinary requests, hence no cache or affinity drift. The probe body differs from wrke1990's earlier capture because today's main fills a deterministic `prompt_cache_key` by default — it appears on both sides and hashes the same |
| Consecutive instruction items | stay separate and in place: `mergeTurns` now merges only user/assistant neighbors, and the test pins input positions 0+1 and 4+5 verbatim |
| Fallback from Responses to another API | `anthropicBody`, `buildChat` and `buildCodeAssistSent` (and `buildGemini`, which builds through `buildCodeAssistSent`) apply the legacy mapping via `responseInstructions`, which copies the request (`out := *r`) and rebuilds `Messages` — the native request is not mutated, asserted by the before/after `buildResponses` check in `TestResponsesInstructionsOtherAPIsUnchanged` |
| Claude subscription path | untouched: `keepInstructions` is passed `true` only in `translate`, and only where the target is Responses (`parseRequest(from, body, false, to == provider.Responses)` and the search-reroute re-parse); every other caller (`parse`, `parseIn` — Claude bridge, subscription, usage, memo) keeps `false`; the two cache guards above are unmodified and green |
| Ordinary requests off the hot path | `responseInstructions` returns the request unchanged (no copy) when no system/developer message is present; `mergeTurns` is behavior-identical for user/assistant-only sequences — the added cost is one O(n) role scan |
| `TestClaudeMemRunsFromTheCgroup` / `TestClaudeRunsMostTheUsersOwn`, standalone | each times out with and without the patch on this Windows box (`-timeout 240s`: no output before the alarm, measured at the previous window's parent `58fb3a77` and its patched cherry-pick — the rebased commit is the same change) — claude-subscription tests don't complete here, an environmental hang, not the patch |
| `internal/gateway` suite (`-tags nogui -count=1`) | cannot complete on this box: the two claude-subscription tests above stop the run (the 40-minute wall reached with no test failed before it, measured at that same pair); the complete suite's green stands on wrke1990's macOS run (427.556s) |
| gofmt (CRLF-normalized per file) and `go vet -tags nogui` (windows, linux, darwin) | clean |
| Builds (native, `CGO_ENABLED=0 GOOS=linux`, `CGO_ENABLED=0 GOOS=windows`, each `-tags nogui`) | ok |
| Targeted `-race` | not runnable on this box (no C toolchain, cgo build fails); wrke1990 reports it green on macOS arm64 |

Note on the probe: it is a throwaway test (not part of the patch), and its body differs from wrke1990's earlier capture because of the default `prompt_cache_key` noted above — the point is before/after identity on the same build, which holds.

**Scope**: the patch deliberately leaves the Claude subscription mapping from #502 alone — whether a mid-thread replacement (a mode switch) should also outrank its predecessor on translated Claude/Chat/Gemini routes remains the maintainers' call. On the Responses wire it closes the third route from the October 26 comments (`searchedForIt` silently selecting translation for a Responses upstream), for both plain turns and search continuation rounds.

@yetone rebased and re-verified on `e24c1195` today; the landing call is yours.

written with GLM-5.3-Flash (ZCode)
