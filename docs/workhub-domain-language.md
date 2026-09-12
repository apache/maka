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

# WorkHub domain language

WorkHub is one persistent conversation per Runtime Host. Its coordination model
answers questions, clarifies requests, coordinates ordinary tasks, and operates
Maka through restricted Desktop capabilities. Docked and floating presentations
share one live renderer and the same Host-owned conversation.

## Ownership

**Coordination Session** owns WorkHub messages, model Turns, and durable delegation
links. It uses the existing Session transcript and recovery substrate. It is hidden
from the ordinary task list and cannot delegate to itself.

**Ordinary Session** owns delegated execution: workspace, model, permissions,
tools, artifacts, user interactions, Turn admission, and recovery. WorkHub reads
its state without copying its execution transcript or acquiring ownership of
unrelated user work.

**Coordination model** interprets the admitted user request. Local answers and
clarifications are normal model output. Its task actions produce advisory routing
or linked-operation proposals; there is no parallel renderer classifier,
exact-name resolver, or synthetic-summary writer.

**Routing intent** begins a new coordination decision, such as discussing,
executing, creating, or continuing work. _Avoid_: linked intent, disposition.

**Linked intent** refers to a delegation WorkHub already owns and asks to correct,
stop, or resume it. _Avoid_: routing intent, disposition.

**Routing disposition** is the closed outcome of a new routing decision:
`answer_here`, `delegate_existing`, `create_new`, or `clarify`. _Avoid_: stop,
resume, correction.

**Linked operation** changes an existing delegation relationship: `correct`,
`stop`, or `resume`. It is not a routing disposition.

**Session Resolver** recalls and ranks bounded existing ordinary Sessions for a
routing intent. It returns target evidence, never creation or execution authority.

**Linked-target resolution** starts from a bounded WorkHub-owned delegation and
follows its Session, Message, Turn, and continuation lineage. It does not infer an
operation target from a similar display name.

**Coordination policy** combines intent and resolved evidence into either a routing
disposition or a linked-operation proposal. Its output remains advisory.

**Bound routing decision** is the Policy result stored with one Coordination root
Turn. Recovery reuses it. The main coordination model may explain it or form a
matching proposal, but cannot replace its candidate or operation. The binding is
not Action Gate authorization.

**Active-Turn action** names the currently executing coordination Turn. The Host
checks its live execution, durable admission and coordination tool profile, then
reads the original request and attachments from that admission. A tool cannot
supply its own user-originated authority or attachment locators. Model-prepared
`delegationText` is task content, separate from the original user request.

**Action Gate** validates the resulting operation against durable ownership,
candidate freshness, Session identity, archive/waiting state and existing claims.
The policy proposes an action; the gate determines whether that exact action can
be admitted. Creation workspace context comes from Desktop main, outside the model
proposal. Each target still executes under its own permission boundary.

## Delegation and recovery

A delegation links the Coordination Session to an ordinary Session and its admitted
message. Its coordination status is distinct from the target's execution status.
Action identities and fingerprints bind retries to the same payload and target.

A replacement first durably claims its source delegation, retires only work owned
by that delegation, and records the replacement link and supersession. If the new
target becomes unavailable after retirement, a terminal replacement-aborted fact
preserves that outcome. A retry cannot redirect an already claimed replacement.

Stop resolves exactly one active delegation that still holds work on the named
Session. The Host rechecks ownership under the Coordination and target admission
lanes. A delegated message consumed as steering does not grant authority to stop
its surrounding user Turn; a recovery Turn shared by multiple messages is likewise
not owned by one delegation.

Stop records a durable request and one observed outcome: `cancelled_pending`,
`stop_delivered`, `already_terminal`, or `not_owned`. The cancellation tombstone or
exact root's abort source identifies the action that performed the stop. An
unrecovered or unreadable target stays unresolved; it cannot be called terminal.
A removed target's durable tombstone allows a committed stop to converge after
restart. Stop and replacement claims exclude each other until a non-owning outcome
releases that exclusion.

Resume is admitted by the target's existing Turn authority and reports
`resume_started` or `already_running`. It does not create another coordination
resume ledger.

New WorkHub conversations persist across application and Host restarts. Migration
of pre-cutover beta WorkHub history is not part of this cutover contract.

## Desktop presentation

The client-owned enable setting gates sidebar, dock, shortcut and tray entries.
Disabling hides the presentation and unregisters its shortcut while retaining the
shared renderer, drafts and Host-owned work, including during a pending window open.

The shortcut shows or hides the floating WorkHub window. Hiding does not open or
focus Maka Desktop. The return button above an expanded conversation explicitly
docks WorkHub into Desktop. Drafts, attachments, conversation and running state
survive visibility changes and reparenting because the renderer is not recreated.
A crashed renderer is disposed and recreated when WorkHub is reopened or docked.
An empty dock exposes Retry so recovery does not depend on a layout change.
The new view reconnects to the same Host-owned Session; unsent in-memory drafts
are not crash-persistent.

The composer retains a Stop requested before admission for that exact Session/Turn.
A lost dispatched response leaves admission unresolved; a later observation delivers
the intent through the existing Stop owner. Rejection or terminal evidence retires
it, so neither a retry nor a later Turn inherits the intent.

Both renderers use the shared document theme, palette and font application
functions. Native main-window chrome remains owned by the main renderer. Restricted
Desktop control observes current UI targets and revalidates them before acting;
its capability boundary is separate from task execution authority.
Password controls and explicitly excluded elements remain outside observation.
Other visible content, including arbitrary editor values, may reach the model;
WorkHub does not scan or rewrite that content for secrets.

## Implementation map

| Responsibility | Module |
| --- | --- |
| Task tool bridge | [workhub-runtime.ts](../apps/desktop/src/main/workhub-runtime.ts) |
| Active-Turn protocol | [workhub-coordination.ts](../packages/runtime-host/src/protocol/workhub-coordination.ts) |
| Coordination Session and active request | [workhub-coordination-coordinator.ts](../packages/runtime-host/src/server/workhub-coordination-coordinator.ts) |
| Shared Intent, Recall, and Policy contracts | [workhub-routing.ts](../packages/core/src/workhub-routing.ts) |
| Optional user-selected routing model adapter | [execution-model-authority.ts](../packages/runtime-host/src/server/execution-model-authority.ts) |
| Delegation admission and recovery | [workhub-coordination-action-gate.ts](../packages/runtime-host/src/server/workhub-coordination-action-gate.ts) |
| Transcript services | [create-workhub-services.ts](../apps/desktop/src/renderer/platform/desktop/create-workhub-services.ts) |
| Native window presentation | [workhub-presentation.ts](../apps/desktop/src/main/workhub-presentation.ts) |
| Shared document appearance | [document-appearance.ts](../apps/desktop/src/renderer/platform/desktop/document-appearance.ts) |
