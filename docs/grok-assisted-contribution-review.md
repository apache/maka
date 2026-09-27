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

**Baseline:** `d89ccce01` (2026-09-27). **Status:** original-commit inventory
reviewed; four narrow replacements verified locally; remaining behavior reviews open.

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
so it is outside this inventory. Closed, unmerged PRs are not in the current
mainline and are tracked separately: #4809, #4899, #5102, #5342, #5349,
#5350, and #5497.

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

This pass inspected each merge's changed paths and size against the baseline,
and sampled the active #3118 and #5223 implementation paths. "Present" means
the path still exists, **not** that the original lines survive or that its
behavior is unchanged. The detailed line-level and behavioral review is still
open; these observations are not a replacement decision.

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

The largest original change, #3544, touched 35 files and changed more than
2,000 lines; #3117 removed over 1,600 lines. A single wholesale rewrite would
cross separate storage, protocol, Desktop, Eval, and security review boundaries.
The deleted-only #3063 and absent test paths in #3123/#3069 have no direct
current file to "rewrite". Review should identify a present behavior before
proposing a replacement, and high-risk egress/Host paths need their own focused
tests and review.

### Revert feasibility probe

On 2026-09-27, a disposable worktree at `d89ccce01` (then-current
`origin/main`) attempted `git revert --no-commit dc9d2f0dd` for #3544.
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
| #3070 | Removing explicit nested-project selection made registration return the parent project's ID and broke relinking to a child directory. | Make resolution intent explicit: selected paths retain a nested folder identity, while historical paths and selected repository roots keep Git identity. Storage build, project-catalog suite (24 pass), Desktop nested-selection test, and Biome passed. Desktop full build remains blocked by seven unrelated implicit-`any` diagnostics. |
| #3099 | Disconnecting the migrated rail store's grouping read/write made a fresh store lose the selected grouping (`undefined` persisted value). | Let the rail layout store hydrate and write grouping directly, removing the old standalone read/write helpers. Rail layout tests (6 pass), navigation boundary tests (4 pass), and Biome passed. Desktop full build has the same seven unrelated implicit-`any` diagnostics. |

The #3082 and #5223 revert-state commits are separate from the replacement
commit to make the failure evidence inspectable. They are not safe to merge
without the following replacement. The remaining 21 entries have **not** been
reverted or reimplemented; #3364 and #3123 require provenance decisions before
any broad rollback.

Three narrow paths have been traced to a no-code disposition rather than an
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

#3008 is only partly recognizable in today's Eval egress filter. Its CONNECT
host classification remains, but #3017 subsequently replaced the raw-TCP
layer-closing path, added HTTP/TLS prefix handling, and introduced live
mitmproxy tests. Reverting the #3008 squash against today's code would also
unwind later security behavior. Treat the surviving CONNECT validation as a
separate security review with unit and live-proxy regression checks.

#3070 and #3099 were replaced in the current branch after reviewing their
migrated implementations. #3070's historical cwd resolution remains distinct
from explicit nested selection. #3099's renderer reload test survives at
`apps/desktop/e2e/sidebar-project-reload.spec.ts`; its direct store tests pass,
but that Electron E2E has not yet been rerun in this branch.

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
- [ ] Trace current lines, behaviors, and tests for 18 further PRs (three
      no-code dispositions above are already traced).
- [ ] Record which changes are still material, superseded, or mixed with other work.
- [ ] Decide the appropriate action with the project and ASF legal discussion.
- [x] Implement and locally verify #3082, #5223, #3070, and #3099 in reviewable slices.
- [ ] Finish the remaining scoped reviews and any agreed replacements.
