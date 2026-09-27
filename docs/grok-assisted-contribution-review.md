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

**Baseline:** `d2f19f400` (2026-09-27). **Status:** all 25 original-commit
inventories and current behaviors are reviewed. The current branch independently
reimplements the primary live cores for the nine active implementation entries
identified below and reduces branch-head squash attribution from 3,935 to 2,015
lines. The remaining attribution still needs to be split across mixed authorship,
tests, later edits, removed behavior, and retained supporting slices. Project and
ASF legal acceptance also remains open.

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

### Squash-line survival on current main and the PR head

The following measurement resolves each mainline squash commit to its full SHA,
counts lines added by that commit, and uses `git blame -w -M --line-porcelain`
on `origin/main` at `d2f19f400` and on PR head `77d6987e5`. It is a stronger
survival signal than path presence, but it is not a generated-line classifier:
mixed-origin PRs are not split by original commit, `-C` copy detection is not
enabled, and `-M` can reattribute moved lines. Counts can increase after later
edits or moves, so every exception still needs commit-level review.

| PR | Added lines | Base survival | PR-head survival |
|---:|---:|---:|---:|
| #3008 | 180 | 166 | 81 |
| #2967 | 678 | 651 | 258 |
| #3048 | 462 | 287 | 175 |
| #3063 | 0 | 0 | 0 |
| #3066 | 201 | 129 | 57 |
| #3070 | 177 | 137 | 24 |
| #3078 | 114 | 89 | 25 |
| #3082 | 116 | 66 | 23 |
| #3099 | 129 | 86 | 12 |
| #3101 | 54 | 42 | 42 |
| #3102 | 39 | 4 | 4 |
| #3104 | 20 | 17 | 17 |
| #3106 | 279 | 139 | 139 |
| #3111 | 59 | 57 | 73 |
| #3115 | 429 | 407 | 124 |
| #3117 | 282 | 252 | 252 |
| #3118 | 0 | 0 | 0 |
| #3119 | 2 | 1 | 1 |
| #3123 | 48 | 0 | 0 |
| #3069 | 200 | 0 | 0 |
| #3459 | 288 | 150 | 154 |
| #3364 | 118 | 111 | 111 |
| #3544 | 1713 | 1090 | 420 |
| #4345 | 22 | 22 | 18 |
| #5223 | 43 | 32 | 5 |

The base measurement finds 3,935 surviving squash-attributed lines; the PR
head retains 2,015. Four entries have no surviving added output: #3063 and
#3118 are deletion-only, while the only #3123 file and both #3069 files were
later deleted. The reduction records material replacement of the active cores,
but it is not a completion metric: the largest remaining concentrations are
#3544, #2967, #3117, #3048, and #3459, and several are mixed-author or test-heavy
PRs. The behavioral and attribution review below handles those current
boundaries rather than treating squash blame as a generated-line classifier.

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

### Narrow slices and revert-state probes

The following work was done against the 2026-09-27 baseline, preserving later
changes. It does not erase the original history or settle ASF legal questions.

| PR | Revert-state evidence | Current change and status |
|---:|---|---|
| #3082 | Removing the PTY exit reconciliation made the delayed-persist test return `running` instead of `completed`. | Reconcile the control reply after persistence against finalization, then mark terminal observations. Replaced the Grok-authored test with a fresh test that pauses storage and observes driver exit without monkeypatching the driver prototype. Runtime build, shell-run-manager suite (62 pass, 4 platform skips), and Biome passed. |
| #5223 | Removing the directory check made the regular-file test fail with `Missing expected rejection`. | Check the canonical path's stat before Git discovery and reject non-directories with `TypeError`. Replaced the original test with Git/non-Git file cases, registration non-mutation, and a directory control. Storage build, project-catalog suite (23 pass), and Biome passed. |
| #3070 | Removing explicit nested-project selection made registration return the parent project's ID and broke relinking to a child directory. | Make resolution intent explicit: selected paths retain a nested folder identity, while historical paths and selected repository roots keep Git identity. Tests pass; current-head attribution is 24 lines pending classification. |
| #3099 | Disconnecting the migrated rail store's grouping read/write made a fresh store lose the selected grouping (`undefined` persisted value). | Keep all rail layout persistence behind one layout module and store. Tests pass; current-head attribution is 12 lines pending classification. |

The #3082 and #5223 revert-state commits are separate from the replacement
commit to make the failure evidence inspectable. They are not safe to merge
without the following replacement. #3070 and #3099 have tested behavior fixes
but remain open for implementation replacement. The remaining 23 entries are
tracked below: nine active implementations require further replacement, six
paths appear deleted or superseded, two dispositions are reopened, two are
mixed or uncertain attribution, three are test/fixture or mixed-feature
regressions, and one is documentation-only.

Six narrow paths have been traced to a no-code disposition rather than an
identical revert/reapply. Two additional candidates (#3117 and #3106) have
plausible supersession evidence but are reopened because their squash-attributed
line counts did not change. None is counted as a replacement:

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
- #3117 **(reopened)** deleted the legacy `llm-connections.json` store. Current storage and
  Desktop main source has no production reference to that file or
  `createConnectionStore`; the fixture writes to the Runtime Policy catalog
  through its current storage authority. Its fixture test passes and asserts
  the old JSON file is not created (rerun against the current Desktop build).
  The fixture and related migration edits remain active and require their
  own review. Split those surviving lines by behavior and later authorship
  before accepting the supersession disposition.
- #3069 only added local transcript-search tests; both original test paths
  were subsequently deleted (#4877 and #5531). Search now uses the Recall
  pipeline. The current multi-host Recall search tests pass (9 tests), but
  restoring the old tests would target a retired local-scan implementation.
- #3106 **(reopened)** originally sent `--desktop-e2e` through the production candidate CLI
  and launcher. #3226 later separated the E2E execution entry into a
  `test-only` module and made the production candidate reject that flag. The
  current candidate/desktop tests pass (35 tests), including isolation from
  test-only modules. Do not restore the old production flag, but split the
  surviving startup and candidate wiring by behavior and later authorship
  before accepting the supersession disposition.

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
ordering assertions. The replacement removes `completeLiveContentSeed` and its
parallel generation guard from AppShell, and makes the observation attempt the
single visibility authority. The current live-content, observer, handoff, and
streaming-remount regressions pass. Squash attribution falls from 287 base lines
to 175 at the current head; the remainder needs original-commit and later-edit
classification rather than another blind AppShell rewrite.

#3101's only squash change modified the streaming-remount E2E to sample on
animation frames instead of body mutations. The current test has since gained
other assertions; the full file passes in a real Electron window (4 tests).
This validates the existing assertions, not an independently rewritten test.

#3544's first six original commits are Grok-tagged and the last three are
Codex-tagged. The replacement removes the retained per-entry mutation flow and
rebuilds it around an exact Host-owned queue mutation protocol, one executor,
queue-state helpers, Desktop IPC actions, and a UI controller. Reorder commands
carry the drag-start revision to the Host; stale mutations reach the existing
error path instead of being silently discarded in the Client. Empty reorder
remains a compatible no-op, so only one protocol epoch is required. Runtime
Host, UI, Desktop, typecheck, and production renderer builds pass. Squash
attribution falls from 1,090 base lines to 420 at the current head; because the
original PR is mixed-tool and test-heavy, those remaining lines require
commit-level classification rather than treating all 35 files as one authored
unit.

#3115's rate-limit classification, Host retry projection/continuity, and UI
countdown remain live. The replacement isolates retryability, normalized
headers, bounded delay parsing, and retry-reason projection in a pure policy;
Runtime imports that policy directly and the Host projection is rebuilt around
the policy result. Standard `Headers`, invalid millisecond fallback, reconnect,
reduced-motion, and clock-rollback regressions pass. Squash attribution falls
from 407 base lines to 124 at the current head; remaining UI copy and tests need
classification, not another retry-policy implementation.

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

### Replacement evidence and remaining attribution

- #3066: framework selection is process-local because the selected relay base
  class is fixed at module import and each production trial has its own process.
  `run_trial` installs the argv-selected framework once before framework module
  imports; the unsupported `ContextVar` isolation claim and duplicate runner
  scope are removed. The focused Python 3.12 suite passes 58 tests (2 skipped).
- #3078: the inventory checker now exposes a pure drift comparison, with tests
  for exact bytes, independently stale Markdown, and missing/extra paths. The
  CI planner also recognizes the new test. The current 302-file inventory check
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
  build and Biome passed. This regression is retained by the later independent
  retry-policy and Host-projection replacement.
- #3544: UI dragging requires a known Host revision and always submits the
  captured revision. The Host, not a client-side projection comparison, decides
  whether that revision is stale and returns the conflict through the existing
  action error path. Eight focused UI queue tests and the Desktop queue workflow
  pass.
- #2967: a new boundary test showed the audit writer could append a record
  across `MAX_AUDIT_BYTES` without recording `audit_truncated` until another
  event arrived. The writer now checks the encoded record length before
  appending and emits the marker immediately on overflow. Another ablation
  showed permissive UTF-8 decoding counted a corrupt JSON string as a valid
  `policy_error`; the artifact reader now decodes each raw line strictly,
  preserving the existing score and missing-log rules. Python 3.13 Harbor
  tests (93 total, 13 skips) and 22 Eval audit artifact tests passed. These
  regressions are retained by the replacement audit writer/reader boundaries;
  the first Grok-tagged commit still predates the selected policy date and
  requires separate attribution.
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

### Independent replacement pass (September 27, 2026)

The current branch replaces the primary live authority for each of the nine
active implementation entries, removes the superseded paths, and adds focused
regressions at the new boundaries. Squash attribution still survives in tests,
mixed-author commits, later-modified orchestration, and supporting code; those
lines remain review work and are not automatically classified as generated.

| PR | Independent replacement | Retained boundary and remaining review |
|---|---|---|
| #3008 | CONNECT target normalization is a pure `(host, port) -> URL` function; the mitmproxy hook only adapts request fields and fails closed. | #3017's later raw TCP/TLS handling remains authoritative; classify the 81 surviving squash-attributed lines. |
| #2967 | Audit writing uses one byte encoder and append/truncate path; reading uses strict line decoding and one statistics pass. | Trial attribution and scoring semantics remain; classify the 258 surviving lines, including the pre-policy original commit. |
| #3048 | Observation attempts are the single live-content visibility authority; the duplicate AppShell seed completion path is removed. | Transcript publication and later recovery remain consumers; split 175 surviving mixed-tool lines. |
| #3066 | The runner installs one process-local framework selection before importing relay modules. | Relay modules intentionally bind their base class at import; classify 57 surviving lines. |
| #3070 | Explicit chooser paths and historical cwd resolution use separate project-location intents. | Classify 24 surviving lines after later catalog changes. |
| #3078 | The checker is a pure generated-versus-committed comparison with direct drift tests; the CLI only performs I/O and reporting. | #3883's later fail-closed parser remains authoritative; classify 25 surviving lines. |
| #3099 | All rail layout keys and read/write helpers live behind one layout module and store. | Classify 12 surviving lines after later navigation work. |
| #3115 | Retryability, header normalization, bounded delay parsing, retry reason, and Host projection consume one pure policy. | Classify 124 surviving UI/test/support lines. |
| #3544 | Queue mutations use one Host protocol/executor/state path, Desktop actions, and UI controller; drag-start revision is fenced by the Host. | Split 420 surviving lines across mixed Grok/Codex commits, tests, and later queue orchestration. |

The subtraction pass removed the obsolete seed completion path, duplicate
CONNECT parsing, classification-local retry tables/header parsing, separate
queue mutation paths, and split rail persistence. No compatibility branch or
fallback was added. The remaining squash-attributed lines still require
commit-level attribution and behavior review before final disposition.

Verification after merging `origin/main` at `d2f19f400`:

- 96 Python Harbor tests pass (13 skipped); 22 egress artifact and 41 Eval
  lifecycle tests pass.
- 89 Desktop seed/observer/streaming tests, 23 Runtime retry/classification
  tests, 177 Runtime Host coordinator/protocol tests, the focused 87-test
  protocol suite, 6 UI queue tests, and 3 Core order-policy tests pass.
- Desktop and all workspace dependencies build; the 302-file inventory gate,
  22 Astryx tests, and 40 CI planner tests pass.
- The final upstream merge boundary passes 72 selected Desktop main tests and
  11 UI queue/attachment tests; Desktop preload, main, renderer, and Storybook
  typechecks pass.
- The final Runtime and Runtime Host upstream merges plus the rewritten retry
  and protocol policies pass 207 focused computer-use, transport, provider,
  and protocol tests.
- The latest overlapping provider-classification merge passes 307 AI SDK,
  provider classification, and pure retry-policy tests.
- The final UI upstream merge passes 4 focused Extensions tests, the 302-file
  inventory gate, and all 22 Astryx inventory tests.
- The four streaming-remount Electron tests, the Side Chat native reorder /
  reconnect test, and the WorkHub queue/steering lifecycle test pass through
  the Desktop workspace test entrypoint.
- Direct root-level Playwright invocations were discarded as invalid evidence:
  they launched Electron with the repository root as `.` and failed during
  fixture setup before product assertions ran.
- The review-fix pass at `77d6987e5` passes 8 UI queue tests, 57 Runtime retry
  and classification tests, 24 Storage catalog tests, 89 focused Runtime Host
  protocol tests, 28 Desktop navigation/queue tests, and 58 Python 3.12 Eval
  tests (2 skipped). Desktop typechecks, the production renderer build, Biome,
  ASF headers, and `git diff --check` also pass.

### Current disposition after the replacement pass

A removed feature is not restored merely to revert it again, and squash-level
blame is not used to reclassify mixed-author or later-modified lines.

| Disposition | PRs | Next evidence or action |
|---|---|---|
| Deleted or superseded original path (6) | #3063, #3118, #3119, #3102, #3104, #3069 | Confirm that the surviving incidental lines do not implement the original behavior. |
| Disposition reopened (2) | #3117, #3106 | Their branch-head survival counts are unchanged; separate current production behavior, tests, and later-author work before deciding whether they are superseded. |
| Mixed or uncertain attribution (2) | #3364, #3123 | Keep Maka-authored formatter and required ASF header; resolve #3123 squash-versus-original provenance with maintainers. |
| Reimplemented active cores; remaining attribution review (9) | #3008, #2967, #3048, #3066, #3070, #3078, #3099, #3115, #3544 | Classify the surviving test, mixed-author, later-edit, and supporting slices; run final ablations against the replacements. |
| Active test, fixture, or mixed feature with passing regression only (3) | #3101, #3111, #3459 | Preserve the current test/fixture behavior: #3101's current Electron assertion passes, #3111 now covers owner release on failed publish, and #3459's tagged follow-ups are isolated and tested without reverting its untagged feature commits. |
| Documentation-only mixed-tool PR (1) | #4345 | Preserve the current document with the factual correction; include it in the project/legal provenance decision. |

The branch is built against `d2f19f400`; the focused suites listed above,
Desktop production renderer build, typechecks, Biome, ASF headers, and six real
Electron tests pass. These checks do not substitute for project/legal
acceptance. CI for the current head is the final cross-platform compatibility
check.

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
- [x] Implement and locally verify the narrow #3082 and #5223 replacements.
- [ ] Split mixed-origin, test-only, later-modified, and independently authored
      exceptions from retained production implementation.
- [x] Independently replace the primary live cores from #3008, #2967, #3048,
      #3066, #3070, #3078, #3099, #3115, and #3544 and remove the superseded
      implementation paths.
- [ ] Classify the 2,015 surviving squash-attributed lines across original
      commits, tests, later edits, mixed authorship, and retained supporting
      slices; replace any remaining production implementation that survives
      that classification.
- [ ] Re-evaluate #3117 and #3106, whose branch-head survival counts are
      unchanged, and any other disposition unsupported by line/behavior evidence.
- [x] Run #3008's live mitmproxy regression in PR CI with a responsive Docker
      daemon.
- [ ] Rerun subtraction and failure-injection ablations against the completed
      replacements and retain later-dependent orchestration only where its own
      focused regressions pass.
- [ ] Publish final per-PR before/after survival evidence and converge CI,
      project review, and ASF legal review on PR #5747.
