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
The branch retains PR #4862 commit
`0ba09673387cbde651b9474fdd5a313cc6b5f6a0` as an ancestor and merges the fetched
Apache main commit `05164f5359467a9d00ea144395ab0b9f1f74750c` at `6e80bd002`.
Before publication, the branch also merged main commit
`69a3c060907b6549b3d72643d0cd774422b2b4f1` (#5197). That change independently
used epoch 143, so PR5 advances the combined protocol to epoch 144.
Scope follows the [PR5 checklist](https://github.com/apache/maka/issues/3132#issuecomment-5386735709)
and the approved implementation plan.

## Automated results

| Validation | Result |
| --- | --- |
| `npm run build` | Passed, including Desktop renderer and its notice attestation. |
| `npm run typecheck` | Passed across all workspaces; CLI incrementally checked after final changes. |
| `npm run check:cli-third-party-notices` | Passed. |
| `node scripts/protocol-epoch-check.mjs --staged` | Passed: the publication resolution advances 143 → 144. |
| Desktop and UI `knip` checks | Passed after the publication-time main merge. |
| Lint and format for all tracked files, including PR5 additions | Passed (3523 linted files, 2097 formatted files at the check). |
| `git diff --check` and staged whitespace check | Passed. |
| MCP workspace tests | 250 passed. |
| Runtime Host client-capability tests | 64 passed, including UDS scope isolation and existing Desktop/default registrations. |
| Core grant decoder tests | Passed, including `mcp` and retained `desktop_mcp`. |
| Tool mapper, bounded buffer, prompt transcript channel | 19 + 4 + 5 passed. |
| ACP registry | 53 passed, including final-result delivery failures and cancellation/Host terminal states during blocked reads. |
| ACP interaction bridge | 18 passed, including standard SDK request/response routing, all form field types, canonical external answers and non-cooperative cancellation. |
| MCP publication and Session lifecycle | 17 passed, including real child cleanup, discovery failure, reconnect, unknown creation outcome and EOF during preparation. |
| ACP stdio and shared TUI publication | 43 passed. |
| Existing Session driver / lag / TUI Turn regressions | 76 passed. |
| TUI remote publication and form integration | 22 passed. |
| Desktop MCP form and capability publisher regressions | 10 passed. |

`npm run lint` and `npm run format:check` also inspect the pre-existing untracked
`output/` directory. Their whole-directory runs report unrelated draft artifacts,
including an empty `output/pr-4862-review/pr-comments.json` and unformatted probes.
Those files were preserved. The equivalent checks over `git ls-files` passed;
the PR's staged checks do not include those unrelated drafts.

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

After merging #5197 and advancing to epoch 144, the full workspace build and
typecheck passed again. The five real ACP flow tests were rerun together with
Host Session-scope, UDS and Session-bundle coordinator tests: 18 passed, 0 failed.

## Zed status

Zed 1.19.2 opened a disposable project containing a custom Maka agent and the
existing stdio fixture. Zed started that MCP fixture. The UI automation could not
reliably operate the Agent panel: canvas clicks returned `noWindowsAvailable` and
Agent-panel actions did not expose a usable prompt. The project was closed and
its MCP process exited. The full Zed tool/permission flow therefore remains an
explicit manual acceptance item; it is not counted as a passing test.

To complete it, configure Maka as a custom external agent, forward a stdio MCP
server, request a tool under `ask`, select the Session-labelled permission option,
and verify one tool card receives its final result before prompt completion.
See the [capability matrix and lifecycle documentation](README.md).
