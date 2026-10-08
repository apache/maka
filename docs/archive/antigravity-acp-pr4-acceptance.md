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

# Antigravity ACP PR 4 acceptance

PR 4 follows [issue #5103](https://github.com/apache/maka/issues/5103).
This record separates controlled protocol fixtures from official Agent results.

## P3 stable-directory and invalidation follow-up, 2026-10-02

Tested implementation commit: `4fefdc1e7fae53bcc2e8412c03be5eadd9e0de4b`.
Registered ACP adapters now use stable Plugin-storage scratch paths, keyed by the
Host data root, Plugin namespace, adapter ID and composition Entry. The Host reuses
its existing native file lifetime leases; no additional native dependency is bundled
into the ACP Plugin. Leases cover Agent process disposal and directory cleanup.
Standalone `AcpExecutor` embeddings reuse a temporary path within their lifetime;
a durable embedding must provide `withCatalogDirectory`.

The official Agent 1.2.1 recheck used the production executor, transport and
Host scratch-directory implementation. A transparent request observer recorded
three actual `session/new` requests: initial discovery, explicit refresh and discovery
after disposing/recreating the executor and its Host data runtime. All three requests
used the same canonical neutral path; each started empty and its directory was removed
after discovery returned. The shared A/B cache and refreshed replacement snapshot
checks passed. All catalogs were ready and contained the same 11 models and three modes
listed in the preceding-head record below. The two toy project directories stayed empty.

A second check installed the actual production ACP/Antigravity Plugin bundles through
`HostBuiltinExternalAgentPluginCoordinator` and queried `PluginExecutorService` against
that official executable. Initial A/B queries opened one probe; a forced refresh opened
one replacement. Both probes used the same leased path, with namespace
`antigravity-acp` / `profile`, and both started empty and completed cleanup. No protocol
fixture or mock Agent was used in these official checks. No task prompt was sent.

Regression coverage passed 286 tests without skips or failures: 97 ACP/Antigravity
and 189 affected Runtime/Host tests. It includes multi-waiter invalidation without a
refresh query, repeated invalidations, cancellation/disposal, non-retryable genuine
failures, stable paths across runtime replacement, namespace/key separation, directory
cleanup on callback failure, public Plugin storage namespace propagation, competing
runtime instances and a competing child process killed while holding a native lease.
Removing the revision fix makes the invalidation regression fail; restoring random
per-probe paths makes the stable-path regression fail. Positive tests pass with both
fixes restored.

The complete workspace build, typecheck, lint, format, renderer architecture, locale
hygiene, ASF headers, Windows skip inventory and diff checks passed. Full workspace
unit/e2e tests were not repeated locally. Official observer logs and JSON results are
retained in the local run directory `pr5826-p3-acceptance-2026-10-02`; the tested source
commit is recorded in the JSON result.

This check does not inspect or delete Agent-private history and does not establish
that its native UI groups history by cwd. Stable cwd eliminates per-probe path churn;
the Agent may still keep empty Sessions. Desktop steps 1–4 below were tested on the
preceding implementation, and steps 5–9 remain historical execution/recovery evidence,
not fresh Desktop acceptance for this P3 follow-up.

## Preceding-head neutral probe and Desktop acceptance, 2026-10-02

The verification gate for the neutral-directory catalog follow-up passed on exact code
head `82d6b12b695a2967f2e907915afb817ff5087f9b`. This run covers acceptance steps 1–4;
prompt execution and restart steps 5–9 were not repeated and remain historical evidence
for the earlier builds recorded below.

Environment: macOS arm64, Node 24.19.0, Electron 43.4.1 and official Agent 1.2.1.
The server SHA-256 was `c93c86c0f505fcdf8b13c695bed26d306141ef5446189d591397074d324db34e`;
the helper SHA-256 was `1b8a2b712ca312c9769e425b800bfbcceec4770f19736404474d1e8e50d65456`.
Desktop was freshly built from this head and launched as an ad-hoc-signed `Maka Dev.app`
in the dedicated profile alias `neutral-acceptance-2026-10-02`. Existing Agent authentication
and network settings were retained. Only empty disposable projects were selected.

The production `AcpExecutor` used the official server and helper, with a transparent
request observer that delegated every request and cleanup to the real connection.
Both initial discovery and refresh initialized Agent version 1.2.1, protocol 1, and
returned `ready`. Actual `session/new` requests used empty neutral temporary directories
with suffixes `maka-acp-catalog-BqUc4Q` and `maka-acp-catalog-TirUh5`; neither used project A
or B. Both directories were absent when the respective discovery returned, and both
project directories remained unchanged. The initial A/B queries returned the same catalog
object; refreshing A replaced it, and the next B query returned that replacement object.
Exactly two probe Sessions were opened by this sequence.

Both catalogs contained these model IDs:
`gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`,
`gemini-3.7-flash-high`, `gemini-3.7-flash-medium`, `gemini-3.7-flash-low`,
`gemini-3.6-flash-high`, `gemini-3.6-flash-medium`, `gemini-3.6-flash-low`,
`gemini-pro-agent`, and `gemini-3.1-pro-low`.
Mode IDs were `default`, `auto_edit`, and `yolo`; the probe default was
`gemini-3.8-flash-high` / `default`.

| Desktop step | Result | Observed evidence |
| --- | --- | --- |
| 1. Configure Agent | PASS | The real macOS picker accepted both the extracted directory and `agy_acp_server.par`. Missing-helper and missing-server directories produced their respective localized errors. The saved runtime-policy executable remained the original official path, and connection and Google sign-in verification succeeded afterwards. |
| 2. Discover B | PASS | Both empty projects were added through the native folder picker. B showed Gemini 3.8/3.7/3.6 Flash and Gemini 3.1 Pro families, plus Default/Auto Edit/YOLO. B selected Gemini 3.7 Flash, High, Default. |
| 3. Refresh A | PASS | B → A succeeded. Retry entered its loading state and completed with the model candidates still available. A selected Gemini 3.8 Flash, High, Auto Edit. |
| 4. Return to B | PASS | A → B succeeded without pressing Retry in B. B still offered the same model families and three modes. The separate production-executor check establishes shared cache identity and neutral paths; the UI alone does not establish either. |

The fresh workspace build, typecheck, lint, format, renderer architecture, locale hygiene,
ASF headers and diff checks passed. ACP/Antigravity tests passed 93/93, and Desktop picker
and settings tests passed 28/28, with no skips or failures. The full workspace tests were
not repeated locally; the [exact-head hosted CI test](https://github.com/apache/maka/actions/runs/36975936091/job/110739653677)
completed successfully. This run does not establish signed-distribution qualification.

The observer script, request log, JSON results, Desktop log, profile and local gate logs
are retained under the local run directory `pr5826-neutral-acceptance-2026-10-02`.
At that head, the stable-directory suggestion was still open. The P3 follow-up above
supersedes the random-path behavior; the Agent-native empty Session/history caveat remains.

## Execution recheck, 2026-10-01

The earlier eligibility HTTP 403 no longer reproduces in this recheck. Official
Agent 1.2.1 completed synthetic prompts through the production `AcpExecutor` in
both disposable directories. The subsequent same-profile Desktop run also completed
both project prompts, idle configuration changes, restart recall and continuity checks.

- Platform: macOS arm64; Node.js 24.19.0; official Agent server/helper SHA-256
  values match the 1.2.1 distribution recorded below. Existing authentication and
  network settings were retained. No private project contents were sent.
- Initial tested code: `a950ce187c7510a762bc2e5c95acf1e63a16b888`. The full
  official-Agent sequence was repeated after building merged code head
  `ccd3c195e94bb262df0ef862f121112b5252f2b4` (epoch 204). Both projects ran through one executor and
  one continuity store, with distinct conversation keys and temporary directories.
- B completed with exactly `ACK` using `gemini-3.7-flash-high` and `default`.
  A completed with exactly `ACK` using `gemini-3.8-flash-high` and `auto_edit`.
  Both continuity records were committed, their directories matched the intended
  projects, and their confirmed model/mode matched the requested values.
- Both catalogs were ready with 11 model IDs and `default`, `auto_edit`, `yolo`.
  Refreshing A replaced A's entry while B returned the identical cached entry.
- An idle change in A confirmed `gemini-3.6-flash-high` and `default`. After
  disposing and recreating the executor, A was restorable and recalled the synthetic
  code omitted from the recall prompt. A second disposal/restoration retained the
  same external Session and committed configuration. Only equality was logged;
  external Session IDs and authentication data were not logged.
- A freshly built development Desktop in the earlier isolated profile verified
  connection and Google sign-in. Native automation initially returned stale-element
  or `noWindowsAvailable` errors. After the user brought the visible Maka Dev window
  to the foreground, UI interaction recovered and the following Desktop run completed.
  That temporary automation blocker is resolved; it was not a new HTTP 403.

Local gates were rerun after integrating `main` at
`1e80e3b885d963b799f7e2e9a70083ceda99943d`. Build, typecheck, lint,
format, renderer architecture, locale hygiene, ASF headers and diff checks passed.
The serial workspace run reported 14,149 tests: 14,111 passed, 38 skipped, zero
failed or cancelled. Following the final epoch-only adjustment, the full build
and 89 protocol tests passed again. The current-base protocol guard passed
202 → 204. Earlier local typecheck failures remain historical, not current failures.
CI for the resulting push must be evaluated separately.

### Completed same-profile Desktop run

Tested build: code head `ccd3c195e94bb262df0ef862f121112b5252f2b4`, epoch 204;
record-only head `9580ea7c039e6cb3942750ef9739ce359ece14bb`. This was the ad-hoc
signed `Maka Dev.app` development build on macOS arm64, not a signed distributable.
Profile alias: `desktop-acceptance.xdwVZL`, retained through two normal Cmd-Q exits
and reopenings. Both projects were added through the real native folder picker.

| Steps | Result | Observed evidence |
| --- | --- | --- |
| 1. Configure Agent | PASS | Official 1.2.1 connection and Google sign-in checks succeeded in this profile. |
| 2–4. Discover, refresh and switch | PASS | B showed four Gemini families and Default/Auto Edit/YOLO. B → A, explicit UI Retry refresh, Gemini 3.8 Flash/Auto Edit selection, and A → B all completed. B candidates remained available without manually refreshing B. Executor cache identity evidence above remains separate. |
| 5. Execute B | PASS | `/private/tmp/pr5826-reaccept-project-b`, `gemini-3.7-flash-high`, confirmed `default`; exact ACK, completed in 7 seconds. Saved continuity was committed with one prompt. |
| 6. Execute A | PASS | `/private/tmp/pr5826-reaccept-project-a`, `gemini-3.8-flash-high`, `auto_edit`; exact ACK, completed in 6 seconds. Both tasks completed in this same profile, with no HTTP 403. |
| 7. Idle change | PASS | A changed through UI to `gemini-3.6-flash-high`/`default`. Task metadata and the Agent-confirmed committed continuity record agreed. |
| 8. Restart and recall | PASS | Normal Cmd-Q/reopen, explicit Restore, retained model/mode. The recall prompt omitted the code; the completed answer was exactly `A-5826-2648` in 15 seconds. |
| 9. Second restart continuity | PASS | A second normal Cmd-Q/reopen and explicit Restore completed. One-way fingerprint equality against the pre-restart record was true; A retained committed phase, two prompts, and confirmed model/mode. No external Session ID was logged. |

Screenshots, accessibility evidence, redacted continuity projections and local gate
logs are retained in the local run directory `pr5826-acceptance-2026-10-01`.
Cross-project Desktop execution and the full behavior acceptance are closed for this
build. Release signing qualification remains separate.

## Repeatable acceptance procedure, updated 2026-10-02

Use this procedure for PR [#5826](https://github.com/apache/maka/pull/5826).
The historical runs below are evidence, not a claim that every step passed on the
latest code. Record the tested commit, macOS architecture, Node version, Agent
version and hashes, Desktop build kind, and profile alias before starting.

### Preconditions and automated gate

1. Check out the PR head in an isolated worktree. Create two empty disposable
   projects A and B and a dedicated Desktop profile. Use that **same profile**
   throughout the two-project run and its restarts. Build Desktop from the tested
   commit; record whether it is a development build, unsigned local app, or signed
   distributable. An unsigned app cannot satisfy release-signing acceptance.
2. Use the official Agent and an account eligible to execute prompts. A successful
   connection or sign-in check alone does not establish prompt eligibility. Do not
   change account or network settings to bypass an eligibility error.
3. Run the repository gates below with dependencies installed. Build before running
   compiled tests so stale `dist` output cannot count as evidence. Record each exit
   status and retain logs. Run workspace tests serially for the local acceptance
   gate; record CI separately, with its exact head SHA and job URL.

```sh
npm run build
npm run typecheck
npm run lint
npm run format:check
npm run check:renderer-architecture
npm run check:locale-hygiene
npm run check:asf-headers
node scripts/run-workspace-tests-parallel.mjs --concurrency=1
```

Fetch the current PR base before the protocol gate. Pass its fetched ref to
`node scripts/protocol-epoch-check.mjs --base <fetched-base-ref>` and run
`git diff <fetched-base-ref>...HEAD --check`. Reconcile the epoch against that base
before merge; the previous 200 → 201 result is historical evidence.

The affected suites must exercise fresh-Session model-dependent mode availability,
model-only changes removing a saved mode, idle notification drift, combined-option
rollback, retained Session restoration, neutral probe directory ownership, shared
instance catalog reuse/refresh, and admission held through process cleanup.
The ACP cases live in `packages/acp-executor-plugin/src/__tests__/acp-executor-plugin.test.ts`;
Host routing cases live in `packages/runtime-host/src/__tests__/session-catalog-coordinator.test.ts`.
Controlled fixtures establish failure/rollback semantics; real Agent runs establish
actual discovery and execution. Keep those results separate.

### Desktop steps and pass criteria

| Step | Action | Required result and evidence |
| --- | --- | --- |
| 1. Configure Agent | In external-Agent settings, select the official Agent executable or its extracted directory using the macOS picker, check connection, and verify sign-in. | The executable and sibling helper are validated before saving; both checks succeed. Also verify that incomplete selections report the missing component and preserve the saved path. Capture settings status with account details redacted. |
| 2. Discover B | Add both projects through the project picker, select B, then select Antigravity and open model/mode pickers. | Real model and mode choices appear. Record actual IDs from confirmed task state; labels alone do not establish IDs. |
| 3. Refresh A | Switch B → A and refresh A's catalog with the UI refresh/retry control. Select an available model and mode. | Refresh completes; candidates remain usable and selection is displayed. Capture A's project label and picker. |
| 4. Return to B | Switch A → B without manually refreshing B; inspect its pickers. | B's candidates remain available. Capture B's project label and choices. In a separate production-executor check, assert that A and B share one candidate snapshot and both see the refreshed snapshot. Record that discovery session/new uses only neutral temporary directories. |
| 5. Execute in B | Create a B task with a real model and `default` (if offered). Send: “Do not read or write files or run commands. Remember synthetic code B-5826-7319. Reply only ACK.” | Task reaches completed with ACK, and task metadata records B's directory and confirmed model/mode. An error or HTTP 403 is blocked/failed execution, never a pass. |
| 6. Execute in A | Switch to A. Create a task with another available model and `auto_edit` (if offered). Send the same no-file-access prompt with code A-5826-2648. | Completed with ACK; metadata records A's directory and confirmed selection. Both steps 5 and 6 must pass in this same profile to close cross-project execution. |
| 7. Confirm idle change | In one completed task, change mode and model while idle. | Agent confirmation and inspected task configuration agree with the selected IDs. Do not treat an optimistic picker label as confirmation. |
| 8. Restart and recall | Quit Desktop normally, reopen the same profile, open that task, and invoke restore if shown. Ask: “Do not read or write files or run commands. What synthetic code did I ask you to remember? Reply only the code.” | Completed with the correct prior code, which is absent from the recall prompt. The restored task retains its confirmed model/mode. Capture the recall answer and restored selection. |
| 9. Verify continuity | Compare external Session ID fingerprints before and after a second normal restart/restore. | Fingerprints match and continuity remains committed. Log only the equality result, never the external Session ID or private continuity record. |

Use actual offered choices if the official Agent catalog changes. Record the chosen
IDs and reason for substitution rather than hard-coding a now-unavailable model.
Save screenshots, task completion status, confirmed selections, and redacted logs
under a run-specific evidence location. Report each step as PASS, FAIL, BLOCKED,
or NOT RUN, with the tested commit. Never promote an earlier profile's success to
a pass for steps 5–6 in a different profile.

### Blocked-run handoff and completion rule

On authentication failure, retain the completed discovery/configuration checks and
resume execution after an eligible account is available. On account/location HTTP
403, record the affected project, model, mode, and error category without account
identifiers; leave cross-project execution open. Rerun steps 2–9 in one profile when
eligibility is restored. If code changes, repeat the affected automated gates and
record the new tested commit. Do not substitute a mock Agent for official-Agent
execution acceptance.

Cross-project acceptance closes only when both project prompts complete in the same
profile. Full behavior acceptance additionally requires confirmed idle changes,
restart recall, same external Session continuity, and passing automated gates on the
tested code. Signed distribution qualification is separate from this feature gate.

### Earlier verified status before the execution recheck

- Code head `d8d36d71a6346552f5a9c87c3b35728cc6a87a02`: the
  [CI run](https://github.com/apache/maka/actions/runs/36696757301) passed on
  2026-09-30. Verified successful steps include build, typecheck, lint, ASF headers,
  locale hygiene, renderer architecture, protocol epoch guard, affected workspace
  tests, Runtime Host tests, and Desktop e2e. This supersedes “current-head CI
  pending” for that commit; it does not convert historical local typecheck failures
  into local passes or establish real official-Agent prompt execution.
- Real Desktop discovery, B → A → B, A refresh, and B availability: PASS in the
  previously recorded unsigned app/profile. Production executor probes separately
  established per-directory refresh isolation.
- Successful prompt execution in **both** projects of that profile: BLOCKED by
  account/location HTTP 403. Earlier single-project prompt/recall/continuity success
  remains valid separate evidence. The remaining execution checkbox stays open.

- An additional 2026-10-01 eligibility probe reused the earlier production-executor
  build and official Agent with a disposable directory and a synthetic no-file
  prompt. It produced no completion or diagnostic within two minutes; its Agent
  process was terminated, the client reported `cancelled`, and the directory was
  cleaned up. This is inconclusive, is not a latest-head test, and neither confirms
  a new HTTP 403 nor clears the outstanding Desktop execution gate.

## Official Agent capability gate, 2026-09-29

- Platform: macOS arm64. Client: ACP SDK 1.4.0, Node.js 24.19.0.
- No official Antigravity executable or authenticated Agent home was present in this development environment. The official Google macOS arm64 1.1.1 archive was downloaded from the URL in `docs/antigravity-acp-settings.md`. Its server and helper SHA-256 values matched the already recorded distribution hashes there.
- An isolated, disposable ACP client used a temporary toy directory. `initialize` returned protocol version 1, Agent version `agy_acp_server_1.1.1`, and resume/load capabilities. `session/new` returned JSON-RPC `-32000 Authentication required`. The probe sent no prompt, created no Maka task, did not log an external Session ID, and terminated its process group and toy directory.
- The [official ACP registry](https://github.com/agentclientprotocol/registry/blob/main/antigravity-acp/agent.json) listed version 1.2.1. Its Google macOS arm64 archive contained the matching server and helper (SHA-256 `c93c86c0f505fcdf8b13c695bed26d306141ef5446189d591397074d324db34e` and `1b8a2b712ca312c9769e425b800bfbcceec4770f19736404474d1e8e50d65456`). `initialize` returned Agent version `1.2.1`, protocol version 1 and resume/load capabilities; `session/new` again returned `-32000 Authentication required`. Authentication remains required before a real `configOptions` list can be observed.

At this initial gate, authentication blocked observation of real mode IDs, mode/model interaction, confirmation responses, restoration of mode, and the full Desktop acceptance path. The authenticated follow-up below supersedes those initial capability findings. Different-directory catalogs and the full Desktop path remain unverified with the official Agent. No account or proxy configuration was changed by this work.

## Authenticated official Agent follow-up, 2026-09-29

A later check on macOS arm64 used the official 1.2.1 archive linked by the ACP registry. Its server and helper matched the SHA-256 values above. With the existing authenticated Agent home and a disposable toy workspace:

- A production `AcpExecutor` catalog probe returned 11 real model IDs and three mode IDs: `default`, `auto_edit`, and `yolo`. The current mode was `default`.
- A fresh Session confirmed `gemini-3.8-flash-high` with `default`, then confirmed an idle change to `auto_edit`. Another idle change confirmed `gemini-3.7-flash-high` with `default`. Inspection returned those exact final values.
- After disposing and recreating the executor, inspection reported `restorable`. Explicit restoration retained the same external Session ID and reconfirmed the saved model and mode. The comparison was made in memory; the ID was not logged.
- Synthetic text prompts with both `gemini-3.8-flash-high` and `gemini-3.7-flash-high` failed with `acp_prompt_failed`. The Agent's output contained HTTP 403 and a location restriction. This check therefore does **not** establish successful prompt execution or post-restart context retention.
- A Desktop development build opened in an isolated worktree profile, but authenticated Desktop selection, refresh, idle change, and restart evidence remains outstanding. The isolated profile has no configured external Agent, and the prompt restriction above still blocks the complete task flow.

All probes used a temporary project, sent no private project content, and disposed their Agent processes. No account or network settings were changed. At that stage, real discovery, confirmed configuration, and same-Session restoration were verified; full Desktop and successful prompt acceptance were still open.

## Desktop acceptance, 2026-09-30

The Desktop development build ran on macOS arm64 with an isolated user-data directory and two temporary toy folders. The installed Agent was the official 1.2.1 distribution verified above. No private project content was sent to it.

- The macOS file picker disabled selection of the official Mach-O `agy_acp_server.par` file. Desktop now asks for its extracted directory and resolves the server path from that directory. In the real UI, choosing the directory saved the executable path, `Check connection` succeeded, and Google sign-in verification succeeded.
- In the first toy project, the Antigravity picker showed the four model families backed by the real catalog. The production catalog probe returned 11 model IDs. The mode picker showed `Default`, `Auto Edit`, and `YOLO`. A manual refresh retained the selected model.
- A new Desktop task used `gemini-3.7-flash-high` with `auto_edit`. The first synthetic prompt asked the Agent to remember `RIVER-4821` without reading or writing files. The task completed in nine seconds and answered that it had remembered the code.
- While idle, the same task confirmed a change to `default` and `gemini-3.6-flash-high`. After a normal Desktop quit and restart, the task showed a restore action. Restoration completed with that model and mode. A second prompt omitted the code and asked the Agent to recall it; the completed answer was exactly `RIVER-4821`.
- The private Plugin continuity record showed `phase: committed`, two committed prompts, and the confirmed model and mode. A second normal quit and restart again restored the task. A one-way fingerprint comparison of the record before and after that restart confirmed the same external Session ID; the ID was not logged.

An initial attempt to add the second toy project for a Desktop directory-isolation check stalled because the macOS project-folder picker disabled its Open button despite the folder being selected. A later isolated app profile successfully added both projects; the second-project result and remaining switching gap are recorded below.

## P3 follow-up and two-directory Agent check, 2026-09-30

The P3 review identified a configuration-order failure: when a new Session begins on a launch model without a mode option, `configureConversation` rejected the requested mode before selecting a model that does expose it. A similar idle Session drift could make restoration of a saved model and mode fail. Configuration now applies the requested model first, validates dependent options against the Agent's response to that model change, and rolls back if the resulting mode is invalid. A fresh Session merges launch defaults with the requested configuration once; a restored Session retains its saved configuration path.

- Regression tests reproduced both failures before the fix (`acp_config_unavailable: mode`) and pass after it. A third test covers rollback when a mode is invalid after the model switch. The ACP plugin suite passed all 51 tests; the Runtime Host Session catalog coordinator passed all 76 tests.
- The official 1.2.1 Agent was used through the production `AcpExecutor` after Google sign-in. Two separate disposable directories, `/private/tmp/maka-pr5826-project-a` and `/private/tmp/maka-pr5826-project-b`, each returned `ready`, 11 real models, and mode IDs `default`, `auto_edit`, `yolo`. Re-querying each directory returned its cached entry. Explicitly refreshing A returned a new ready entry for A while B still returned its original cached entry. This establishes authenticated per-directory discovery and refresh isolation in the production executor against the real Agent. Both directories returned the same choices, so this does not prove that different workspace configurations produce different catalogs.
- An isolated local `Maka.app` assembled by electron-builder launched and showed the packaged renderer. In that app the extracted official Agent directory was selected with the native picker, connection check succeeded, and Google login verification displayed success. Electron-builder could not finish the macOS arm64 distributable because this machine has no `Developer ID Application` signing identity and the project requires signing. This was an unsigned local app layout, not a completed signed DMG or ZIP.
- After the first isolated app profile stopped responding to desktop automation, a fresh isolated profile successfully registered both toy directories through the native macOS project-folder picker. The official Agent directory was selected in that profile; connection and Google login verification succeeded. With project B selected, the Antigravity picker displayed four real Gemini model families and the `Default`, `Auto Edit`, and `YOLO` modes. Automation initially lost the project-menu target during attempts to switch A ↔ B. A later restart of this same profile completed the switching check described below.
- In the resumed packaged app profile, the project menu switched B → A. A's Antigravity picker showed four Gemini model families. The Desktop `Retry` control started and completed a catalog refresh for A; the candidates remained available. With A selected, `Gemini 3.8 Flash` exposed `Default`, `Auto Edit`, and `YOLO`, and `Auto Edit` could be selected. The menu then switched A → B without manually refreshing B. B still showed the four Gemini families, and `Gemini 3.7 Flash` exposed the same three modes. This verifies the Desktop project-switch and catalog-availability path after an A refresh. Since A and B offer identical candidates, the UI alone cannot prove that B reused its own cache entry; the production `AcpExecutor` object-identity check above establishes A-only refresh at the executor layer.
- A no-file-access prompt was sent in each toy project. The B task recorded `pr5826-project-b`, `gemini-3.7-flash-high`, and `default`; the A task recorded `pr5826-project-a`, `gemini-3.8-flash-high`, and `auto_edit`. Both reached the real Agent and failed with HTTP 403: `Your current account is not eligible for Gemini Code Assist for individuals because it is not currently available in your location.` Thus this profile verifies project and mode routing through task creation, but it does not add successful cross-project prompt execution. The earlier successful prompt and restart-continuation check in the first profile remains separate evidence.
- The Desktop app build passed. The workspace-dependency build stopped at existing `@maka/ui` TypeScript errors involving `@astryxdesign/core` types; the full workspace typecheck is not counted as passing for this follow-up.

## Implementation and controlled checks

The generic executor configuration and catalog carry optional opaque mode IDs. ACP maps real
select options returned by the Agent; omitted mode preserves the real task Session default.
The existing Host query and Desktop picker continue to carry models and modes.

### P2 catalog lifecycle follow-up, 2026-10-02

Draft discovery now creates its disposable Session in a neutral temporary directory, rather than
the selected project. One configured ACP executor shares its 60-second catalog across projects.
Explicit refresh invalidates that executor's draft cache; setup/login and provider replacement
invalidate its instance state. Retained task inspection and confirmed configuration are separate.

The ACP runtime Entry shares Runtime's AdmissionLimiter with a two-probe capacity across adapter
registrations. A permit is held until connection and directory cleanup finish. Refresh replacements
wait for old cleanup, queued invalidations cannot start a process, and the 30-second deadline includes
admission wait. Disposing an executor drains all its superseded probes as well as its latest one.

The real task still initializes its own Session in its workspace, applies model before dependent
mode, and validates explicit choices before sending a prompt. A value available in the neutral
probe may be unavailable in that task; failure never sends the prompt on a substituted default.
Omitted choices use the real Session defaults. Draft refresh cannot replace a confirmed task choice.

The configured Agent can perform its own startup work and retain an empty Session. A neutral
directory avoids requesting initialization of the user's project; disabled client filesystem and
terminal capabilities do not sandbox the process. Maka removes its owned temporary directory after
closing the connection and does not attempt generic deletion of Agent-native history.

The two-directory official-Agent and Desktop evidence above belongs to the previous workspace-scoped
implementation. It remains historical evidence for model/mode execution and continuity, but does
not verify this neutral-probe follow-up. Repeat official-Agent and Desktop acceptance against the
new code before claiming that path verified. For a production-executor check, query A and B, assert
one shared candidate snapshot, refresh once, and verify both now see the refreshed instance snapshot;
record that the Agent session/new requests contain only disposable neutral paths. The old A-only
cache-identity criterion is superseded for ACP draft catalogs.

Controlled regressions cover neutral directory ownership, cross-project cache sharing, task-specific
candidate rejection without prompting, real Session defaults, admission through cleanup, repeated
refresh handoff, queued disposal and late-result fencing. Existing rollback, same-Session restore
and Composer pending-gate suites remain applicable.

Local verification for this follow-up: the full workspace build, typecheck, lint and format checks
passed, as did Desktop/UI knip, renderer architecture, locale hygiene and ASF header checks. The ACP
suite passed 84 tests, the Antigravity adapter passed 9, and the affected Runtime, Host, Desktop and
UI suites passed 225, with no skips or failures. The stdio fixture writes native history at
session/new: deliberately passing the selected project reproduces a project file mutation; the
neutral probe prevents it. Removing the crash-cleanup wait also reproduces overlapping replacement
startup. Both regressions pass with the fix restored. No official-Agent or real Desktop run is
claimed for this follow-up.

### P3 protocol history and program selection follow-up, 2026-10-02

The protocol history now records opaque mode IDs and optional catalog refresh once, under the
shipped epoch 204. The redundant merge-description entry and unshipped ACP epoch-203 entry were
removed. The guard passes against fetched main `ab6db58c9` at epoch 202; the wire contract and
shipped epoch are unchanged by this follow-up.

The macOS native picker allows files and directories. Only a directory selection has the known
server filename appended; the selected executable and its sibling `localharness_external` must be
regular, executable files. Selection and Host check/login share the same filesystem validator.
Invalid selection reports the existing localized executable/helper failure and does not save a
replacement path. Cancellation remains a no-op, and other platforms retain file-only selection.

Controlled filesystem, settings/IPC, setup/install and protocol suites passed 147 tests without
skips or failures. These exercise actual temporary files, executable permissions, both selection
forms, incomplete distributions and an Electron-prefixed failure reaching the settings banner.
They do not claim a new real macOS dialog or official-Agent run.

## Historical validation (see latest verified status above)

- `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run check:renderer-architecture`, `npm run check:locale-hygiene`, and `npm run check:asf-headers`: passed.
- For the 2026-09-30 Desktop picker follow-up, the development build completed and targeted Biome lint passed. A fresh Desktop workspace typecheck still reports errors in unchanged browser tools, notifications, overlays, runtime config, and conversation selector files; those errors are not counted as a pass for this follow-up.
- `node scripts/run-workspace-tests-parallel.mjs --concurrency=1` with the bundled Node.js 24.19.0 and Python 3.12.14: all workspaces passed. A separate three-workspace concurrent run was stopped after unrelated timing-sensitive Runtime Host integration cases failed under load; it is not counted as passing validation.
- The protocol epoch advanced to 201 after merging main's storage-usage (199) and Agent Graph (200) protocol updates, for the additive mode and refresh wire fields. The merge-result protocol epoch guard passed against the updated main.
- The initial unauthenticated `session/new` failure and HTTP 403 prompt restriction were resolved for the first Desktop profile above, which verified selection, authentication, catalog refresh, mode and model changes, a completed prompt, and post-restart continuation. A second isolated profile added both toy projects, switched B → A → B, refreshed A, and still rendered B's real catalog without refreshing B. Production `AcpExecutor` probes separately verified per-directory cache and A-only refresh against the official Agent. New prompts in both projects of the second profile failed with the Agent's account/location HTTP 403, so successful cross-project prompt execution remains unverified.
