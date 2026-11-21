Yielding on this one — the reporter's fix branch covers it, and I verified it locally rather than opening a competing patch. Everything below was run on my machine against the branch applied onto current main.

**The fix, gate by gate** (read against the diff, and against `rg -n 'phaseTidy|responsesEncoder|codexPhase' internal/gateway/`):

| Gate as described in the issue | In the branch |
| --- | --- |
| `passthrough` builds `phaseTidy` for Codex's requests alone | `if proto == provider.Responses && codexPhase(r)` — yes |
| `responsesEncoder` gets a `phase` switch (`Request.phaseClient` = `codexPhase(r)`, set in `streamTranslated` and `relay`); when false it writes no phase and doesn't hold the message's `output_item.done` | `continuation.go` + `claude_subscription.go` set it; `makeEncoder` passes `phase: r.phaseClient`; `release` writes the field only when `e.phase`, `closeAs` holds only when `e.phase` — yes |
| Non-streaming `renderResponses` under the same gate | `render` passes `r.phaseClient`; `phaseOutput` runs only when true — yes |
| No out-of-scope changes | 11 files: 6 production (`gateway.go`, `continuation.go`, `claude_subscription.go`, `ir.go`, `responses.go`, + the doc), 5 test files — matches the write-up |

**Verification** (branch applied to 6d1e3f1e2, upstream/main tip, with `git am -3`; the branch sits on f982e46f2, ~1100 commits back — it applied clean, no conflicts):

| Check | Result |
| --- | --- |
| Reporter's tests: `TestTranslatedMessagesSayPhase`, `TestRenderedMessagesSayPhase`, `TestRelayedStreamSaysPhase`, `TestOtherClientGetsNoPhase`, `TestMuseClientStreamHasNoPhase` | PASS |
| Local probe (mine, gateway-level, the translated path the issue is about: chat/completions upstream answering `/v1/responses`): Muse's own User-Agent → no `"phase"` anywhere in the stream and the message's `output_item.done` arrives before the function call is added (no hold); Codex UA on the same upstream → `commentary` still written | PASS (probe kept locally, not added to the branch) |
| Ablation: production files reverted to pre-fix behavior, tests kept — the three non-Codex tests above all FAIL, with `"phase":"commentary"` back in the stream sent to Muse; the Codex-side tests stay PASS | red before the fix, green after — the tests lock the behavior |
| Full `go test -tags nogui -timeout 25m ./internal/gateway/...` on the am'd tree | PASS (642s, exit 0) |
| `go test -race` (Phase/Relayed/probe streaming tests) | PASS |
| gofmt (`tr -d '\r'` per changed file) / `go vet -tags nogui ./internal/gateway/` | clean / clean |

**Boundary checks:**

- Other strict Responses clients get the same relief: any request without Codex markers (`fromCodex(r.Header)` / `agentOf(r) == "codex"`) writes no phase and no hold — covered at gateway level by the Muse-UA tests and at encoder level by `TestOtherClientGetsNoPhase`.
- Codex folding is kept: phase still written for Codex on the passthrough (`TestRelayedStreamSaysPhase`), and on translated/relay streams per the branch's own tests plus my probe.
- Two edge observations, neither a blocker, for the maintainer's eye: (1) in `translate()`, the **non-streaming** branch (`stream=false` → `forwardTranslated` → `renderUsage` → `render`) never sets `Request.phaseClient` — only `streamTranslated` and `relay` do. A Codex request arriving non-streaming on the translated path would now get no phase where #2437's `phaseOutput` used to write one unconditionally. Codex itself streams, and I found no live non-streaming Codex translated request, so I saw no practical harm; a one-line `request.phaseClient = codexPhase(r)` at the top of `translate()` would close it. (2) `writeLocalText` (the tool-loop local reply, through `relayStatus`) also leaves `phaseClient` unset; its locally generated message used to carry `"final_answer"`. No hold is involved there (the events are magpie's own, in order), and a phase-less message is the pre-#2437 shape Codex always read fine.

**Not verified:** a real `muse exec` replay — no Muse Code on this machine; the reporter covers that with their byte-accurate replay (fails before, `completed` after).

Branch: MRQC-st/magpie@muse-phase-fix (head b4a2ffbf40a45289298b393351181ba70b893059, single commit on f982e46f2; applies cleanly onto main at 6d1e3f1e2).

AI use: verification performed with AI assistance; all commands and outputs above were run and read locally.

Thanks @MRQC-st for the report and the fix branch.
