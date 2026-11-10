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

# Agent Execution and Recovery

[简体中文](durable-agent-execution.zh-CN.md)

Maka assigns a stable `runId` to each execution. A process restart, disconnected observation stream, or plugin reload does not mean a task has failed. When reopening the same local state directory (State Root), the system automatically reconciles and advances any non-terminal original Run based on persisted records, original call receipts, and current permissions.

## Execution Semantics and Recovery Boundaries

- **Verify original receipts without re-sending under new IDs**: An interrupted model stream is not guaranteed to resume in place. For admitted tool calls or external side effects whose outcomes are unknown, the system checks the original call receipt first and does not automatically re-send them under a new ID. If the original execution outcome cannot be confirmed, the Run enters `blocked` with the specific blocker attached.
- **Separation of business outcomes and resource cleanup**: A known execution response may be either a business success or a business error (which may still have produced external side effects). Once known, the outcome is not overwritten by subsequent resource cleanup status. Receiving a business outcome does not mean the underlying process or tool has physically exited, and unconfirmed cleanup does not prove that the business operation did not execute.
- **Stop is not rollback**: Issuing Stop cancels subsequent steps and requests termination of in-flight work, but does not roll back external effects that have already occurred. A Run entering `cancelled` indicates logical cancellation, not that all external processes or resources have exited; cleanup of residual resources continues to be tracked independently.

## Permission, Budget, and Execution Environment Constraints

- **Recovery does not expand permissions or budgets**: Recovery is constrained by both the permission ceiling at the start of the original task and the live permissions in effect at recovery time. Persisted approval records or configuration are not live permissions that take effect automatically across restarts; when permissions are insufficient, the Run enters `waiting` or `blocked`, and the system does not automatically expand permissions. Budget and retry constraints from the original task remain in effect after recovery. Standard parent-child sessions, Goal, and Scheduler all follow the same execution recovery rules and do not automatically gain extra budget or authorization from a restart.
- **Code Mode**: The system persists Cell records, published `SessionData`, and discovered tools, and reconciles nested side effects against the original records; however, it does not persist VM heap memory or variable execution stacks, and does not simulate recovery by replaying arbitrary JS/Python scripts from scratch. If a script depends on in-memory state that cannot be reconstructed, the Run may enter `blocked` after an interruption.
- **External executors**: The system queries or recovers by original task identity only when the external executor provides a verifiable protocol for the original job/turn. It does not treat a newly created external task as a recovery of the original task, nor does it conclude that an external task has completed solely from a vanished local PID, EOF, or timeout. Without a reliable recovery protocol, the Run retains its `blocked` state along with diagnostic details.

## State Interpretation and Risk Adjudication

Use `execution` to read the execution receipt of the original Run, where `state` is one of:

- `admitted` / `running`: Admitted or currently executing.
- `waiting`: Waiting normally on an external condition, such as pending approval, input, or timer expiration.
- `blocked`: The outcome is unknown, or permission or state constraints are insufficient to advance safely and automatically. **Do not treat `blocked` as a normal retryable error by re-sending the request.**
- `completed` / `failed` / `cancelled`: The Run has reached a terminal state.

The `offeredActions` listed in a blocker represent the manual resolution options currently supported, which may include recording an external observation, authorizing replanning, or cancelling the Run; not every blocker supports all options. When submitting a `decision` via `adjudicateRisk`, pass the original `sessionId`, `runId`, and `blockerId`, and use `highWater` from the latest receipt as `expectedHighWater`. Manual adjudication only determines follow-up handling; it does not alter the original tool receipt or prove that resources have exited.

## API Usage and Continuation Rules

- **Keep original identifiers and check the original task first on disconnect**: After calling `send` once, save the `runId` from the execution receipt, or save the original `messageId` if the request was queued. If the observation stream disconnects or the outcome is unclear, query the original task status first; calling `send` again starts a brand-new task rather than recovering the original one.
- **Status queries and paginated observation**:
  - Pass `sessionId` and `runId` to `execution` to read the latest receipt of the original Run.
  - Pass `sessionId`, `target`, and an optional `cursor` to `work` to observe execution progress and paginated answers. `target` is `{kind: 'run', runId}` or `{kind: 'message', messageId}`.
  - The answer pagination cursor for `work` comes from `answer.next` in the response. It serves a different purpose from the state progression high-water mark `execution.highWater`; do not use them interchangeably.
- **Distinguishing automatic recovery from `continueRun`**:
  - Non-terminal original Runs are reconciled automatically by the system and handled according to their waiting or blocking conditions; you **cannot** call `continueRun` to recover them.
  - `continueRun` applies only to **terminal** Runs. Once validated, it creates a **new Run** and does not reopen the old Run. Before calling it, you can check whether continuation conditions are met via `continuationAvailability`; when calling `continueRun`, pass `sessionId`, `sourceRunId`, `sourceHighWater`, `model`, and an optional `thinkingLevel`, where `sourceHighWater` must be the exact value returned by the latest `execution` call.

For exact fields and response structures, see the [Execution API Contract](../../plugins/agent/api/src/contract/execution.rs).
