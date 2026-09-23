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
