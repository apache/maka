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

# Goal event wait consumers

[中文版](./goal-event-wait-consumers.zh-CN.md)

Host observation separates source facts from their consumer. A durable wait is neither a new execution owner nor permission to replay a tool. The Runtime event log remains authoritative for model messages, tool results and termination.

## Consumer boundaries

| Consumer | Registration authority | Result consumption | Control and recovery |
| --- | --- | --- | --- |
| v2 `tool_invocation` | Existing admitted Run/invocation and committed T1 tool dispatch; Host binds operation and tool-call IDs | One T2 result in the original operation, followed by a reconstructible acknowledgement | No Turn yield, Goal gate or successor; existing Run cancellation and Runtime recovery apply |
| v2 `goal_waiting` | Naturally completed Turn, evaluation checkpoint, Goal identity and control generation | Existing pending Goal continuation, atomically acknowledged by Root admission | Existing Goal controls and supersession apply; observation replaces only the waiting timer |

A new explicit tool wait retains `sessionId`, `turnId`, `runId`, `invocationId`, `operationId` and `toolCallId`. It does not complete the Turn, release its Root execution position, inject a user message, run the Goal evaluator, reset maxSteps, refund an iteration or exclude real token usage. The original Turn settles once when it actually finishes. Multiple waits have independent identities and can coexist or follow one another.

The Host latches Goal-enabled wait capability to the exact admitted Run. A later Goal pause, clear or replacement does not stop that Run or revoke its ordinary tool capability. Another Run does not inherit that latch. Ordinary Sessions remain on their existing behavior until their capability is explicitly enabled in a future change.

Natural waiting settles the completed Turn and persists its waiting outbox before source preparation starts. Temporary source unavailability cannot retain that Turn's Root admission position. The outbox retains the exact structured condition before registration; recovery reuses that committed condition. A newer real Turn or Goal control change supersedes the pending preparation.

## Source observation and deadlines

The shared observer schedules all supported consumers through the same source concurrency, dispatch reservation, Retry-After and cooldown authority. Notifications trigger authoritative rereads and cannot themselves authorize or resolve a wait. Sources without notifications use bounded Host polling; unavailable subscription capacity falls back to reconciliation.

v2 deadlines are absolute and nullable. `null` introduces no wait-specific deadline; existing execution limits still apply. A timeout, when requested, retains its absolute expiry across registration, retries, steering re-entry and recovery. Resuming an interrupted wait uses its returned `waitId` as `resumeWaitId`; parallel waits with the same condition must name that identity to retain the correct individual deadline. Rolling observation checkpoints bound counters without turning an internal attempt count or a seven-day scheduler limit into a new business failure. The neutral v1 observation contract remains for existing non-Goal consumers, including Assistant Matter; it carries no Goal lease or Goal continuation delivery state.

This change uses the existing [managed ShellRun source](../packages/runtime/README.md#explicit-event-waits). Observation and delivery revalidation share Host resource bounds and trusted Run provenance. GitHub CI, GitHub PR/review and file readiness are separate source features and are excluded from this change.

Computer text observation and the ACP Host tool bridge are excluded. Computer tools retain their existing native waiting behavior; ACP executors retain their existing tool surface. Their removed prototypes and the conditions that would justify separate introductions are recorded in the [integration scope record](./archive/goal-wait-deferred-integrations-2026-10-24.en.md). Runtime child joins subscribe to the original Run's completion authority instead of repeatedly rereading it, without creating another task lifecycle.

## Messages and cancellation

`current_turn` input interrupts an active tool wait and reaches the existing durable steering boundary. The notifier does not dequeue or acknowledge input. `next_turn` stays queued. Code Mode stops dispatching new nested work after a trusted interruption while draining work already dispatched. Its outer `exec` result preserves each interrupted call's input and result in `toolCalls[].interruptedResult`, including the `waitId` and absolute `deadlineAt` needed to resume the exact wait. Explicit Host waits are available through the built-in AI SDK backend's direct tools and Code Mode; this change does not expose them to ACP executors.

Stop cancels the Run. Cancelling one tool wait returns an ordinary cancellation result to that operation; it neither pauses the Goal nor stops a background process. Natural Goal waiting cancellation uses the Goal control generation and revision, retaining existing Goal semantics. UI and CLI list Session waits independently of Goal visibility, so clearing a Goal does not hide admitted pending tools.

`session.event-waits.query` returns bounded pages. `session.event-wait.cancel` requires the exact consumer identity, including Run/invocation/operation for a tool wait or Goal/generation/revision for a natural wait. Stale controls cannot target a replacement consumer. The PR3 Goal-specific cancellation protocol and projection are removed.

`event_wait` Session domain invalidations announce changes anywhere in the paginated collection, including registration and durable consumption/retirement. Clients reread the bounded pages on invalidation and subscription recovery; equality of the first continuity page does not imply the collection is unchanged. These notifications are refresh hints, not consumption evidence. CLI status queries read all pages. The continuity wait preview is optional: it is omitted if the combined snapshot would exceed its byte budget. Admitted queue entries, interactions and Root/Goal facts keep their existing capacity checks. An absent preview does not mean there are no waits; full queries and invalidations remain available.

## Durable completion and recovery

Registration validates the original committed T1 and supported arguments. A source resolution is persisted before delivery. Delivery revalidates source access and the current record after asynchronous checks. The Runtime persists one normal T2 response; only that exact response may acknowledge consumption.

Consumption acknowledgement runs after T2 and does not block the model loop. If it fails or its notification is lost, a bounded Host scan finds the original durable response and completes the acknowledgement. An error T2 retires the consumer. If Runtime recovery terminates the original invocation without a result, its termination fact allows retirement; a wait record alone never replays the tool or creates a new Goal Turn. Cross-restart execution guarantees remain those of Runtime recovery.

Workflow schema 17 retires PR3/PR4 Goal-yield waits in one upgrade transaction, including roots already opened by schema 16. It removes the old wait records and pending continuations, pauses affected Goals with an upgrade diagnostic, and revokes their old control lease. If source-Turn accounting was not committed before the interruption, Host recovery completes it once from the original Runtime facts before clearing the association. No old wait creates a successor Turn. Previously admitted executions follow existing Runtime recovery; historical admission, invocation and message provenance remains readable without rewriting the event log. Resuming a paused Goal requires an explicit user action and a new wait registration. Neutral observation records and the two current consumer kinds remain strictly decoded. Memory and SQLite implement the same consumer contracts independently. Portable Session copies omit wait authority; same-root backups preserve durable facts but do not authorize duplicate observation or result delivery. Archive/delete cleanup covers retained observations and consumers.
