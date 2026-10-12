<!--
  Licensed to the Apache Software Foundation (ASF) under one
  or more contributor license agreements.  See the NOTICE file
  distributed with this work for additional information
  regarding copyright ownership.  The ASF licenses this file
  to you under the Apache License, Version 2.0 (the
  "License"); you may not use this file except in compliance
  with the License.  You may obtain a copy of the License at

      http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing,
  software distributed under the License is distributed on an
  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
  KIND, either express or implied.  See the License for the
  specific language governing permissions and limitations
  under the License.
-->

# Antigravity ACP PR 2 acceptance

Implementation scope follows the four PR 2 sets in [issue #5103](https://github.com/apache/maka/issues/5103).
No PR 3 restore or PR 4 mode/catalog lifecycle behavior is implied by these results.

## Official Agent environment

- macOS arm64; official `agy_acp_server` **1.1.1** and its adjacent `localharness_external`.
- Official archive: `https://dl.google.com/agy-extensions/releases/macos/agy-acp-server-agy_acp_server_1.1.1-darwin-arm64.zip`.
- Archive SHA-256: `fdfa915652cdb7ba8085cc8fffed072cbe009251aa2c951aabdda07a8c28a189`.
- Run dates: 2026-09-21–22, Asia/Shanghai.
- Existing authenticated Google session was used successfully. Fresh interactive Google sign-in is
  PR 1 evidence and was **not repeated** in this run.
- HTTP(S) proxy environment variables were supplied for this machine's network. No credentials or
  private project files were included in fixtures or evidence.

## Production Plugin acceptance

Loaded the built ACP runtime and Antigravity adapter through the production Plugin platform and
built-in external-agent coordinator, with Plugin storage bound to a temporary Host data root.
The official Agent performed these checks:

1. Authenticated model discovery; subsequent discovery reused the cached catalog.
2. First prompt used the explicit `gemini-3.8-flash-high` configuration, confirmed by inspection.
3. Created and tested fixture code; emitted text, thinking, tool updates and three authoritative
   file diffs. Permission and structured-question forms preserved the Agent's option identities;
   selecting beta returned option ID `2`.
4. A follow-up recalled a synthetic token; an independent task recalled its own different token.
5. An idle model change was confirmed by the Agent.
6. Cancellation settled the active prompt.
7. After closing/recreating the platform with the same Plugin data, inspection returned
   `history_only`; execution refused to create a replacement external Session.

## Cross-process resume/load feasibility probe

An earlier prerequisite probe on 2026-09-12 used the official macOS arm64 ACP 1.1.1
server/helper, ACP SDK 1.4.0, cached authentication, and a temporary toy project. The
Agent created a Session, edited two fixture files, and the independent fixture test exited 0.
`initialize` advertised `agentCapabilities.loadSession: true` and
`agentCapabilities.sessionCapabilities.resume`.

The probe then terminated the original process tree. It started a **separate fresh process**
for each request, initialized and authenticated it using the cached login, and sent the
original Session ID and the same fixture directory to `session/resume` and `session/load`:

| Request          | Observed result                                                                                                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session/resume` | Succeeded and returned the Session's model/configuration; one `available_commands_update` notification arrived, with no transcript replay observed.                                                                 |
| `session/load`   | Succeeded and returned the Session's model/configuration; 27 replay notifications arrived: one user message chunk, one agent message chunk, 12 tool calls, 12 tool-call updates, and one available-commands update. |

All three owned process groups were gone after cleanup. This summary omits the
Session ID, credentials, and fixture content. The probe establishes that both methods accepted
the previously created Session across process restarts and shows that `load` replays
history. It does **not** establish that a subsequent prompt retains full context, how to
deduplicate replay against Maka's durable events, or how to reconcile a crash between an
Agent update and Maka's persistence. PR 3 must verify those behaviors before enabling
restoration; PR 2 continues to show such tasks as `history_only`.

## Desktop acceptance

Launched the built Electron app against an isolated temporary profile and a fixture project.
The isolation harness used the **real Host execution path**, not the fake native-model backend;
`MAKA_CU_REAL_MODEL_E2E` only selected the isolated profile and bounded native computer-use policy.
The external executor used the official binary and production Plugin bundles throughout.
This Desktop sequence was repeated on 2026-09-22 before the subsequent review fixes
documented below. The latest screenshot pass rechecked model selection without rerunning a coding task.

- Selected Antigravity, browsed all 11 models and selected Gemini 3.8 Flash (High). The review
  follow-up consolidated executor browsing and model selection into one browse-then-commit panel;
  the native Maka model control remains embedded in that same boundary.
- Created a task through the UI. The Agent wrote `add.js` and `add.test.js` and ran Node tests.
  An independent `node --test add.test.js` check also passed (1/1).
- Approved tool permissions and answered the structured alpha/beta question with beta through
  Hosted Forms. The completed transcript recorded the selected answer.
- The rebuilt Desktop task returned `PR2_UI_DONE`; its follow-up recalled `UI_ALPHA_5224` and
  the selected `beta` fixture name correctly. The fixture test independently passed (1/1).
- Changed the model while idle to Gemini 3.7 Flash (High); the menu displayed the confirmed value.
- Started a long response, pressed Stop, and observed cancelled/interrupted settlement.
- Stopped the isolated Host and relaunched Desktop using the same isolated profile. The transcript remained readable;
  the Composer showed process-lost/history-only guidance and a New Task action.

This run found and fixed an integration defect: automatic task naming tried to resolve an executor
as a native LLM connection, which drained the Host and cancelled the prompt. External naming now
uses the first message; unsupported native auxiliary calls fail as configuration errors. Naming and
recap regression tests protect that boundary.

## Earlier rebuild and full acceptance verification

The earlier 2026-09-22 rebuild uses main commit `e6db756890c36a8d4396241cc4f3a6f180529d20`.
Merge conflicts were resolved against main's executor-specific model/reasoning fields and client
model-selection extension slot. Compatibility epoch **179** follows main's epoch 176; PR 2's
three incompatible protocol steps occupy epochs 177–179.
Native model selection, thinking defaults and the distinction between untouched (`undefined`) and
explicit provider defaults (`null`) remain intact.

The official production Plugin acceptance above was **repeated after this rebuild** with official
ACP 1.1.1. All eleven checks passed, including model confirmation, file edits/tests, original
permission/question option identities, multi-turn context, independent tasks, idle model changes,
cancellation and restart history-only behavior. Existing Google authentication was reused.

Local validation at that acceptance checkpoint:

- Clean test build, production renderer build and every workspace type check passed.
- All 13 workspace suites passed: **12,883 Node tests passed, 38 skipped, zero failed**.
  Python: **75 passed, 12 skipped** (87 total). Workspaces ran sequentially.
- After adding the final empty-config/model compatibility edge cases, the complete Host Session
  catalog suite passed again (**67 tests**). The preceding targeted ACP, executor service/backend,
  durable-event mapping and catalog run passed **145 tests**.
- Renderer architecture passed against the exact main base; lint, formatting, Desktop/UI Knip,
  shell hook, locale, ASF header and Windows inventory gates passed.
- Release checks passed (**203 tests**, plus stale-output, notice and metadata checks).

Regression coverage verifies both model input forms, matching/contradictory values, an empty
configuration with an explicit model, unknown models before persistence, model pinning, and
cancellation racing `end_turn`, `max_tokens`, `refusal`, request failure or process crash. The
provider stop reason crosses the service/backend boundary and is stored in the runtime ledger;
timeouts and crashes remain interruption states. Controlled stdio tests also exercise filesystem
and symlink containment, retained identity, helper cleanup and history-only refusal.

## Subsequent review fixes and regression verification

The review found and fixed three execution regressions:

- Selecting a native model through the Composer fallback now clears the external executor.
  The stored native model is not marked as selected while an external executor is active, so
  choosing that same native model also switches back to Maka.
- ACP tool names and titles are sanitized and bounded before projection. Tool lifecycle flags
  advance only after successful event emission, preserving visible tool history.
- A failed or aborted initialization before an external Session exists releases its task state
  and permits retry. Loss of an established Session still remains history-only.

The failing CI protocol declaration referenced epoch 178 after the PR advanced to 179; it now
references 179. Local CI-equivalent checks also found raw controls in the executor picker:
they now use Astryx Button/TextInput, and the surface inventory is regenerated. The executor rail
and selected-model trigger omit the plug icon.

Regression verification after these fixes:

- Clean test build; Runtime **3,514 passed / 14 skipped**, Runtime Host **2,026 / 12**,
  Desktop **2,809**, UI **625**, ACP executor **35**, Antigravity adapter **4**:
  **9,013 passed, 26 skipped, zero failed**. The final layout change reran the complete UI and Desktop suites.
- Native-selection, initialization-retry and long/control-character tool metadata tests reproduce
  the failures before the corresponding fixes.
- Production renderer build, stale-output check, workspace type checks, Desktop/UI Knip,
  lint/format, ASF headers, locales, shell hooks and Windows inventory passed.
- Exact-base protocol epoch and renderer architecture checks passed, together with their
  **17** and **112** checker tests; the Astryx inventory and its **19** tests passed.

## Unified model and thinking selection

Maka retains main's connection groups, provider icons and single-line native model names.
Gemini icons remain present; Antigravity has no plug icon or synthetic Agent default option.
Thinking intensity is selected exclusively beside the model trigger in the composer footer.
Native models still use their native thinking parameter. External models use the exact opaque
variant ID returned by ACP; the generic UI consumes structured catalog capabilities and has
no Gemini naming rules.

The Antigravity adapter recognizes only the verified Gemini Flash/Pro `(High|Medium|Low)`
label shape. A family with at least two unambiguous levels appears as one base-model row.
Selecting that row automatically selects its **highest supported level**, regardless of the
previous model's intensity. Afterwards the footer permits choosing only actual supported levels.
The external model replaces the native model trigger; there is no pending model caption,
extra native model, Cancel action, invented default, or invented off level. Unknown, singleton
and ambiguous families keep their original model rows without a fabricated thinking control.
Merely browsing or reopening the panel does not change configuration.

For existing sessions, UI state advances only after the Host confirms the requested model ID.
A failed or unconfirmed request restores the previous real ID and requires an ACP acknowledgement
before allowing retry. If rollback cannot be confirmed, or the process is lost, the existing
history-only restriction remains. Selection and prompt execution cannot overlap. Catalog updates,
scope changes, reopening a menu, and retained sessions use the same confirmed model mapping.
New-task selection validates a real ID against the ready catalog; ACP applies and confirms that
ID when the first prompt creates the session.

### Official ACP and Desktop verification

The official 1.1.1 server returned 11 model variants: Gemini 3.8, 3.7 and 3.6 Flash each with
Low/Medium/High, plus Gemini 3.1 Pro with Low/High. These form four base-model rows.
Its initial current model was `gemini-3.7-flash-high`; no per-family default was supplied.
Actual `session/set_config_option` responses confirmed `gemini-3.8-flash-medium`,
`gemini-pro-agent` (Pro High), and `gemini-3.1-pro-low`. No IDs were synthesized.
The separate ACP mode option was not interpreted as thinking strength.

On 2026-09-22 the rebuilt Electron renderer was checked with an isolated fixture profile:

- Native provider icons, single-line rows, search, and composer thinking remained intact.
- Selecting Flash replaced the native model with Antigravity / Flash and automatically chose High.
  Its footer listed only Low/Medium/High; a manual change to Medium survived reopening the list.
- Switching to Pro automatically selected High and listed only Low/High in the footer.
- A real Pro High task returned `THINKING_UI_OK`, with `gemini-pro-agent` in the transcript.
  While running, model selection was disabled. An idle footer change to Low was acknowledged;
  the session summary then carried `gemini-3.1-pro-low` and the footer displayed Low.
- No native prompt or full coding task was repeated in this screenshot pass.

### Regression verification

Affected suites passed: Core **887**, Runtime **3,514 / 14 skipped**, Runtime Host
**2,027 / 12 skipped**, Desktop **2,809**, UI **633**, ACP executor **37**, and Antigravity
adapter **9**: **9,916 passed, 26 skipped, zero failed**.
Coverage includes complete/partial levels, unsorted capabilities, opaque IDs, unknown and
ambiguous families, highest-level selection, failed confirmation and rollback/retry, idle
catalog notifications, same-model verification, session scope races, execution locks, native
model reselection and executor switching.

Production renderer build, Desktop type checks, renderer architecture, Desktop/UI Knip,
lint/format, ASF headers, locale hygiene, Astryx inventory and stale-output checks passed.
Structured model-group/provider capabilities advance the protocol to epoch **180** at this
independent implementation checkpoint. The browser-safe declaration is pinned to the same epoch.

The four failing checks on `def615305` all reported an unresolved `modelChoiceDescription`
in the synthetic merge with main: main removed the wheel helper import, while the PR's new
panel still referenced it. Integration with current main removes this obsolete helper dependency
altogether. The panel searches the catalog's existing description/cutoff fields directly;
main's native row and wheel formatting remain unchanged. The delivery merge also preserves
main's epoch-177 external-session workspace change and advances the combined protocol to
**181**, with the browser-safe compatibility declaration pinned to 181.

## Delivery integration with current main

Integrated main at `0052f1cfd517abb0d3fab6cefa6f80a592b55589`, preserving its native model
formatting and external-session workspace protocol. The combined epoch is **181**.
The model-panel import failure is resolved in this actual merged source, not just on the PR head.
A clean test build, production renderer build, all workspace type checks, renderer architecture
against that main commit, Desktop/UI Knip, lint/format, ASF/locale checks, Astryx and Windows
inventories, shell-hook checks and the 17 protocol checker tests passed.

All 13 workspace suites passed after rechecks: **12,995 Node tests passed, 38 skipped**.
The first complete run had two intermittent failures (owned-candidate shutdown timing and a
context-offload lease assertion). Both focused checks and both complete affected suites passed
again without source changes: Host **2,033 / 12 skipped**, Storage **1,411 / 8 skipped**.
Release checks passed **203 tests**, plus their prerequisite metadata/notice/stale-output gates,
when run serially after the suite workload. The earlier concurrent release run hit a Node test
worker deserialization error and a real-Host shutdown timeout; these did not recur serially.

## Catalog-loading extensibility follow-up

The Host appends setup placeholders from its built-in external-agent catalog only when a
registered Plugin has not supplied that executor ID. The composer no longer names Antigravity
while loading; the shared picker displays a generic loading status until catalog data arrives.
A live Plugin catalog replaces the placeholder without a UI-specific fallback. Targeted Host
and picker tests cover placeholder precedence and the loading-to-ready transition. Storybook
smoke covers the loading and ready states. The PR description uses the full-window real Electron
captures below for UI evidence; the loading state is not pictured there.

## Earlier real Electron UI screenshots

Captured on 2026-09-22 from the production renderer in a real Electron Desktop window with the
official ACP 1.1.1 catalog. Screenshots are GitHub attachments only; no binaries are committed.
The native connection is an isolated fixture.

### Base models with Gemini icons

![Four Antigravity base models with Gemini icons](https://github.com/user-attachments/assets/359c589b-8500-4524-b396-faf35449a24d)

### Flash thinking in the composer

![Only the external model and actual Flash thinking levels in the footer](https://github.com/user-attachments/assets/94704904-c034-45d2-9e59-21f7b3025be2)

### Pro thinking in the composer

![Pro offers only its supported Low and High levels](https://github.com/user-attachments/assets/53defac2-e25a-4101-b12a-325e631b717c)

### Maka native model format

![Native model rows retain main formatting and footer thinking](https://github.com/user-attachments/assets/9074a33d-3fb3-42ae-8efc-24186b0f3c72)

The earlier completed-task capture remains
[historical execution evidence](https://github.com/user-attachments/assets/4fc2827b-feed-4639-9a6a-d50caf203055),
not a claim about the current picker or a repeated coding run.

Public CI and independent human approval passed before PR 2 merged as #5224 on 2026-09-23.
Issue #5103's PR 2 checklist is complete. Unknown future label shapes remain raw models until
verified. Cross-process restoration belongs to PR 3; modes and expanded catalog lifecycle belong
to PR 4. Neither is claimed by PR 2.
