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

# Read image context writer review fixes

## 1. Current state and problem

PR #4184 moves Read image snapshots from Session artifacts to the durable Session context Store.
Review found four reachable ownership and lifecycle defects in the initial cut:

- B1: snapshot identity used the provider-scoped tool call id rather than Runtime's durable tool
  operation id.
- B2: conversation copy collected context refs from the complete source event set and opaque JSON,
  not only the selected typed projection it rewrites.
- F1: a known T2 result-commit failure left the already-created snapshot reference live.
- F2: recovery could discard the durable preparing-copy metadata while context retirement was
  unavailable.

## 2. Required behavior

- B3: Read image snapshots are owned by the Runtime-issued durable operation id and fail closed
  when that identity is absent.
- B4: branch, revision, and Side Conversation copies collect only typed attachment/image refs in
  copied Messages, selected AgentRun RuntimeEvents, and inspected archived results.
- B5: a known T2 failure attempts to release the Read snapshot without replacing the authoritative
  persistence error if compensation also fails.
- B6: an unavailable context Store keeps preparing-copy cleanup retryable by failing retirement
  before stable Session metadata deletion.

## 3. Architecture and alternatives

- D1: use `MakaToolContext.operationId`, already derived from invocation id plus provider tool-call
  id, as the context Store owner id. Re-deriving or accepting the provider id would duplicate or
  weaken Runtime authority.
- D2: mirror the existing typed Session-file collector instead of structurally walking arbitrary
  payloads. This keeps collection and rewrite sites identical.
- D3: add one optional ToolRuntime T2 compensation hook and bind it only for Read image snapshots.
  Compensation receives the normalized durable result so it releases exactly the ref T2 attempted
  to publish.
- D4: inject a failing context copy/retirement authority when the optional Store cannot open. The
  preparing Session header remains the durable retry anchor.
- R1: hard-crash or outcome-unknown windows cannot be perfectly compensated; whole-Session
  retirement remains the durable backstop.
- R2: ordinary branch/revision copies continue rejecting archived source-owned image refs; exact
  archived-result migration remains outside this PR.

## 4. Implementation design

- Runtime `Read` refuses image snapshotting without `operationId` and passes it to the snapshot
  Store as `ownerId`.
- `MakaTool.compensateDurableOutcomeCommitFailure` runs only after `commitToolOutcome` rejects.
  The Read binding recognizes only a same-Session `session_context` image result and calls
  `releaseReference`.
- `collectConversationCopySessionContextRefIds` accepts copied Messages, selected RuntimeEvents,
  and archived serialized results. It decodes only canonical `ToolResultContent` image sites.
- Runtime Host passes the same available-or-failing context authority to copy recovery and Session
  retirement, so sidecar purge must succeed before metadata discard.
- Compatibility epoch 88 marks the newly emitted `session_context` tool result shape after rebasing
  onto epoch 87.

## 5. Verification plan

- E2E Required: no. The stable cross-package boundary is the repository's two-client UDS Session
  revision integration test; no external service stack is involved.
- Build `@maka/core`, `@maka/storage`, `@maka/runtime`, and `@maka/runtime-host` in dependency order.
- Run focused Runtime tests for Read wiring, filesystem authority, conversation copy, and the
  durable T1/T2 boundary.
- Run focused Runtime Host tests for production composition recovery, protocol epoch, and Session
  retirement.
- Run the Session revision two-client UDS integration test because copy projection and restart
  recovery cross package boundaries.
- Run `git diff --check`; the repository has no `make lint-fix` target.

## 6. Serial checklist

- [x] Rebase the PR branch onto current `origin/main` and reconcile SessionTodo/protocol changes.
- [x] Replace provider snapshot identity with Runtime durable operation identity.
- [x] Restrict context-ref collection to selected typed rewrite sites.
- [x] Add best-effort T2 snapshot compensation.
- [x] Retain preparing-copy cleanup metadata while context retirement is unavailable.
- [x] Complete final focused and integration verification.
- [x] Complete the final six-pass diff review with no remaining actionable finding.
- [ ] Scan secrets, publish, and monitor the updated PR.

## 7. Outcome and evidence

| ID | Implementation | Evidence | Status |
| --- | --- | --- | --- |
| B3 / D1 | Read snapshot owner is `MakaToolContext.operationId`; missing identity fails closed. | Builtin Read tests cover the exact owner and missing-identity refusal. | DONE |
| B4 / D2 | Context refs are collected only from typed copied Messages, selected run events, and inspected archives. | Conversation-copy tests prove typed images are selected while opaque lookalikes are ignored. | DONE |
| B5 / D3 / F1 | T2 rejection invokes Read snapshot release best-effort without masking T2. | Durable-boundary and Read compensation tests cover success and compensation failure. | DONE |
| B6 / D4 / F2 | Unavailable context authority refuses preparing-copy retirement before metadata discard. | Production composition recovery test reopens storage and observes the preparing header intact. | DONE |
| R1 | Hard-crash compensation remains outside the known-failure hook. | Session retirement continues to retire all context refs durably. | DONE |
| R2 | Ordinary archived owned refs remain rejected rather than copied unsafely. | Archive preflight recognizes source-owned `session_context` images. | DONE |

Final commands, all run from the repository root:

- `npm --workspace @maka/core run build && npm --workspace @maka/storage run build && npm --workspace @maka/runtime run build && npm --workspace @maka/runtime-host run build` — pass.
- `node --test packages/runtime/dist/__tests__/builtin-tools-file-worker.test.js packages/runtime/dist/__tests__/filesystem-authority.test.js packages/runtime/dist/__tests__/conversation-copy.test.js packages/runtime/dist/__tests__/tool-runtime-durable-boundary.test.js` — 99 tests pass.
- `node --test packages/runtime-host/dist/__tests__/execution-composition.test.js packages/runtime-host/dist/__tests__/protocol.test.js packages/runtime-host/dist/__tests__/session-retirement-coordinator.test.js` — 105 tests pass.
- `node --test packages/runtime-host/dist/__tests__/session-revision-two-client-uds.test.js` — 1 integration test passes.
- `git diff --check origin/main` — pass.
- Lint fix was not run because the repository has no `Makefile` or `make lint-fix` target.

The net diff was reviewed in behavior/scope, architecture, tests, security/compatibility,
operations, and documentation passes. No migration, deployment-order change, credential, or
external-service dependency is introduced.

## 8. Remaining work

- Scan secrets, push the rebased branch, resolve the six addressed GitHub threads, and monitor the
  current head until CI and review state are clean.
