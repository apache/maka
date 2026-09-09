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

# Local Runtime execution persistence boundary

## Purpose

This is the first local-runtime integration slice of [#2370](https://github.com/apache/maka/issues/2370), following [discussion #4666](https://github.com/apache/maka/discussions/4666). It proves that Host orchestration can consume an execution persistence contract without constructing its SQLite implementation.

This is not the checkpoint integration, a remote backend, or a migration of all Maka storage.

## Composition and authority

The trusted process composition selects one `ExecutionPersistenceProvider` through `ExecutionRuntimeHostCompositionDependencies.executionPersistenceProvider`. With no override, it selects `localExecutionPersistenceProvider`; existing files, schema migrations and SQLite transactions remain in use. No protocol field, client operation, model output, or per-Session option selects a backend.

A provider opens an entire consistency domain:

| Port | State and transaction dependencies |
| --- | --- |
| Session | Headers, legacy transcript, catalog, message admission, sandbox boundaries and WorkHub facts |
| AgentRun / RuntimeEvent | Root admission, execution evidence, immutable event order, continuation claims and Tool T1/T2 |
| Interaction | Requests, canonical outcomes and atomic capability grants |
| Graph control | Schedule, activation claims, epochs, wakes and client projections |
| Goal authority | Revisioned Goal state deleted by Session retirement |

Graph and Goal are included because existing Session operations already cross those boundaries. Graph operator provisioning must commit the child Session, spawn claim and topology against the same schedule fence. Retirement must not delete a Session but retain its Goal. This does not introduce a new Graph or Goal product model.

The provider returns raw ports; storage composition authenticates and lease-scopes the exposed capabilities. The existing interactive filesystem root lease remains the ownership mechanism. This PR makes no distributed lease or remote ownership guarantee.

WorkHub assignment remains a single backend transaction: optional target creation and its stable-create identity, target pending-message admission, and the Coordination Session assignment record either all commit or none do. It is not implemented as two independent Session-head updates.

## Lifecycle

One provider owns a write lease at a time. Reopening with that same provider reuses the authenticated group; choosing another provider on the same active lease fails. Calls retained after group close or root-owner close cannot access the backend. Transcript subscriptions are detached during group shutdown.

Closing drains tracked operations and closes the owned handles. An uncertain factory open or failed group close cannot silently reopen a different backend on that lease. A caller must obtain a fresh owner after resolving the failed lifecycle.

Transcript subscriptions are instance-local invalidations after successful appends, not a durable changefeed or an observation guarantee for remote writers. The existing bounded transcript-index operations remain in the compatibility contract; this slice does not claim a representation-independent remote transcript API.

Standalone Goal and Interaction accessors resolve the authority already registered for their lease. A custom provider cannot silently reuse an independently opened Local authority. The default Local composition preserves compatibility with the existing same-lease accessors.

Closing a grouped Goal or Interaction facade revokes that child but does not release its backend binding. Standalone accessors reject reopening the revoked child until the group closes successfully; pending or failed group shutdown cannot fall back to Local. Standalone Local children not owned by a group retain their close/reopen behavior.

Host reads use the read methods on the selected, authenticated group. The pre-existing standalone Local read-only utilities are not a generic remote-reader composition API.

## Independent reference implementation

`@maka/storage/test-only/memory-execution-persistence` exports a process-lifetime reference provider. It holds its own maps, clones a complete transaction draft, and publishes it with one synchronous state replacement. It neither opens SQLite nor wraps or falls back to Local.

Pure canonical validators and event projection rules are shared; storage algorithms and state are independent. Reads return detached snapshots. Reopening the same provider retains its in-process authority; restarting the process loses it. Whole-state copying is intentionally a reference-model technique, not a performance design for production.

Test hooks distinguish failure before publication from a lost acknowledgement after publication. They are not production configuration.

Conversation-copy import validates complete canonical run ledgers and atomically rebuilds Tool projections; an exact retry must neither duplicate events nor lose T1/T2 identity. Session configuration changes preserve accumulated sandbox authority, restore it after temporary Explore/Bypass modes, and only advance the boundary revision when its authority changes.

The reference implements the declared execution ports. It does not claim optional authorities absent from that contract: for example, a managed-workspace mutation without its workspace authority binding is rejected, not sent to a Local T1 implementation. Artifact payloads, runtime policy, long-term memory and other independently composed domains remain outside this provider.

## Evidence

- `packages/storage/src/__tests__/execution-provider-conformance.test.ts` runs the same assertions against Local and Memory: stable identities, detached reads, CAS, message handoff, WorkHub atomicity, Tool T1/T2, conversation-copy validation and projection rebuilds, lost acknowledgements, sandbox authority preservation, Graph provisioning, Goal retirement, authenticated access and child/group lifecycle.
- Backend-specific fault setup is confined to the test harness. Local uses transaction-aborting triggers; Memory aborts its unpublished draft. The assertions and production-facing operations are shared.
- `packages/runtime-host/src/__tests__/workhub-assignment-crash-recovery.test.ts` starts a real Host process with the Memory provider selected through the supported composition entry. A fake model backend drives normal message submission, durable history, existing-target delegation and new-target delegation. Exact retries do not dispatch twice. Inspecting Local afterward confirms those execution records were never written there.
- The existing Local process-loss cases still terminate the Host after WorkHub assignment commits but before target dispatch. A fresh process recovers the assignment and pending message. These are the durability tests; a Memory close/reopen is not evidence of process-loss durability.

Checkpoint publication/loading, storage-plane payload backends, migration of other authorities, distributed control-plane ownership and WorkHub product evolution remain separate follow-ups.
