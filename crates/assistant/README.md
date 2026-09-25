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

# Assistant plugins

[简体中文](README.zh-CN.md)

Native assistant, Todo, Recall and Plan plugins using public Host capabilities.

## Plan

`maka.plan` owns proposals, approvals, progress and recovery in namespaced plugin
storage. Host owns permissions, admission, canonical execution and settlement.
The backend operates without a frontend bundle; Plan UI is deferred.

A model Session with collaboration mode `plan` selects `default:plan`. Its tool
ceiling permits inspection, questions and proposal submission, excluding Shell,
workspace edits and autonomous workflows. Full bypass also permits explicit
user-requested file/Shell effects; it does not approve implementation by itself.

- `SubmitPlan` saves a versioned proposal and ends the planning Turn after durable
  tool settlement.
- Approving the exact proposal version saves a frozen submission and an explicit
  Session execution grant. It does not grant sandbox permissions. Execution uses
  the registered `maka.plan.execute` behavior without changing the Session default.
- `update_plan` reports all step IDs, with at most one in progress. The Plan is
  completed only when every step is completed/skipped and Host reports successful
  execution. Step completion remains a model report, not independent verification.
- `cancel_plan` records cancellation and ends the current Turn. Cancellation
  always targets the original operation, never the Session's latest unrelated Turn.

Tools are visible only in their corresponding frozen behavior and are direct-only
in Code Mode. Artifact/progress context is captured afresh per logical model step;
physical retries retain that captured context.

## Backend controls

Bind the standalone Remote with
`{ packageId: 'maka.plan', method: 'manage', sessionId }`.
The Session comes from the Host binding, not request data.

| Request | Behavior |
| --- | --- |
| `read` | Current revision, proposal metadata, execution progress and phase. |
| `artifact { source, revision? }` | Full proposal or execution artifact; source is `proposal` or `execution`. |
| `history { throughRevision?, after? }` | One summary per page under a fixed revision watermark. |
| `control { operationId, expectedRevision, action }` | An immutable, revision-checked decision; equal retries return the original receipt. |

Control actions are tagged by `kind`:

- `approve { proposalId, proposalRevision, grant }`.
- `revise { proposalId }` or `abandon { proposalId }`.
- `resume { executionId, grant }` after confirmed interruption.
- `cancel { executionId, reason, grant? }`.
- `reconcile { executionId, grant }` to renew observation/admission authority for
  unsettled original work, including after revocation.

Obtain grants through the existing application `plugin.authorization` operation
for this Remote binding, with the exact Session target and `executions` capability.
Reads and old receipts still require current Session access. A new approval or
renewal validates current consent; an old accepted decision does not require its
former background grant to remain live.

## Terminal views

Plan contributes a session page, inspector panel and a status line through the
public Terminal View contract. Proposal and execution tabs show the reviewed
artifact and recorded progress; history, full overview/risks and step details
read immutable revisions. Large artifacts stay available through bounded detail
views, and settled work leaves the composer status line empty.

Approve, request changes, abandon, resume, renew permission and stop use the same
Host control path as other clients. Execution authority requires explicit consent.
Confirmation keeps the reviewed version fixed while live updates wait. Each
submitted decision has a stable operation identity; recovery observes its durable
receipt even after later decisions, without renewing the old grant or replaying
work. A missing receipt remains unrecorded, not a declaration of failure.

## Recovery and bounds

Dispatch intent precedes Host submission. Restart queries the original operation;
any retry preserves its identity and frozen content. Pending cancellation never
resubmits uncertain work. If its receipt is still unknown, the Plan remains
unsettled, cannot be replaced, and does not keep an idle Host awake.

Failed/cancelled Host execution or successful execution with unfinished steps
interrupts the Plan. Explicit resume freezes the recorded progress into a new
submission. It never automatically replays unknown effects. A sealed Host handoff
remains owned by the same operation; resume that Run through public Session
controls. Plugin retirement stops new plugin work while Host settles accepted work.
Reactivation reconciles receipts under current consent.

Artifacts allow 1–50 steps and at most 40 KiB of encoded JSON; progress is limited
to 12 KiB. Remote summaries omit grants and duplicated frozen submission text;
artifacts are fetched separately within the 64 KiB Remote limit.

Domain tests cover actual SQLite persistence, exact retries and stale identities.
Host integration covers planning restrictions, approval, settlement, retirement,
restart, revocation/renewal, explicit resume and cancellation without replay.
