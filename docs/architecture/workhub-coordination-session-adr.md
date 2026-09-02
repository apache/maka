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

Linked correction is a user-confirmed coordination operation over a prior durable
delegation, not a model disposition. Its replacement target is still restricted to
`delegate_existing` or explicit `create_new` admission.

All model and routing output is advisory. Before any write, a deterministic
**Action Gate** admits or rejects the proposed disposition and operation. The gate
enforces Runtime Host and target validity, archive and waiting state, self-route
exclusion, explicit `create_new`, and existing tool and permission ceilings. For a
replacement, the gate additionally requires explicit correction evidence in the
trusted user text, claims the source delegation in Coordination transcript order,
and rejects any later competing replacement intent. Neither a model nor a routing
policy can directly authorize a write, Stop, or expansion of execution authority.

## Delegation links rather than copies transcripts

A delegation persists only a bounded link between the coordination and execution
transcripts, such as:

```text
delegationId
coordinationTurnId
targetSessionId
targetMessageId
targetTurnId
disposition
```

The initial assignment link does not mirror the target Turn's execution lifecycle.
Target acceptance, running, waiting, completion, failure, abort, and recovery state
remain ordinary Session facts. WorkHub derives those states as read-only
projections and does not persist them as independent Coordination Session truth.
Linked correction records coordination-owned `active` / `superseded` / `aborted`
linkage without turning target execution status into WorkHub-owned state. Here,
`aborted` means the source link was retired but replacement admission could not
complete because the selected target became archived, disappeared, or began
waiting for user input. The renderer rebuilds active linkage from the complete
Coordination transcript separately from its bounded visible timeline, preserving
durable transcript sequence rather than wall-clock order.

The ordinary Session records the delegated request, tools, side effects, and
authoritative result. WorkHub may display a bounded projection or record a
coordination summary, but it does not copy the ordinary Session's complete
transcript into the Coordination Session. The assignment projection preserves
`create_new` so the visible card explicitly tells the user that WorkHub created a
new work item rather than merely saying that an existing item accepted the request.

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

The first-response contract is hybrid. The atomic `delegation_assigned` record is
an immediate durable acknowledgement, so WorkHub confirms acceptance without
waiting for target execution. The target Message is the stable delegation
identity; `targetTurnId` records only its admission location. WorkHub asks the
target Message authority which Turn durably consumed or admitted that Message,
then joins the resolved Turn's recorded lifecycle and the target Session's exact
live-Turn membership to project `running`, `waiting_for_user`, `completed`,
`failed`, and `aborted`. This remains correct when an unconsumed steering Message
is folded into a successor Turn or recovery aggregates several pending Messages
under one new Turn. A durable cancellation tombstone for a retracted queued
Message resolves the delegation to `aborted`. If the target authority is
temporarily unreadable, WorkHub projects `recovering` rather than inventing a
terminal result. These execution states are never appended as mutable Coordination
records; Session change notifications invalidate the projection and opening
WorkHub after restart rebuilds it from the same link and target facts.

The renderer persists only a Host-scoped action id until acknowledgement. Composer
draft text uses a separate storage key and lifecycle. A reload therefore preserves
idempotency without freezing old text or coupling draft edits to Host authority.
`waiting_for_user` remains a local, retryable result because no assignment has yet
been committed.

Before any destructive retirement, replacement persists a
`delegation_replacement_requested` record whose identity is unique to the source
delegation. The target Session's ordinary Message authority then either cancels
the exact still-pending delegated Message or resolves how the Message entered an
execution Turn. A root Turn created by that Message may be stopped; a pre-existing
user Turn that merely consumed it as steering is shared authority and must remain
running. Replacement assignment and the old link's `delegation_superseded` proof
commit atomically. Retrying the same action recovers the crash seam after
retirement/Stop and before replacement assignment. The replacement fingerprint
binds the resolved stable target Session id rather than its transient candidate
reference, so metadata refreshes do not change action identity and a retry cannot
select a different Session. If the target becomes archived, unavailable, or
waiting after the destructive retirement boundary, Coordination appends a
`delegation_replacement_aborted` terminal fact. That auditable fact removes the
retired source from active linkage and makes later retries return the same terminal
outcome instead of displaying a stopped, unsuperseded link.

Direct stop resolves its target through the shared Session Resolver, then asks the
Host which of that Session's delegations still hold stoppable work before it
answers the user or proposes anything. WorkHub projections are rebuildable and may
be empty when a window opens, so a destructive answer is never given from one. The
proposal then carries only what resolution produced: the opaque delegation identity
and the Session it belongs to. Display names are retrieval evidence on the proposal side and never
appear in admission, and the proposal asserts no proof of its own — the Host makes
those from durable state. The Action Gate revalidates immediately before any
effect: the assignment still exists, it still belongs to the proposed Session, and
no other delegation on that Session still holds work that could be stopped. A
delegation link ends only by supersession or a resolved stop, so finished work
stays linked while ceasing to be a competing stop target; execution state that
cannot be read counts as competing, never as finished. Visibility is proved for
the stopped delegation alone, because nothing retires a delegation whose Session
was deleted and proving it over the whole active set would let one deleted Session
block every stop. A stale resolution therefore fails closed, while a rename between
resolution and admission is correctly irrelevant. Trusted user text still has to
carry a direct stop imperative, and the `user_stop` confirmation stays outside
strategy output, so neither model output nor a display name can select what gets
stopped.

Direct stop persists a distinct `delegation_stop_requested` claim before
retirement and a `delegation_stop_resolved` observation afterward. The pending
cancellation tombstone retains the destructive action identity, preserving
`cancelled_pending` across a crash between those two Coordination records. Its
owning-root Stop uses an action-derived abort source on the exact target Turn,
so recovery cannot mistake a normal Session stop for WorkHub delivery. Its
admission holds the Coordination Session together with every active target
Session lane while re-reading the active links. A concurrent assignment must
therefore settle before the sole-delegation proof, wait until after the stop
claim, or cause admission to fail closed. Only a confirmed direct stop records
that provenance: a route correction retiring the same owning root carries its own
cancellation claim but keeps the neutral Stop source, so replay cannot read a
correction as a delivered stop.

Every durable WorkHub record is keyed by what it is about — an assignment by its
action, a stop or replacement by its delegation — so no single record can see an
action identity that moved to a second delegation or a second disposition. A
separate durable action claim, taken under the same Coordination admission
before any effect, is that global owner. Exact replay converges on it; any other
reuse of the identity fails closed before an effect, including after a rejected
or still-recovering attempt and across Host restarts. The claim carries no
Session foreign key, because a committed destructive claim has to outlive the
removal of its target: when the target Session is gone, its removal tombstone —
not the vanished Message proof, and never a merely unreadable target — is what
lets the stop reach a terminal resolution.

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
  that transcript; target lifecycle projection and the hybrid first-response
  contract are implemented as rebuildable reads. Linked correction, exact
  target-owned pending cancellation/Turn Stop, atomic supersession, and retry-based
  replacement recovery and direct stop are implemented. Direct
  stop uses durable `delegation_stop_requested` / `delegation_stop_resolved`
  facts, exact Message ownership, and first-claim-wins arbitration with
  replacement. Its target comes from the shared Session Resolver port, whose
  first implementation is a temporary exact-name baseline; replacing it changes
  recall only, because admission revalidates opaque identity and expected state
  rather than any display name. Pause, resume, and pronoun-based stop controls
  remain later work.

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
