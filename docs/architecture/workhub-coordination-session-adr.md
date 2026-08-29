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

# ADR: One WorkHub Coordination Session per Runtime Host

- Status: Accepted
- Date: 2026-08-25
- Scope: WorkHub architecture
- Decision source: [Discussion #3286](https://github.com/apache/maka/discussions/3286#discussioncomment-18135855)
- Delivery tracker: [Issue #3492](https://github.com/apache/maka/issues/3492)

## Context

WorkHub is intended to be one persistent conversational place where a user can ask
an ordinary question, clarify intent, continue existing work, or create new work.
R2.4 is a deterministic routing and context-continuity baseline that may also serve
as a future target resolver. It does not provide a persistent WorkHub conversation
and is not the final definition or authority boundary of WorkHub.

A persistent coordinator needs durable conversational continuity without creating
a second WorkHub database, event store, transcript substrate, or lifecycle
authority alongside Session.

## Decision

Each Runtime Host independently owns one stable WorkHub **Coordination Session**.
The Coordination Session is a special role of the existing Session, not a new
durable entity type or storage system. It reuses the existing Session, Turn,
transcript, model, recovery, and event infrastructure. Session remains the only
durable conversation and execution substrate.

The role is provisioned lazily when WorkHub first needs it and resolves to the same
Session after Runtime Host or application restarts. The Session role representation,
lookup, recovery, and per-Host UI resolution enforce this lifecycle contract. The
coordination transcript and disposition semantics remain separate later work.

The per-Host boundary is intentional. A Coordination Session coordinates only the
ordinary Sessions belonging to the same Runtime Host. Switching Runtime Hosts
selects the other Host's Coordination Session; the first milestone does not support
cross-Host coordination or a global Coordination Session.

The Coordination Session is hidden from the ordinary Session list and excluded
from every routing-candidate set. The Action Gate's self-route rejection remains a
defense in depth; it is not a substitute for keeping the Coordination Session out of
ordinary navigation and target discovery.

## Durable authority boundaries

| Concern | Durable authority |
| --- | --- |
| User messages sent in WorkHub, ordinary Q&A, clarification, coordination decisions, bounded delegation references, and coordination summaries | The active Runtime Host's Coordination Session |
| Concrete execution, project and filesystem scope, model and permission mode, root-Turn admission, tools, artifacts, recovery, archive/delete, and the authoritative execution transcript | The target ordinary Session |
| Aggregated WorkHub cards, filters, status summaries, and navigation aids | No durable authority; these are rebuildable projections of Session facts |

The Coordination Session is authoritative only for the coordination conversation.
It never acquires authority over an ordinary Session's execution or lifecycle.

## Dispositions and action admission

Every WorkHub input resolves to exactly one proposed **disposition**:

- `answer_here`: answer in the Coordination Session.
- `delegate_existing`: delegate concrete work to one bounded, valid ordinary
  Session.
- `create_new`: create an ordinary Session, then delegate concrete work to it.
- `clarify`: continue clarification in the Coordination Session without guessing a
  target or creating a Session.

All model and routing output is advisory. Before any write, a deterministic
**Action Gate** admits or rejects the proposed disposition and operation. The gate
enforces Runtime Host and target validity, archive and waiting state, self-route
exclusion, explicit `create_new`, and existing tool and permission ceilings.
Replacement, supersession, and Stop ownership remain deferred. Neither a model
nor a routing policy can directly authorize a write or expand execution authority.

## Delegation links rather than copies transcripts

A delegation persists only a bounded link between the coordination and execution
transcripts, such as:

```text
delegationId
coordinationTurnId
targetSessionId
targetTurnId
disposition
```

The initial assignment link does not mirror the target Turn's execution lifecycle.
Target acceptance, running, waiting, completion, failure, abort, and recovery state
remain ordinary Session facts. WorkHub derives those states as read-only
projections and does not persist them as independent Coordination Session truth.
Future replacement support may add coordination-owned `active` / `superseded`
linkage without turning target execution status into WorkHub-owned state.

The ordinary Session records the delegated request, tools, side effects, and
authoritative result. WorkHub may display a bounded projection or record a
coordination summary, but it does not copy the ordinary Session's complete
transcript into the Coordination Session.

Delegation linkage uses one closed, typed `delegation_assigned` record in the
existing Coordination Session transcript. Under the Coordination and target
Session admission authorities, one `runtime.sqlite` transaction commits that
record together with the target pending-message admission. For `create_new`, the
target Session metadata is created in the same transaction. The record carries the
exact user text, resolved target and target Message/Turn identities, creation
context, and stable display name. Its action fingerprint rejects conflicting reuse
of an action identity.

The transaction is the user-visible assignment boundary. Before commit neither
Session observes the work; after commit both the WorkHub linkage and target input
exist. Waking or continuing the in-memory executor happens only after commit. A
Host crash between commit and wake is handled by ordinary pending-message recovery,
so WorkHub does not own a second recovery state machine or compensation chain.
The `delegation_assigned` record itself projects the visible WorkHub turn; the
renderer does not append a second summary.

The renderer persists only a Host-scoped action id until acknowledgement. Composer
draft text uses a separate storage key and lifecycle. A reload therefore preserves
idempotency without freezing old text or coupling draft edits to Host authority.
`waiting_for_user` remains a local, retryable result because no assignment has yet
been committed.

## Consequences, costs, and reevaluation

- WorkHub gains persistent conversational continuity without adding another
  durable authority, database, event store, lifecycle, or transcript copy.
- Coordination and execution remain separately authoritative within the shared
  Session substrate.
- The per-Host boundary fragments WorkHub continuity when a user switches Runtime
  Hosts: each Host has a separate coordination transcript and cannot coordinate the
  other Host's Sessions.
- The special Session role adds provisioning, lookup, recovery, retention, and UI
  obligations even though it deliberately reuses the existing Session substrate.
- Every delegated Coordination turn adds one typed assignment record, which is
  also its visible timeline source.
- Whether Work is 1:1 with Session, 1:N over Sessions, or an independent durable
  entity remains unresolved.
- Cross-Runtime-Host coordination remains deferred.
- Coordination Session role representation, lazy creation, durable lookup,
  recovery, per-Host UI resolution, persistent transcript, closed dispositions,
  and the Action Gate are implemented. Durable delegation linkage is encoded in
  that transcript; target lifecycle projection, linked correction, and destructive
  replacement/Stop recovery remain later work.

Reevaluate the per-Host decision if supported workflows require one WorkHub
conversation to coordinate ordinary Sessions on multiple Runtime Hosts, or if Host
switching creates user-visible continuity loss that rebuildable projections cannot
resolve. Reevaluate the special Session role if implementing its lifecycle requires
a second durable authority or exceptions that the ordinary Session substrate cannot
enforce safely.

## Rejected alternatives

- A second WorkHub database, event store, transcript substrate, or lifecycle
  authority.
- One global Coordination Session spanning Runtime Hosts.
- Copying an ordinary Session's complete transcript into WorkHub.
- Allowing model or routing output to authorize writes without the deterministic
  Action Gate.
