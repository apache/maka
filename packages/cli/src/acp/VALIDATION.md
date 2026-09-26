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

# ACP validation record

## PR7 upload-tracking ablation (September 25, 2026)

In an isolated worktree at `76fc0b3b2`, the per-upload `pendingBegins`
counter and separate `trackedBegin` reference were removed. The existing
`pendingRequests` counter now defers removal until every in-flight ingest for
that identity settles. The registry and real Host Artifact/Memory suites passed
162 tests with this simplification.

Two removal controls established which surrounding coordination remains
necessary. Without the same-ID cleanup wait, all four cleanup/reopen race cases
failed because a new begin reached Host before the old abort settled. Without
the connection availability listener, the Host-replacement regression failed
with `upload_tracking_capacity` after old upload IDs occupied the bound.
After restoring both controls, the full CLI suite passed 1278 tests, skipped
3, and failed 0; repository lint and format checks passed.

## PR7 final concurrency follow-up (September 25, 2026)

Final review found that expiry cleanup could race a concurrent `begin` or
`chunk` for the same upload identity, and that upload IDs from a replaced Host
connection could still occupy the adapter's 64-ID bound. Cleanup now holds the
identity until its Host abort settles; same-ID ingest requests wait for that
cleanup. A listener starts on the first Artifact begin and clears connection-
bound tracking on Host disconnect or replacement. A successful begin restores
its tracking if the connection changed while the request was in flight.

Focused regressions cover cleanup/reopen interleaving on one Host, after Host
replacement, with a failed old abort, and with a lost new-begin response. They
also cover 64 old IDs after replacement. The original two cases failed in an
isolated worktree at the preceding head `efd5db120` and pass after repair. The
complete CLI `test:dist` passed 1278, skipped 3, failed 0. CLI
build, repository lint and format, and
`git diff --check` passed.

## PR7 ready-for-review follow-up (September 25, 2026)

After removing Draft, a fresh review against main found two P2 cases. The
adapter could retain every definitively rejected Artifact `begin`, and failed
digest commits or Host expiry could leave stale identities in its cleanup set.
It now distinguishes open or outcome-unknown uploads from definite failures,
limits unresolved identities to 64, and asks Host to abort expired identities
before admitting more. Concurrent begins with one identity retain any successful
opening. `session/close` still waits for in-flight requests and aborts the
remaining identities. The tool mapper no longer advertises a readable Artifact
when an archived tool result is already marked `missing` or `corrupt`.

New regressions cover 65 rejected begins, 65 digest-rejected commits, 64
outcome-unknown begins and the bounded cleanup on close, overlapping begins,
expired identity cleanup, and missing/corrupt archive cards. In an isolated
worktree at the preceding PR head `a7e40a763`, all six selected new regression
cases failed; they pass with this repair. CLI build and typecheck passed. The
complete CLI `test:dist` passed 1273, skipped 3, failed 0. Repository lint,
format, and `git diff --check` passed.

## PR7 main refresh and review fixes (September 25, 2026)

PR7 was merged locally with Apache main `9c96bb716` after PR6 landed. The
combined ACP registry retains PR6 load/resume and Turn observation behavior.
Review follow-ups keep an open upload tracked after a conflicting repeated
`begin`, remove the adapter-only upload count limit that could outlive Host
staging, and clear an obsolete Artifact reference when an authoritative tool
result is corrected.

The refreshed CLI dependency build, CLI build and CLI typecheck passed. The
focused Artifact/Memory child-process, Session registry and event-mapper suites
passed 179 tests. The full CLI `test:dist` passed 1267 tests, skipped 3 and
failed 0. Repository lint and format checks passed. New registry regressions
cover conflicting upload identity and repeated failed commits; a mapper
regression covers corrected tool-result metadata.

After commit `8ab023995`, an isolated ablation removed the duplicate-ID
`Set` from Artifact reference projection. `ToolResultContent.kind` is exclusive,
so one result can contribute at most one reference; the simplified projection
passed 31 event-mapper and real ACP/Host child-process tests and was retained.
Removing the per-Session in-flight Artifact wait from `session/close` stalled
its close-race regression, so that wait remains in place. Reintroducing the
64-ID adapter cap made the failed-commit regression fail with
`upload_tracking_capacity`, confirming that the cap cannot remain without
tracking Host release and expiry.

## PR7 Artifact and Memory extensions (September 24, 2026)

Based on Apache main `0a5b9dc9518089c44d183fc4a623a3681e5e8fc7`.
The production adapter registers five concrete `_maka/` request routes and
passes the Host protocol input decoders and typed results through the existing
lazy ACP Runtime Host connection. No Host wire schema or compatibility epoch
changed.

The new `acp-artifact-memory-child-process.test.ts` uses the official ACP
SDK against a real ACP stdio child and a real in-process execution Runtime Host:

- Multipart upload of 102,401 binary bytes, repeated chunk/commit, conflicting
  offset and checksum, multi-chunk export with byte-for-byte comparison, empty
  Artifact, 129-item pagination, stale revision, missing-after-delete, and
  invalid request handling.
- A real model-driven `tool_search → Read` call on an uploaded image. The
  terminal tool update includes its canonical Artifact reference; the same
  ACP client reads back the exact image bytes through the query extension.
- Memory `remember → state/entries/document query → subsequent prompt`.
  The captured provider request for the owning Session contains the sentinel;
  the other Session's request does not. The test also checks stale revision,
  multipart replace and digest rejection, and closed-Session scope rejection.
- Policy-disabled Memory and unknown/invalid private methods preserve their
  explicit domain or JSON-RPC results. SDK requests with valid `_meta` are
  accepted without leaking metadata into strict Host inputs; malformed `_meta`
  is rejected.
- The same ACP connection survives a real Host stop and replacement. Artifact
  queries work after recovery; an incomplete upload from the old connection
  returns Host `not_found` instead of continuing with stale bytes. Memory query
  and Session close remain usable.

The registry unit suite covers close racing an in-flight Artifact begin:
close waits for its result, aborts staging and opens no subscription. It also
checks that a dispatched, lost Memory mutation response reports
`request_interrupted` with `dispatch: dispatched` and is not replayed.
An Artifact begin whose dispatched response is lost is retained for close-time
abort.

Verification on this worktree:

| Check | Result |
| --- | --- |
| CLI dependency build, CLI build and typecheck | Passed. |
| Full CLI `test:dist` on the final implementation | 1169 passed, 3 skipped, 0 failed. |
| Focused Runtime Host Artifact and Memory protocol/coordinator/two-client tests | 30 passed, 0 failed. |
| Runtime Host execution-model-composition file | 37 passed, 0 failed on isolated rerun. |
| `npm run lint`, `npm run format:check`, ASF header check | Passed after formatting the final edit. |
| CLI third-party notices | Passed after applying the repository's dependency patches to the `npm ci --ignore-scripts` tree. |
| Protocol epoch guard against `0a5b9dc` | Passed; no protocol change, epoch remains 183. |

The first combined Host test run had one timed-out
`production Host publishes and retires an implementation child patch` case.
It passed alone and in the complete 37-test execution-model file on rerun.
The initial notice check was blocked by the unpatched `run` package peer range
in the local `--ignore-scripts` install; applying the checked-in patches made
the check pass.

The SDK/child-process tests exercise the production routes, not a mock ACP
handler. The Runtime Host service runs in the test process, while the ACP
server runs in a child process. A third-party editor's private-extension UI
was not smoke-tested; the earlier PR5 Zed record below concerns standard
tool and permission flow only.

## PR6 adjacent restore and teardown review fixes — September 24, 2026

Starting from PR #5621 head `d05fbb25f`, formal registry regressions were added
before the implementation changed. Four assertions failed on that head:
`session/load` and `session/resume` each lost a live prompt's interaction client
after a cwd mismatch, a repeated resume invoked successor Turn output before a
queued chunk from the prior Turn, and close followed by dispose released the
Host connection before an adopted Turn's Stop response. The single-resume
ordering control passed before it was extended to assert successor pending
interaction delivery. The final nine focused tests failed against the
`d05fbb25f` production modules and passed after repair. Additional tests cover
cancelled history replay after client replacement, two overlapping failed
restores, an older explicit resume failing after a newer restore reuses the same
context object, a successor's pending interaction behind the output barrier,
and an adopted Turn Stop that fails after its Host terminal fact.

Every observation's in-flight Stop now belongs to the cancellation and close
wait, including non-admitted Turns. A terminal snapshot cannot make close
discard a pending Stop response; disposal keeps the connection alive until
that response settles, including rejection. Restore rollback tracks the actual
interaction client it replaced and invalidates failed context/client leases,
so later operations cannot restore a stale client. A failed load before MCP
reconfiguration no longer starts a compensating reconfiguration. Repeated
load/resume defers a successor already queued behind the channel's consumer
barrier. When the channel admits that successor, the shared adoption path also
replays its pending interactions through the existing deduplicating owner.

Validation on macOS and Node 24.19.0; repository scripts were rerun with the
required npm 11.19.0:

| Check | Result |
| --- | --- |
| Formal ACP registry suite | 136 passed, 0 failed. The final nine focused tests were 9 failed on baseline and 9 passed after repair. |
| Full CLI dist suite, concurrency 4 | 1245 passed, 3 skipped, 0 failed; includes official SDK and real Host child-process tests. |
| Full Runtime Host dist suite, concurrency 2 | 2093 passed, 12 skipped, 0 failed after building both bundled ACP plugins and applying repository dependency patches. |
| Root build and workspace typecheck | Passed after building workspace dependencies. |
| Root lint/format, ASF headers, CLI notices, `git diff --check` | Passed. |

The first Host run preceded the bundled plugin builds and dependency patches:
two tests failed for those missing setup steps, and one execution recovery
test timed out waiting for a terminal fact. The recovery case passed in the
serial three-file rerun; after the remaining dependency patch was applied, its
affected profile test and the complete Host suite passed. Desktop Electron E2E
and Zed were not rerun for this follow-up; prior evidence below remains tied to
its recorded head. No Host protocol or compatibility epoch changed here.

## PR6 retained attachment and Stop review fixes — September 24, 2026

Starting from PR head `c50987a6b`, two isolated reproductions failed when
`session/load` or `session/resume` reused an attachment that had observed another
client's Turn before restore. A separate reproduction failed when an explicit
`turn.resume.start` observer requested Stop after output delivery failed and
dispose closed the Host connection before the Stop response. These reproductions
were kept outside the source tree; the repaired behavior is covered by formal
registry tests.

Restore now adopts the current nonterminal root on the retained channel and
replays its pending interactions through the same interaction owner. The owner
uses the restoring client's capabilities and callbacks, while the existing
history/live barrier orders replay ahead of live output. Output-failure Stop is
retained on the Turn observation and awaited before observation release and Host
connection teardown. Admission result transitions used by snapshot and query
callers are owned by the admitted observation.

Validation on macOS and Node 24.19.0 after repair:

| Check | Result |
| --- | --- |
| Formal ACP registry suite | 127 passed, 0 failed, including retained attachment load/resume with pending interaction and live output, plus close/dispose during a deferred Stop. |
| Full CLI dist suite, concurrency 4 | 1236 passed, 3 skipped, 0 failed; includes official SDK child-process tests against a real Host. |
| CLI build/typecheck, scoped lint/format, ASF headers, `git diff --check` | Passed. |

Runtime Host, Desktop, Electron and Zed suites were not rerun for this follow-up;
their earlier results below remain tied to their recorded heads.

## PR6 CI and remaining review fixes — September 24, 2026

This follow-up starts from `876dffea3` and resolves the three remaining P2
findings plus duplicated admission transitions. Restore-cancellation tests now
wait for subscription-open, transcript-read and close lifecycle events. Other
asynchronous assertions use a real elapsed-time deadline and `setImmediate`,
which continues to work in tests that mock `setTimeout`; a fixed count of event
loop turns did not allow filesystem work to finish reliably on CI.

Host now compares the complete normalized Session MCP configuration identity
atomically before accepting another scoped provider. A differing or empty list
fails with `session_binding_conflict` while the other provider remains attached.
Equivalent configurations still support live interaction restoration. After the
original owner closes its Session attachment, the new configuration becomes
callable. A frozen disconnected provider can reconnect using its authenticated
identity; another client cannot silently take over that binding. The optional
configuration identity and typed conflict advance the Host compatibility epoch
to 185; both compatible-change declarations were re-pinned and reviewed.

The existing Session channel event queue retains authoritative terminal facts by
Turn and run until consumption, including when a successor has already completed
behind the initial output barrier. No separate terminal-history map is introduced. Completed,
failed and cancelled status is delivered after the exact Turn's output. History
replay preserves attachment-only user rows, displaying attachment name, media
type and size, with canonical references in `_meta["_maka/attachments"]`. Prompt
and explicit resume now share the admitted observation's dispatch, settlement,
failure and waiter transitions.

Four focused regressions were run against an isolated copy of `876dffea3`'s
production modules: two attachment-history assertions, the initial-readiness
terminal case, and the official SDK two-live-client MCP conflict case. All four
fail on that baseline and pass with the fix. The repaired suite additionally
covers all three terminal outcomes with and without a successor Turn, both
load/resume with changed/empty MCP lists, equivalent configuration restoration,
replacement after close, frozen-provider reconnect, and real Host replay of a
resource-link-only prompt. A follow-up regression with two Turns completing during
readiness fails on `4efbae5c5` before this queue-based retention fix and passes
after it; all three first-Turn terminal outcomes cover this successor case.

Validation on macOS and Node 24.19.0:

| Check | Result |
| --- | --- |
| Root build and typecheck | Passed. |
| Full CLI dist suite, concurrency 4 | 1232 passed, 3 skipped, 0 failed. |
| Full Runtime Host dist suite, concurrency 2 | 2093 passed, 12 skipped, 0 failed. |
| Root lint/format, Desktop/UI knip, ASF headers, CLI notices, Windows inventory and `git diff --check` | Passed. |
| Protocol epoch guard and its tests | Passed: epoch 185; 17 guard tests passed. |

The four baseline regression failures are expected and recorded separately from
the repaired full-suite results.
Desktop Electron E2E and Zed were not rerun; their earlier evidence remains
version-bound as documented below.

## PR6 review fixes — September 24, 2026

These changes start from PR head `561b5a304`. Branch/revision source discovery
now has a concrete `_maka/session/copy-source/query` route backed by the existing
bounded Host Turn query and Session revision. The official SDK child-process
flow obtains historical Turn IDs and revisions entirely over ACP, verifies a
stale revision conflict, then creates and prompts branch/revision targets and
checks abandon/retained outcomes. No internal Host connection supplies the copy
parameters.

Initial attachment waits now honor request cancellation for load, resume, and
explicit Turn resume. The last consumer aborts initialization; a late subscription
is closed without affecting a replacement. Concurrent prompts retain the shared
attachment even before they reach its wait. Admission state lives in a typed
observation, indexed only once; close, abandon, rollback and failed attachments
share identity-checked resource detachment while retaining their distinct
execution and ownership rules.

Eight focused regression tests were run against an isolated copy of the original
head's production modules: all eight failed. The six cancellation cases cover
subscription open and transcript hydration for all three restore methods; the
other two cover the absent ACP query and ownership/paging contract. They pass
with the repair. Four shared-consumer cases additionally cover cancelling load
or prompt both before and during the other consumer's attachment wait. The
earlier load-cancellation interleaving first failed during development and passes
after preserving pending admission consumers.

Validation on macOS and Node 24.19.0:

| Check | Result |
| --- | --- |
| Root build and typecheck; final CLI rebuild and typecheck | Passed. |
| Final full CLI suite (`node --test --test-concurrency=4 'packages/cli/dist/**/*.test.js'`) | 1220 passed, 3 skipped, 0 failed. Includes the pure ACP copy workflow and all cancellation regressions. |
| Full Runtime Host dist suite | 2087 passed, 12 skipped, 3 failures waiting for the execution Host to become ready. CLI, Host and Desktop suites ran concurrently. No Host source was changed by this follow-up. |
| Serial rerun of the three affected Host test files | All 28 passed, including the three startup-timeout cases. Files: `execution-host-continuation`, `execution-host-message`, and `execution-host-queue`. |
| Full Desktop dist suite | 2841 passed, 0 failed. |
| Root lint/format, Desktop/UI knip, ASF headers, CLI notices, `git diff --check` | Passed. |
| Protocol epoch guard against `fb9df6c3d` and its tests | Passed; 17 tests passed. This follow-up does not change the Host wire protocol. |

The first Host run's failures are retained rather than presenting its result as a
clean full-suite pass. Desktop Electron E2E and Zed were not rerun for this
follow-up; their earlier evidence and version boundaries remain below.

## PR6 main integration and admission cleanup — September 24, 2026

Merged Apache `main` at `fb9df6c3d` into PR #5621. The only textual conflict was
the Runtime Host compatibility epoch: `main` had reached 183 and had assigned
179 to a different change. The merged protocol uses 184 for the ACP Session
capability replacement guard. The two compatible-change declarations introduced
by `main` were re-pinned to 184 after checking that their wire-neutral reasons
still hold. The prompt and restored-Turn admission paths now use one initializer
for their identical local state; no admission behavior was changed.

Validation on macOS and Node 24.19.0 after the merge and initializer change:

| Check | Result |
| --- | --- |
| `npm ci`, `npm run build`, `npm run typecheck`, `npm run lint`, `npm run format:check` | Passed. |
| Full CLI dist suite | 1208 passed, 3 skipped, 0 failed; includes official ACP SDK child-process tests with a real Runtime Host. |
| Full Runtime Host dist suite | 2090 passed, 12 skipped, 0 failed. |
| Full Desktop dist suite | 2841 passed, 0 failed. |
| Protocol epoch guard against `fb9df6c3d` and guard tests | Passed: 183 to 184; 17 tests passed. |
| Desktop/UI knip, ASF headers, CLI third-party notices, `git diff --check` | Passed. |
| Full Desktop Electron E2E | 34 passed, 0 failed. |

An earlier full E2E run on an intermediate merge at `fef5b937a` passed 33/34:
Side Chat `page.screenshot({ fullPage: true })` timed out after its preceding
behavior assertions passed. The focused retry passed on that tree, and the
same focused test passed on the `fef5b937a` baseline. The later full run on
`fb9df6c3d` passed 34/34. The earlier Zed smoke below was on an older PR6
head; no Zed result is claimed for this merged head. Current-head ACP
create/load/resume and interrupted-Turn coverage comes from the official SDK
tests against a real Host in the CLI suite.

## PR6 final review follow-up — September 23, 2026

This follow-up starts at pushed PR #5621 head `813c9557d`. Two further
regressions were reproduced on that head before editing. When a dispatched
`turn.resume.start` lost its response and a subsequent `turn.query` returned
`not_found`, the rejected attempt left a phantom active prompt and blocked an
idle Session's MCP change. When output delivery for a completed attached Turn
was held while the next Turn started, the prior Turn's terminal status was
lost. The initial two formal regression tests failed before the repair and
pass after it; the terminal-status test was then extended to all three terminal
states.

The registry now releases the rejected admission's observation and Turn queue
while preserving its Session, Turn, and source-run identity in the error. A
still-unknown admission remains observable. Subscription snapshots capture
terminal status on the matching Turn and run before a newer root replaces it;
status delivery waits for that Turn's output to finish. Discarded attachments
and disposed observations remain fenced from late callbacks.

Validation on macOS and Node 24.19.0:

| Check | Result |
| --- | --- |
| Full CLI dist suite | 1205 passed, 3 skipped, 0 failed. Includes the rejected resume regression, all three terminal states under blocked output, and official SDK plus real Runtime Host child-process flows. |
| `npm run build`, workspace typecheck, lint, format, ASF headers and CLI notices | Passed. |
| Desktop/UI knip and `git diff --check` | Passed. |

The independent terminal-status probe also passes. Its separate MCP probe
uses an incomplete fixture setup and stops at `mcp_not_ready`; the repository
regression uses the existing MCP fixture and verifies the resumed idle load.
The Runtime Host wire protocol is unchanged by this follow-up.

## PR6 second review follow-up — September 23, 2026

This follow-up starts at pushed PR #5621 head `62eea00ef`. Three additional
regressions were reproduced on that exact commit before editing: a failed live
history load sent `turn.stop` for an existing Host Turn; closing during an MCP
replacement left the old stdio child alive; and cancellation after an accepted
replacement issued an unguarded rollback while a second client had started a
Turn. The three independent probes and their formal regression tests failed
before repair and pass after repair.

Failed load now disposes only observations created for its new attachment
before closing the channel. The discarded attachment is fenced from late
callbacks, including those that could affect a replacement attachment. A
genuine interaction or output failure after successful adoption still stops
the exact Turn. MCP replacement retains both managers until Host publication
has a definite outcome. Close and authoritative retirement release both. A
known Host rejection restores the old manager without another Host write. If
the new provider was committed when cancellation arrives, it remains the
effective config and stays callable; a lost response retains both processes
until a later publication confirms which can be retired. The original Host
idle guard remains on every configuration replacement.

Validation on macOS and Node 24.19.0:

| Check | Result |
| --- | --- |
| Full CLI dist suite | 1201 passed, 3 skipped, 0 failed. Includes the new load, MCP close/retire/unknown-outcome/isolation regressions and the official SDK plus real Host two-client cancellation test. |
| Independent pre-fix probes | All 3 failed at `62eea00ef`; all 3 passed after repair. |
| Full Runtime Host dist suite | 2054 passed, 12 skipped, 0 failed. |
| Full Runtime dist suite | 3516 passed, 14 skipped, 0 failed. |
| Full Desktop main dist suite | 2815 passed, 0 failed. |
| Full Eval dist suite | 114 passed, 1 skipped, 0 failed; 87 Python tests passed with 12 skipped. |
| Desktop E2E same-environment comparison | On `62eea00ef`, the Side Chat case failed at `page.screenshot({ fullPage: true })` after the preceding behavior assertions passed; both WorkHub cases passed. On the repaired tree, the same Side Chat capture timed out and both WorkHub cases passed. Earlier WorkHub failures were intermittent in the focused retry. |
| `npm run build`, workspace typecheck, lint, format, ASF headers and CLI notices | Passed. |
| Desktop/UI knip and protocol epoch guard | Passed; Host protocol is unchanged from `62eea00ef` and remains at epoch 179. |

The Side Chat screenshot timeout occurs before that test's Desktop reconnect
portion, so this E2E case does not validate the remainder of its flow in either
tree. The test trace and failure location match across baseline and repair.

Zed 1.20.2 was attempted with a disposable project and the final ACP build.
The existing Zed process displayed its project trust dialog, but the computer
UI controller returned `noWindowsAvailable` for the action that would
continue. No final-head Zed prompt/load result is claimed. The temporary
model and Host fixture were stopped and its files removed; the user's Zed
process was left running.

## PR6 review repair — September 23, 2026

This follow-up starts at PR #5621 head `fd2e6a68` in a separate worktree. The
older PR6 results below describe that original head; the results in this
section describe the repaired tree.

Four regressions were demonstrated before repair. Three added registry tests
failed on the original head: an owned but unattached Session leaked a newly
opened subscription after historical replay failed; unsupported restored
elicitation left the Host Turn waiting; and a cancelled restored question
submitted its late answer when Stop failed. An MCP test held the idle check,
admitted another client's Turn, then showed that replacement was still
accepted. After repair, those regressions pass. The cancellation suite also
checks restored permission selections and a newly arriving interaction ID.

The adapter now fences an adopted Turn's interaction broker before Stop, using
the observed Session, Turn, and run identity. An adopted observation failure
stops that exact active Host Turn and reports `observation_failed` without
inventing an interaction answer. The restored interaction regressions cover
unsupported elicitation capability and method, invalid answers, and output
delivery failure. Load failure closes only the attachment it opened,
independently of prior Session ownership; retry succeeds. MCP config
changes stage a new manager while the old process remains callable, then use
an opt-in Host capability replacement that checks active and pending root
admission at its commit point. Normal dynamic tool-list publication remains
unchanged. This wire contract advances the Runtime Host compatibility epoch
from 178 to 179. Shared context construction and canonical JSON reuse remove
the two review-noted duplications.

Validation after repair on macOS and Node 24.19.0:

| Check | Result |
| --- | --- |
| Full CLI dist suite | 1194 passed, 3 skipped, 0 failed; includes official SDK and real Host multi-client ACP child-process flows, prompt/load/resume, branch/revision, MCP, TUI and close/EOF tests. A second Host client starts a live Turn after the idle read and the Host rejects the staged MCP replacement. |
| Full Runtime Host dist suite | 2054 passed, 12 skipped, 0 failed. |
| Full Runtime dist suite | 3516 passed, 14 skipped, 0 failed. |
| Full Desktop main dist suite | 2815 passed, 0 failed. |
| Full Eval dist suite | 114 passed, 1 skipped, 0 failed; its 87 Python tests also passed. |
| `npm run lint`, `npm run format:check`, `npm run build`, `npm run typecheck` | Passed across the workspaces. |
| Desktop/UI knip, ASF headers, CLI notices, protocol epoch guard, `git diff --check` | Passed. |

The first repository-wide `npm test` ran workspaces concurrently and had
unrelated fixed-deadline failures in Runtime, Desktop, and Eval. Every failing
test passed when rerun in isolation; their complete workspace suites then
passed serially as recorded above. The existing Zed third-party smoke below
was performed on the original PR6 head. A new isolated Zed 1.20.2 smoke was
attempted, but UI automation could not operate its project window, so no
post-repair Zed result is claimed. The temporary Host and model fixture were
closed and removed.

The Desktop Electron E2E run passed 30 tests and failed 4 in Side Chat and
WorkHub UI flows. An isolated retry passed the reconstruction case but still
failed 3: two screenshot timeouts and a missing WorkHub dock backdrop. This
follow-up does not change Desktop UI files; these failures remain unverified
against the original PR head.

## PR6 local implementation — September 23, 2026

Base: Apache `main` at `b004473ed`, on isolated branch
`feat/acp-session-restore`. The original Antigravity checkout was not
modified. This local implementation adds standard `session/load` and
`session/resume`, durable replay and live Turn attachment, complete stdio MCP
reconfiguration, explicit `_maka/turn/resume`, and Session branch/revision
create/abandon routes. Prompt and restored Turns now share the production
`AcpTurnObservation` consumer and the existing Session channel, mapper,
interaction broker, and MCP publication path.

The follow-up hardens MCP replacement on an already attached Session: when
the Host reports an active Turn, a changed stdio configuration returns
`session_busy` before the existing MCP manager stops its processes or changes
the publication. Equivalent configuration still reuses the live process.
Official SDK and real Host tests now also cover a live Turn's historical
prefix followed by new output without duplicate chunks, a pending permission
answered after a second ACP process loads the Session, and explicit execution
of a ready interrupted Turn. A required MCP tool missing from the replacement
provider leaves the interrupted Turn `parked/safety_check_failed`; restoring
the matching server makes explicit resume start. Repeated load replays history
while repeated resume does not. A revision target remains usable after prompt
and returns `retained` when abandoned; an unused target returns `abandoned`. A failed
historical page read releases the newly opened subscription.

On this follow-up, the complete CLI dist suite passed 1185 tests with 3
skipped and no failures. CLI build and typecheck, repository lint and format,
and `git diff --check` passed. The earlier Desktop E2E and Zed smoke results
below were not repeated because this follow-up changes only CLI code, tests,
and ACP documentation.

The official ACP SDK child-process test crossed two ACP processes against one
real Runtime Host: process A created and prompted a Session, then process B
loaded it with changed MCP configuration, resumed it with an empty MCP list,
prompted it, queried a parked Turn resume, branched and prompted the target,
created revision targets, prompted one, retained it on abandon, and abandoned
the unused target. The real Host revision and
Turn/capability suites passed 104 tests. Focused registry tests include
multi-page replay (including a fragment-only page), live/history overlap,
pending interaction restoration, close during load, exact lost-response Turn
identity, and copy revision conflict/unknown target identity.

The final full CLI dist suite passed 1178 tests with 3 skipped and no failures.
The focused ACP suite passed 214 tests before the last two registry regressions;
the final registry suite passed 89 tests. The production workspace build and
workspace typecheck passed, as did lint, format, ASF headers, CLI notices,
Desktop/UI knip, and `git diff --check`. Runtime Host source and protocol did not
change, so no compatibility epoch update was required.

Desktop Electron E2E passed all 34 tests. Zed 1.20.2 passed a third-party smoke
with a disposable project and user-data directory, an isolated Runtime Host,
and a local deterministic model fixture. In Zed, the custom ACP agent created
a Session and answered a prompt. Reloading the agent opened a new ACP process;
its logs showed `session/load`, historical `session/update` replay, and a
successful load response. Zed kept the prior exchange visible, and a second
prompt on the restored Session completed with `stopReason: "end_turn"`. The
temporary Zed settings were restored after the smoke run.

The first GitHub CI rerun exposed a test-only scheduling race: a replay-overlap
test exhausted 100 event-loop checks before its fake transcript page read began.
The fake subscription now signals page-read entry directly. The focused test
and the complete CLI dist suite passed after this correction.

# PR5 validation record

## Follow-up main refresh

Merged Apache main `e6db756890c36a8d4396241cc4f3a6f180529d20`. Main now uses
epoch 175 for executor-model protocol changes; Session MCP advances it to 176,
preserving the complete main protocol history and both lifecycle fixes below.
The protocol epoch guard passed against that main commit.

On this merge result, `build:test`, the production build, workspace typechecking,
lint, format and Desktop/UI knip passed. The full Runtime Host dist suite passed
2006 tests with 12 skipped; the full CLI dist suite passed 1155 tests with 3
skipped. Neither suite had failures or cancellations. Desktop E2E was not rerun.

## September 22 conflict resolution and review

Merged Apache main `8bde344b18d2c3b79f8f367d8b3645a4612606fc`, preserving its
usage timestamp protocol change and moving Session-scoped MCP compatibility
from epoch 172 to 173. The protocol epoch guard passed against that main commit.

After a clean dependency install and application of the repository patches,
`npm run build:test`, `npm run build`, workspace typechecking, lint, format,
Desktop/UI knip, ASF headers and CLI third-party notices passed. The affected
ACP, MCP publication, TUI MCP, Host capability/composition/retirement and Core
grant suites passed 453 tests, including the real Host ACP child-process tests.
Full workspace tests and Desktop E2E were not rerun.

Review still identified two reproducible P2 lifecycle gaps: a replacement queued
after Session retirement can recreate its registration without notifying the
Client of retirement; and an empty MCP snapshot after a connection loss does not
withdraw the Host's lost binding, blocking subsequent prompt admission. These
findings were fixed in `7a1874d5a`: publication consults durable Session lifecycle
state inside the mutation lane, and ACP publishes an explicit empty scoped
registration to reconcile lost contracts while retaining retirement notification.
Both focused regression tests failed before the behavior changes and pass after
them. Additional tests cover a real MCP process killed while disconnected,
durable archive/removal and unarchive behavior, pre-creation publication, and
the registration bound for both empty and populated scopes.

On the fix commit, the complete Runtime Host dist suite passed 2006 tests with
12 skipped, and the complete CLI dist suite passed 1154 tests with 3 skipped;
both had zero failures or cancellations. The Core capability-grant test passed.
`npm run build:test`, `npm run build`, workspace typechecking, lint, format,
Desktop/UI knip, ASF headers, CLI third-party notices and the protocol epoch
guard all passed again. Standards and Spec reviews found no further actionable
P-level issues in the fix. Desktop E2E and other complete workspace suites were
not rerun; independent human review remains required.

## September 20 review follow-up

The γ branch was rebased onto Apache main `879e0a4bc`; its Host compatibility
epoch advances from 171 to 172. Session capability registrations now have a
per-provider limit, Session retirement is serialized with registration changes,
and a crashed MCP server no longer blocks later prompt admission after its tool
withdrawal has been published. The ACP documentation now states the stdio
transport's direct-child cleanup guarantee without promising cleanup of every
process a launcher may spawn.

`node scripts/protocol-epoch-check.mjs --base upstream/main` and the full
`npm run build:test` passed. The affected Runtime Host tests passed 153/153,
the ACP Session MCP tests passed 14/14, and all five real Host/ACP child-process
tests passed. Lint and format checks passed. The isolated worktree needed the
repository's dependency patches after `npm ci --ignore-scripts`; without those
patches, UI typechecking failed on patched dependency APIs.

This file retains the September 15 validation history of the original combined
PR #5222. The implementation is now split into α (tool projection), β (ACP
interactions), and γ (Session-scoped MCP). The unrelated Side Chat E2E flake
change described below is **not** included in these three branches. The original
commit and branch references below describe that historical run, not the new
stacked PR heads.

On the rebuilt split γ head based on Apache main `852a9748d`, `npm run build:test`,
workspace `npm run typecheck`, `npm run lint`, `npm run format:check`, ASF headers,
CLI third-party notices, and the protocol epoch guard (166 → 167) pass. All five
official-SDK real Host/MCP child-process tests pass, as do 50 targeted Runtime Host
capability tests and the Core MCP grant test. The full CLI `test:dist` reached 1148
passed and 3 skipped; its two failures are the unrelated local managed-Host
cold-start cases, which fail with the same `connect_failed` result on a clean
`852a9748d` control worktree. α independently has an official-SDK real Host
builtin-tool test; β adds the Stop-failure cancellation regression and stdio
interaction failure coverage. Full Runtime Host, Core and Desktop E2E suites have
not been repeated on the rebuilt split stack.

Validated on macOS with Node 24.19.0 and ACP SDK 1.4.0.
Branch: `feat/acp-tools-interactions-mcp`.
After PR #4862 merged, the branch was rebuilt as one PR5 commit and was most recently
refreshed onto Apache main commit `5f4614bfdba710fad44699bbd879e78806ab54da`.
Scope follows the [PR5 checklist](https://github.com/apache/maka/issues/3132#issuecomment-5386735709)
and the approved implementation plan.

The September 15 refresh also closes the remaining review races around cancelled
Turn interaction fences, authoritative Session registration retirement and failed
Turn tool-terminal delivery. Main had advanced the compatibility epoch to 154, so
the combined Session-scoped capability contract advances it once more to 155.

## Automated results

| Validation | Result |
| --- | --- |
| `npm run build` | Passed, including Desktop renderer and its notice attestation. |
| `npm run typecheck` | Passed across all workspaces after rebuilding workspace declarations. |
| `npm run check:cli-third-party-notices` | Passed. |
| `node scripts/protocol-epoch-check.mjs --base review/latest-main-5222` | Passed: changed protocol, epoch 154 → 155. |
| `node --test scripts/protocol-epoch-check.test.mjs` | 17 passed. |
| `npm run lint` / `npm run format:check` | Passed (3605 linted files, 2135 formatted files). |
| `git diff --check review/latest-main-5222...HEAD` | Passed. |
| MCP workspace tests | 250 passed. |
| Runtime Host workspace tests | 1946 passed, 12 skipped, including UDS scope isolation and existing Desktop/default registrations. |
| Core grant decoder test | Passed, including `mcp` and retained `desktop_mcp`. |
| CLI workspace tests | 1118 passed, 3 skipped, including the real ACP process boundary and all PR5 unit/integration suites. |
| Desktop and UI `knip` checks | Passed. |
| Desktop E2E | Current budget check passed with 38 tests in 22 files. The original Side Chat follow-up acceptance passed 10/10 under an isolated stress loop and in its then-current full suite; the detailed historical evidence remains below. |

The first CLI run overlapped the full MCP E2E suite and one child-cleanup assertion
hit its five-second test deadline. The failed case passed alone in 91 ms; the full
CLI suite then passed without concurrent load, including the same case in 187 ms.

The first GitHub Desktop E2E run exposed a test-side interaction race: an
optimistic queue row could appear before the Composer released its single-flight
send slot, so the test's immediate next Enter was correctly ignored. The same
missing readiness boundary also reproduced locally after a queue edit and before
dragging (1 failure in 10 runs). The E2E now waits for the actual enabled Send or
draggable control before acting; the same isolated loop then passed 10/10. The
full local suite passed 33 tests including this case; two unrelated macOS-native
focus/screenshot cases timed out once and both passed immediately when rerun.

## Real ACP process boundary

`acp-tools-child-process.test.ts` uses the official SDK, a real ACP child process,
a real execution Runtime Host, local model HTTP fixtures and actual stdio MCP
processes. Its five passing cases establish:

1. `create → prompt → tool_search → MCP ask permission → Session grant → tool result → end_turn → close`.
2. Modern MCP `inputRequired → elicitation/form → typed answer → same-call continuation`,
   with private continuation state excluded from the ACP transcript.
3. Parallel Sessions with the same server/tool names return distinct public
   fingerprints of their isolated environments and retain separate grants;
   closing one Session leaves the other's tools callable.
4. A client permission handler that never responds does not prevent
   `session/cancel`, `session/close`, or stdin EOF cleanup.
5. Fifteen retained ordinary Session attachments plus a sixteenth MCP Session
   complete MCP authorization and authoritative result reconciliation. A
   seventeenth attachment is then rejected by Host `operation_conflict`, proving
   reconciliation did not require another subscription slot.

The existing `acp-child-process.test.ts` real-process suite also passed its Session,
configuration, capacity, recovery, streaming, cancellation and EOF checks.

## Zed status

Zed 1.19.2 opened a disposable project containing the custom `Maka PR5 Validation`
agent and forwarded the existing `fixture` stdio MCP server. Under Zed's `Ask`
permission mode, the prompt `Run the configured MCP echo tool and return its result.`
completed the standard UI flow:

1. Zed displayed the `tool_search` card and then the `echo` card.
2. Zed displayed `Authorize a Session capability` with `capability: "mcp"`,
   `scope.kind: "mcp_tool"`, `serverId: "fixture"` and `toolName: "echo"`.
3. Selecting `Allow this scope for this Session` resumed the same Turn.
4. The `echo` card completed and Zed displayed the final assistant text
   `Zed PR5 MCP tool and permission flow completed.`

The captured ACP stream independently records the permission request, the answered
`allow` decision, and the authoritative terminal tool update with
`resultPending: false`. Its content and `rawOutput` both contain
`Zed PR5 MCP result verified`, followed by the prompt response
`{"stopReason":"end_turn"}`. This completes the remaining standard Zed
tool/permission acceptance without a private ACP route.
