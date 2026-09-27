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

# Grok-assisted contribution review

**Baseline:** `3f44315dd` (2026-09-27). **Status:** all 25 original-commit
inventories, current behaviors, tests, and dispositions are reviewed. Four
narrow surviving slices and seven active current cores have independently
reasoned replacements; deleted, superseded, mixed-attribution, test-only, and
documentation entries have explicit dispositions below. Project and ASF legal
acceptance remains open.

This is a provenance and engineering inventory, not a legal classification or
an assertion that these changes must be removed. The scope is merged PRs whose
mainline squash commits are dated on or after 2026-08-14, the effective date
of the xAI Acceptable Use Policy change under discussion. A squash date is
**not** the date a tool produced the original contribution. The scan matches
`Generated-by: .*Grok` in commits reachable from `origin/main`, then checks PR
disclosures for contributions without that trailer. A trailer does not establish
which individual lines were generated; a PR without one can still disclose use.

| PR | Main commit | Area | Evidence |
|---:|---|---|---|
| #3008 | `2632b8506` | Eval egress | Commit trailer |
| #2967 | `1ce0bc308` | Eval egress | Commit trailer |
| #3048 | `a75640f43` | Desktop transcript | Commit trailer; mixed-tool PR |
| #3063 | `0dc3e5ec3` | Runtime cleanup | Commit trailer |
| #3066 | `d6bef01d3` | Eval framework | Commit trailer |
| #3070 | `9fbdc99a2` | Desktop projects | Commit trailer |
| #3078 | `887af0c9d` | CI inventory | Commit trailer |
| #3082 | `2666a579a` | Runtime PTY | Commit trailer |
| #3099 | `4bded3b21` | Desktop rail | Commit trailer |
| #3101 | `84a579db6` | Desktop tests | Commit trailer |
| #3102 | `5ef39c350` | Desktop bridge | Commit trailer |
| #3104 | `8a11c9f2b` | Runtime graph | Commit trailer |
| #3106 | `a79f69185` | Runtime Host tests | Commit trailer |
| #3111 | `cdf023dc0` | Desktop fixtures | Commit trailer |
| #3115 | `c92d0a22a` | Rate limits | Commit trailer |
| #3117 | `12d2ab54e` | Storage cleanup | Commit trailer |
| #3118 | `dd02553aa` | xAI model discovery | Commit trailer |
| #3119 | `802fe8977` | Desktop Plan Mode | Commit trailer |
| #3123 | `2e3c82e10` | Desktop tests | Commit trailer |
| #3069 | `4ffc823fd` | Desktop search | Commit trailer |
| #3459 | `b434a491a` | Terminal handling | Commit trailer; mixed PR |
| #3364 | `3ab0605b3` | Relative time | Commit trailer; mixed PR |
| #3544 | `dc9d2f0dd` | Composer queue | Commit trailer; mixed-tool PR |
| #4345 | `472fea02b` | Architecture docs | Commit trailer; mixed-tool PR |
| #5223 | `aa3f8e538` | Project path validation | PR AI-use disclosure; no Grok trailer |

PR #2956 disclosed Grok but merged on 2026-08-13, before the selected date,
so it is outside this inventory. Closed, unmerged PRs are also outside the
current-mainline inventory: #4809, #4899, #5102, #5342, #5349, #5350, and
#5497.

The original PR commit histories narrow this initial scope further. #2967 has
five Grok-tagged original commits, starting on 2026-08-13 and continuing
through 2026-08-15; it needs commit-level attribution rather than treating the
whole PR as post-change output. #3123 has a Grok trailer on the squash commit,
but none of its three original PR commits have that trailer and its original
PR description has no AI-use disclosure. Confirm that provenance before
classifying it. #5223 has no Grok-tagged commit but explicitly discloses
Cursor/Grok assistance in the PR description. The remaining 22 trailer-bearing
PRs have at least one Grok-tagged original commit dated 2026-08-14 or later.

A second pass read the original commit titles and trailers for all 25 PRs.
#3048, #3544, and #4345 also contain Codex-authored commits. #3459 contains
two untagged feature commits before its three Grok-tagged commits. In #3364,
the three substantive relative-time commits are tagged Maka; its only
Grok-tagged original commit adds an ASF header to a test file. Reverting the
whole #3364 change would therefore remove work not attributed to Grok.
#3101, #3102, #3104, #3106, #3111, #3117, and #3069 also have untagged
merge or follow-up commits: inspect their merged diffs, not just their branch
commit lists. For example, #3118's original branch includes a Plan Mode import
fix also merged separately in #3119, but #3118's squash diff contains only
the xAI discovery/test deletions.

## First-pass engineering triage

This pass inspected each merge's changed paths and size against the baseline.
"Present" means the path still exists, **not** that the original lines survive
or that its behavior is unchanged. The line-level and behavioral evidence that
follows supersedes path presence as the disposition basis.

| PR | Changed paths present now | Review target |
|---:|---:|---|
| #3008 | 3/3 | Eval CONNECT/TCP egress rules and denial tests |
| #2967 | 6/6 | Eval audit completeness and fail-closed boundary |
| #3048 | 14/14 | Mixed-author live transcript reseed and catch-up behavior |
| #3063 | 0/1 | Confirm deleted compact-cleanup has no successor or reader |
| #3066 | 11/11 | Eval framework selection across Python and TS |
| #3070 | 3/3 | Nested project registration and storage tests |
| #3078 | 5/5 | Generated inventory and CI drift gate |
| #3082 | 2/2 | PTY finalization/persist race |
| #3099 | 3/5 | Current rail grouping state and E2E successor |
| #3101 | 1/1 | Streaming remount painted-frame E2E |
| #3102 | 12/14 | Removed bridge endpoints and current IPC callers |
| #3104 | 8/9 | Removed runtime graph drive and Host graph authority |
| #3106 | 10/12 | Candidate launcher and E2E execution authority |
| #3111 | 2/3 | Daily Review fixture writer and deleted archive store |
| #3115 | 16/16 | Provider retry classification and user-facing wait state |
| #3117 | 10/14 | Removed JSON connection store and current storage paths |
| #3118 | 2/2 | xAI OAuth discovery filter is absent in current registry |
| #3119 | 1/1 | Plan Mode copy import at current module boundary |
| #3123 | 0/1 | Original prompt-rail E2E file is absent; find successor |
| #3069 | 0/2 | Both original search tests are absent; find current search tests |
| #3459 | 2/4 | Mixed-author terminal control-character handling |
| #3364 | 3/3 | Mixed-author relative-time formatting and refresh |
| #3544 | 31/35 | Mixed-tool queue protocol, Host receipts, and UI; 35-file change |
| #4345 | 1/1 | Mixed-tool architecture documentation accuracy |
| #5223 | 2/2 | Directory type validation still runs in project resolution |

### Squash-line survival on current main

The following measurement resolves each mainline squash commit to its full SHA,
counts lines added by that commit, and uses `git blame -w -M --line-porcelain`
on `origin/main` at `3f44315dd` to count lines still attributed to it. It is a
stronger survival signal than path presence, but it is not a generated-line
classifier: mixed-origin PRs are not split by original commit, `-C` copy
detection is not enabled, and `-M` can reattribute moved lines. A later rewrite
also does not erase the original contribution's provenance.

| PR | Added lines | Surviving on `main` |
|---:|---:|---:|
| #3008 | 180 | 166 |
| #2967 | 678 | 651 |
| #3048 | 462 | 287 |
| #3063 | 0 | 0 |
| #3066 | 201 | 129 |
| #3070 | 177 | 137 |
| #3078 | 114 | 89 |
| #3082 | 116 | 66 |
| #3099 | 129 | 86 |
| #3101 | 54 | 42 |
| #3102 | 39 | 4 |
| #3104 | 20 | 17 |
| #3106 | 279 | 139 |
| #3111 | 59 | 57 |
| #3115 | 429 | 407 |
| #3117 | 282 | 252 |
| #3118 | 0 | 0 |
| #3119 | 2 | 1 |
| #3123 | 48 | 0 |
| #3069 | 200 | 0 |
| #3459 | 288 | 150 |
| #3364 | 118 | 111 |
| #3544 | 1713 | 1090 |
| #4345 | 22 | 22 |
| #5223 | 43 | 32 |

The measurement finds 3,935 surviving squash-attributed lines. Four entries
have no surviving added output: #3063 and #3118 are deletion-only, while the
only #3123 file and both #3069 files were later deleted. The largest surviving
concentrations are #3544, #2967, #3115, #3048, and #3117; the behavioral and
attribution review below handles those current boundaries rather than treating
the blame count as a completion metric.

The largest original change, #3544, touched 35 files and changed more than
2,000 lines; #3117 removed over 1,600 lines. A single wholesale rewrite would
cross separate storage, protocol, Desktop, Eval, and security review boundaries.
The deleted-only #3063 and absent test paths in #3123/#3069 have no direct
current file to "rewrite". Review should identify a present behavior before
proposing a replacement, and high-risk egress/Host paths need their own focused
tests and review.

### Revert feasibility probe

Before the baseline advanced, a disposable worktree at historical main commit
`d89ccce01` attempted `git revert --no-commit dc9d2f0dd` for #3544.
The revert stopped with 31 unmerged paths across Desktop IPC and renderer,
Runtime Host protocol/coordinator, UI, tests, and two modify/delete cases.
The probe was aborted and its worktree removed; no revert was committed or
pushed. This is direct evidence that a wholesale revert cannot be applied
mechanically to today's tree. The current behavior and later dependents must
be resolved before a replacement can be tested.

Some entries are removals rather than added implementation. For example,
#3118 removed one discovery filter and #3063 deleted an unused module. A
revert followed by the same deletion would leave the final product unchanged;
such a commit pair alone does not establish an independent replacement.

### Replacement slices

The following work was done against the 2026-09-27 baseline, preserving later
changes. It does not erase the original history or settle ASF legal questions.

| PR | Revert-state evidence | Replacement and verification |
|---:|---|---|
| #3082 | Removing the PTY exit reconciliation made the delayed-persist test return `running` instead of `completed`. | Reconcile the control reply after persistence against finalization, then mark terminal observations. Replaced the Grok-authored test with a fresh test that pauses storage and observes driver exit without monkeypatching the driver prototype. Runtime build, shell-run-manager suite (62 pass, 4 platform skips), and Biome passed. |
| #5223 | Removing the directory check made the regular-file test fail with `Missing expected rejection`. | Check the canonical path's stat before Git discovery and reject non-directories with `TypeError`. Replaced the original test with Git/non-Git file cases, registration non-mutation, and a directory control. Storage build, project-catalog suite (23 pass), and Biome passed. |
| #3070 | Removing explicit nested-project selection made registration return the parent project's ID and broke relinking to a child directory. | Make resolution intent explicit: selected paths retain a nested folder identity, while historical paths and selected repository roots keep Git identity. Storage build, project-catalog suite (24 pass), Desktop nested-selection test, and Biome passed. The full Desktop build initially had seven unrelated implicit-`any` diagnostics; it passed after the latest upstream merge. |
| #3099 | Disconnecting the migrated rail store's grouping read/write made a fresh store lose the selected grouping (`undefined` persisted value). | Let the rail layout store hydrate and write grouping directly, removing the old standalone read/write helpers. Rail layout tests (6 pass), navigation boundary tests (4 pass), and Biome passed. The full Desktop build initially had the same seven unrelated diagnostics; it passed after the latest upstream merge. |

The #3082 and #5223 revert-state commits are separate from the replacement
commit to make the failure evidence inspectable. They are not safe to merge
without the following replacement. The remaining 21 entries are dispositioned
below: seven active cores were rewritten, eight paths are deleted or
superseded, two are mixed or uncertain attribution, three are test/fixture or
mixed-feature regressions, and one is documentation-only.

Eight narrow paths have been traced to a no-code disposition rather than an
identical revert/reapply. They are reviewed, **not** counted as replacements:

- #3063 removed `history-compact-cleanup.ts`; the file and references to it
  are absent now (a repository search finds only this review document).
  Restoring and removing it again would not replace live code.
- #3118 removed the `fallback-models` filter for xAI OAuth discovery, which is
  still absent in `packages/core/src/provider-registry.ts`. The other changed
  line removed an unused test import. Reintroducing the filter just to delete
  it again would temporarily restore a model-discovery regression without
  changing the final behavior.
- #3119 moved Plan Mode types to core subpath imports. The imports survive,
  with later UI-locale lookup behavior added at the same boundary in
  `apps/desktop/src/renderer/locales/plan-mode-copy.ts`. Restoring the removed
  root barrel import would break typecheck; an identical import fix is not an
  independent implementation.
- #3102 removed unused Desktop bridge/IPC endpoints. The deleted channel names
  (including `git-review:mutate`, the memory mutations, onboarding milestone
  clearing, MCP reconnect, artifact get, and skill starter/details) have no
  present Desktop callers or registered handlers in the source tree. Its
  original branch also includes an untagged merge and an E2E follow-up. Do not
  resurrect the discarded IPC authority merely to delete it again. Its two
  touched E2E files were later deleted (#5567 and #4752); the surviving
  `/compact` Electron E2E passes (1 test), and the slash availability and
  Skills controller tests pass (21 tests). The original E2E paths no longer
  provide a live test target.
- #3104 removed a dead `runAgentGraphToQuiescence` loop and its test suite. A
  current source search finds no call sites for that function; the migrated
  `stream-graph-dispatch.ts` exports supervisor types still used by the live
  coordinator and reconciliation code. Restoring an inactive second graph
  driver would create another execution authority. Its remaining coordinator
  and protocol test adjustments pass with the current Runtime read-model and
  coordinator suites (31 tests). The deleted loop has no behavior to
  independently rewrite.
- #3117 deleted the legacy `llm-connections.json` store. Current storage and
  Desktop main source has no production reference to that file or
  `createConnectionStore`; the fixture writes to the Runtime Policy catalog
  through its current storage authority. Its fixture test passes and asserts
  the old JSON file is not created (rerun against the current Desktop build).
  The fixture and related migration edits remain active and require their
  own review; restoring the removed legacy store just to remove it again is
  not a remedy.
- #3069 only added local transcript-search tests; both original test paths
  were subsequently deleted (#4877 and #5531). Search now uses the Recall
  pipeline. The current multi-host Recall search tests pass (9 tests), but
  restoring the old tests would target a retired local-scan implementation.
- #3106 originally sent `--desktop-e2e` through the production candidate CLI
  and launcher. #3226 later separated the E2E execution entry into a
  `test-only` module and made the production candidate reject that flag. The
  current candidate/desktop tests pass (35 tests), including isolation from
  test-only modules. Do not restore the old production flag. The surviving
  startup and candidate wiring was reviewed at its current boundary and needs
  no replacement of the superseded E2E authority.

Two mixed/uncertain entries require attribution decisions, not a wholesale
rollback:

- #3364's original Grok-tagged commit (`e65809320`) added only the ASF header
  to `packages/core/src/__tests__/relative-time.test.ts`. The relative-time
  behavior and tests came from Maka-tagged commits, with a later untagged
  follow-up. Keep the required license header and do not revert the formatter
  under the squash commit's aggregate Grok trailer. The current formatter and
  refresh tests pass (8 tests).
- #3123's three original PR commits and PR description do not disclose Grok,
  despite the squash commit's trailer. Its only changed file,
  `apps/desktop/e2e/prompt-rail.spec.ts`, was deleted by #4741. The original
  provenance is unresolved; there is no surviving test file to revert and
  reimplement mechanically. #4741 removed the old layout E2E after repeated
  compositor-dependent failures; that removal does not attribute its earlier
  test lines to any model.

#3008 is only partly recognizable in today's Eval egress filter. Its CONNECT
host classification remains, but #3017 subsequently replaced the raw-TCP
layer-closing path, added HTTP/TLS prefix handling, and introduced live
mitmproxy tests. Reverting the #3008 squash against today's code would also
unwind later security behavior. Treat the surviving CONNECT validation as a
separate security review with unit and live-proxy regression checks.

#3459 has two untagged substantive commits that introduced terminal query
handling. Its three Grok-tagged follow-ups suppress XTVERSION replies, preserve
cursor-position reports, and mark CLI `/transcript` as local while a turn runs.
The implementation moved to the workbar terminal feature; the three behaviors
and their unit tests survive. A new registered-handler test verifies status,
CPR, and XTVERSION routing at the parser boundary. The Desktop query suite
(7 tests) and CLI mid-turn `/transcript` test pass. Reverting the squash would remove the
untagged implementation too. Review the tagged behaviors at their current
boundaries, not the terminal feature as a wholly Grok-authored change.

#4345 is documentation-only. The first original commit is Grok-tagged and
describes bot onboarding; a later Codex-tagged commit corrected its claim about
test coverage. The surviving document was checked against the current
`BotOnboardingSnapshot`, main-process service, renderer, and tests: its stale
generic `warning` claim was corrected to `warningCode`/`warningDetail`, and
`retryHealth`/`errorCode` were documented. This is a scoped factual correction,
not an independently rewritten architecture or erasure of the original history.

#3048's first two original commits (Grok-tagged) added catch-up seeding and
observation-generation gating; the next two (Codex-tagged) added retry and
ordering assertions. The live seed helper and observation hooks remain, with
later revisions. The current live-content-seed, observer, and streaming-handoff
test files passed before a scoped fix (88 tests). A new failing test showed
that a stale completion for the same Session could mark a newer generation
ready at the helper boundary. Completion now carries the exact generation
token through the observation hook and refuses to flush/display a newer seed
for an older signal. The three test files now pass (89 tests) and Biome passes.
This is a scoped independent hardening, **not** a replacement for the entire
two tagged implementations. The full streaming-remount Electron E2E (4 tests)
and session-local recovery E2E (3 tests) pass. Desktop's full build also
passes after merging the latest upstream; it initially reported seven
unrelated implicit-`any` diagnostics.

#3101's only squash change modified the streaming-remount E2E to sample on
animation frames instead of body mutations. The current test has since gained
other assertions; the full file passes in a real Electron window (4 tests).
This validates the existing assertions, not an independently rewritten test.

#3544's first six original commits are Grok-tagged and the last three are
Codex-tagged. The per-entry queue still has Host protocol, coordinator, and
Desktop UI behavior, though the original Desktop action module has since been
removed. The current Host message-coordinator and protocol suites pass (177
tests), and the focused protocol suite passes 87 tests. That baseline does not
constitute a replacement for its 35-file mixed
change. The Host/protocol/UI slices and Electron workflow need separate
review; a direct squash revert previously conflicted in 31 paths. A new
same-members concurrent-reorder test failed because `queue.entries.reorder`
had no expected queue revision, letting an old client's permutation overwrite
a newer one. The Host now checks a required revision, and Desktop main,
preload, WorkHub, and Side Chat pass through the observed revision. Host
message/protocol tests (175 pass), Desktop main/preload/renderer typechecks,
Desktop queue tests, and Side Chat/WorkHub Electron E2Es pass after rebuilding
the preload and renderer. This is a scoped concurrency fix, not a full rewrite
of the mixed 35-file PR.

#3115's rate-limit classification, Host retry projection/continuity, and UI
countdown remain live. The current Runtime/Host suites pass (97 tests) and
Core/UI countdown suites pass (8 tests), including remaining-time projection
after reconnect and reduced-motion display. This is a baseline review only;
the active Host/UI code has not been independently replaced. A new failing
classification test showed that a standard `Headers` instance on a provider
error lost `Retry-After` even though retryability remained true. Header
extraction now accepts both `Headers` and plain records; the 20 classification
tests and Biome pass. A second failing test showed a backward Host clock
adjustment projecting more remaining wait than the original scheduled delay;
the projector now caps elapsed time at zero. Projector/continuity tests
(79 pass) and Biome pass. These are scoped parsing and projection fixes, not
a full #3115 rewrite.

#3111's Daily Review fixture still writes through the interactive storage
authority with nested writer/owner cleanup. Its archive-seeding test passes;
a new failure-path test rejects an invalid archive, reacquires the same root
owner, and confirms that no partial archive was written (2 tests pass). This
validates cleanup rather than independently replacing the live fixture writer;
the old Desktop archive store was deleted and has no direct current file.

#3070 and #3099 were replaced in the current branch after reviewing their
migrated implementations. #3070's historical cwd resolution remains distinct
from explicit nested selection. #3099's renderer reload test survives at
`apps/desktop/e2e/sidebar-project-reload.spec.ts`; its direct store tests pass,
and the Electron renderer-reload E2E passes in this branch.

### Further scoped work (not full PR dispositions)

- #3066: a new concurrent-trial test failed under the process-global framework
  selection (`harbor` observed `pier`). Selection now uses a Python `ContextVar`;
  the next ablation showed that a failed trial leaked its framework into the
  caller's context. `run_trial` now scopes selection with a `ContextVar` token
  and restores the caller's framework after success or error. Python 3.13
  Harbor tests (93 total, 13 skips), Eval TypeScript build, and 19 lifecycle
  tests passed. The original TypeScript removal of the environment selector
  remains in place and was verified by the lifecycle suite; it was not
  reverted just to reproduce an obsolete selector.
- #3078: the inventory checker now exposes a pure drift comparison, with tests
  for exact bytes, independently stale Markdown, and missing/extra paths. The
  CI planner also recognizes the new test. The real 301-file inventory check
  (after merging upstream), 22 Astryx tests, 40 CI planner tests, and Biome
  passed. A further planner assertion confirms that edits to the generator's
  test file select the general code lane, which always runs the Astryx gate;
  no CI rule change was needed. The generator and its later fail-closed
  dependency parser remain unchanged.
- #3115: another ablation found that an invalid `Retry-After-Ms` suppressed
  an otherwise valid `Retry-After` on the same retryable response. The parser
  now validates each candidate independently, preferring valid milliseconds
  and falling back to valid seconds or an HTTP date. The new regression failed
  before the change and passed afterward (20 classification tests); Runtime
  build and Biome passed. This does not change retryability or constitute a
  full #3115 replacement.
- #3544: a UI ablation showed Host-admitted rows remained draggable when the
  queue revision was unavailable, even though editing was disabled. The queue
  component now gates both the drag affordance and drop submission on a known
  revision. Another failing ablation showed an old drag could reorder a newer
  projection after the Host revision changed mid-drag; the drag now retains
  its starting revision and discards the drop when it differs. Both tests
  failed before their respective fixes and passed afterward (6 queue
  component tests); UI build, Desktop build, the Side Chat native-reorder and
  reconnect Electron E2E, and Biome passed. This is not a complete rewrite
  of the 35-file mixed-author feature.
- #2967: a new boundary test showed the audit writer could append a record
  across `MAX_AUDIT_BYTES` without recording `audit_truncated` until another
  event arrived. The writer now checks the encoded record length before
  appending and emits the marker immediately on overflow. Another ablation
  showed permissive UTF-8 decoding counted a corrupt JSON string as a valid
  `policy_error`; the artifact reader now decodes each raw line strictly,
  preserving the existing score and missing-log rules. Python 3.13 Harbor
  tests (93 total, 13 skips) and 22 Eval audit artifact tests passed. These
  are scoped fixes, not an independent replacement of all five original
  commits; the first Grok-tagged commit predates the selected policy date.
- #3008: a new test exposed that CONNECT classification trusted `pretty_host`
  over the actual tunnel destination, allowing a spoofed Host header to hide a
  blocklisted target. It now classifies `request.host`; missing targets fail
  closed. A further ablation showed malformed CONNECT authorities (userinfo
  and path delimiters) and out-of-range ports were still accepted as benign
  destinations. Host/port parsing now rejects those inputs while retaining
  valid IPv6; Python 3.13 Harbor tests (96 total, 13 skips) passed. The live
  mitmproxy regression also passed in PR CI; it remains unavailable locally
  because the Docker daemon does not respond. #3017 owns the later raw-TCP
  closure behavior; do not roll that implementation back as part of #3008.

### Coordinated minimal-core rewrite (September 27, 2026)

The seven surviving behaviors were then rewritten together around one small
authority per concern. This is the independent first-pass replacement of their
current cores; later features that consume those cores remain in place.

| PR | Rewritten current core | Retained boundary |
|---|---|---|
| #3008 | CONNECT target normalization is now a pure `(host, port) -> URL` function; the mitmproxy hook only adapts request fields and fails closed. | #3017's raw TCP/TLS layer handling remains authoritative. The live mitmproxy test passes in PR CI. |
| #2967 | Audit writing has one byte encoder and append/truncate path; TypeScript reading has one strict line decoder and one statistics pass. | Trial attribution and scoring semantics remain unchanged. |
| #3048 | Live seed state is reduced from two generation counters to one generation token plus one readiness bit. | Observation subscription, transcript publication, and later recovery orchestration remain consumers of the state machine. |
| #3066 | Both direct trials and the process runner now use the same scoped framework context; runner completion restores its caller's context. | Explicit `install` remains only for modules/tests that intentionally bootstrap `relay_agent` outside the runner. |
| #3078 | The checker is a pure generated-versus-committed comparison with direct drift tests; the CLI is only file I/O and reporting. | #3883's later fail-closed Astryx dependency parser remains the generator authority. |
| #3115 | Retryability, header normalization, and bounded `Retry-After` parsing live in an independent pure policy module. | Provider error evidence classification and Host/UI countdown projection consume that policy. |
| #3544 | Exact queue permutation validation and UI drag movement share a Core policy; Host remains the revision authority and rejects stale mutations. | Later Host admission, receipt durability, WorkHub, Side Chat, and steering behavior remain around the shared order core. |

The subtraction pass removed the obsolete `readyGeneration`, process-lifetime
framework installation in the runner, duplicate CONNECT flow parsing,
classification-local retry tables/header parsing, and separate Host/UI reorder
algorithms. No compatibility branch or fallback was added.

Verification after merging `origin/main` at `3f44315dd`:

- 96 Python Harbor tests pass (13 skipped); 22 egress artifact and 41 Eval
  lifecycle tests pass.
- 89 Desktop seed/observer/streaming tests, 23 Runtime retry/classification
  tests, 177 Runtime Host coordinator/protocol tests, the focused 87-test
  protocol suite, 6 UI queue tests, and 3 Core order-policy tests pass.
- Desktop and all workspace dependencies build; the 301-file inventory gate,
  22 Astryx tests, and 40 CI planner tests pass.
- The final upstream merge boundary passes 72 selected Desktop main tests and
  11 UI queue/attachment tests; Desktop preload, main, renderer, and Storybook
  typechecks pass.
- The four streaming-remount Electron tests, the Side Chat native reorder /
  reconnect test, and the WorkHub queue/steering lifecycle test pass through
  the Desktop workspace test entrypoint.
- Direct root-level Playwright invocations were discarded as invalid evidence:
  they launched Electron with the repository root as `.` and failed during
  fixture setup before product assertions ran.

### Remaining 21: current disposition

These are the 25 candidate PRs minus the four narrow replacements above. A
scoped fix is **not** a whole-PR rewrite, and a removed feature is not a
reason to restore its old implementation just to revert it again.

| Disposition | PRs | Next evidence or action |
|---|---|---|
| Deleted or superseded original path (8) | #3063, #3118, #3119, #3102, #3104, #3117, #3069, #3106 | Preserve the current replacement/removal; #3117's current fixture and #3106's current startup boundary have focused passing regressions. |
| Mixed or uncertain attribution (2) | #3364, #3123 | Keep Maka-authored formatter and required ASF header; resolve #3123 squash-versus-original provenance with maintainers. |
| Active code with rewritten current cores (7) | #3008, #2967, #3048, #3066, #3078, #3115, #3544 | Minimal authorities, subtraction/failure-injection ablations, and focused regressions are complete; the #3008 live proxy test passes in PR CI. |
| Active test, fixture, or mixed feature with passing regression only (3) | #3101, #3111, #3459 | Preserve the current test/fixture behavior: #3101's current Electron assertion passes, #3111 now covers owner release on failed publish, and #3459's tagged follow-ups are isolated and tested without reverting its untagged feature commits. |
| Documentation-only mixed-tool PR (1) | #4345 | Preserve the current document with the factual correction; include it in the project/legal provenance decision. |

The branch is built against `3f44315dd`: `npm run build:with-deps` passes,
along with the focused suites listed above and six real Electron tests. These
checks do not substitute for project/legal acceptance of the remediation. The
live proxy regression and the full Linux, macOS, and Windows PR checks passed
on the pushed review branch before the final protocol-epoch, upstream-merge,
and documentation updates; those final updates require one new CI pass.

## Project, legal, and release handoff

This review deliberately does not make a legal determination. The ASF
[Generative Tooling Guidance](https://www.apache.org/legal/generative-tooling.html)
requires terms that do not restrict use of generated output inconsistently
with the Open Source Definition and directs newly discovered concerns about a
tool's terms to `legal-private@apache.org`. The ASF
[Legal Affairs Committee](https://www.apache.org/legal/) also identifies LEGAL
JIRA and `legal-discuss` as the normal public channels for policy questions.
The project should choose the appropriate channel and record the resulting
decision; this PR supplies the engineering inventory and remediation evidence.

Release tag `v0.2.0-incubating-rc2` (`54542021a`) contains all 25 candidate
squash commits. If the project/legal conclusion accepts the contributions or
this remediation, that tag needs no code change from this review. If it
requires different remediation, `main` must first contain the accepted result
and a later release candidate must be cut from that state; recutting the same
tree would not change the inventory.

[PR #5746](https://github.com/apache/maka/pull/5746) pauses future
Grok-generated contributions. Draft PR #5747 and this document review the
historical merged contributions. Keep this inventory attached to #5747 while
the decision is pending; after disposition, maintainers can retain the final
record here or move process tracking to the selected issue/legal channel.

## Review protocol

For each row, verify the original behavior and tests against current `main`,
identify subsequent changes or removals, and record the current affected files
and an explicit disposition. Do not count a rewritten commit message, a
reformat, or a no-op reimplementation as a provenance remedy. Any replacement
must be an independently reasoned change with behavior and regression evidence;
the earlier history and contributor disclosures remain intact. The scope and
acceptability of any remediation need Apache project/legal review.

## Open work

- [x] Triage all 25 original changes by path, size, and current path presence.
- [x] Read original commit trailers and compare branch history with the merged
      diff for the 25 candidate PRs.
- [x] Finish the behavior and test tracing for the remaining active changes;
      no-code deletions and mixed-author PRs are tracked separately above.
- [x] Record which changes are still material, superseded, or mixed with other work.
- [ ] Decide the appropriate action with the project and ASF legal discussion.
- [x] Implement and locally verify #3082, #5223, #3070, and #3099 in reviewable slices.
- [x] Independently rewrite the current cores retained from #3008, #2967,
      #3048, #3066, #3078, #3115, and #3544 around minimal pure authorities.
- [x] Run #3008's live mitmproxy regression in PR CI with a responsive Docker
      daemon.
- [x] Complete selected subtraction and failure-injection ablations at every
      rewritten core and retain later-dependent orchestration only where its
      own focused regressions pass.
- [ ] Converge CI and project/ASF legal review on draft PR #5747.
