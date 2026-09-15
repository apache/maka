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
