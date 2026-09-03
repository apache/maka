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

WorkHub gives users one persistent conversational place to ask, clarify, continue,
create, and inspect work. It is backed by one stable Coordination Session per
Runtime Host while concrete execution remains authoritative in ordinary Sessions.

This document names the approved target architecture. Each Runtime Host now
provisions and reuses the stable Coordination Session role described below. The
current R2.4 routing behavior remains a transitional deterministic baseline or
target resolver; it does not define the final WorkHub coordination semantics. The
decision and authority boundaries are recorded in the
[WorkHub Coordination Session ADR](./architecture/workhub-coordination-session-adr.md).

## Terms

**Session**: The existing transcript, execution-boundary, permission, interaction,
and recovery substrate. A Session owns only the conversation or execution admitted
to that Session.

**Coordination Session**: The stable special Session role owned independently by
each Runtime Host for its WorkHub conversation. It owns WorkHub user messages,
ordinary Q&A, clarification, coordination decisions, bounded delegation references,
and coordination summaries, but no ordinary Session execution or lifecycle facts.
It is not a separate database, event store, transcript substrate, or lifecycle
authority. It is hidden from the ordinary Session list and excluded from every
routing-candidate set, so it never routes to itself. Cross-Host coordination is not
supported in the first milestone.

**ordinary Session**: A Session that owns concrete work execution, including its
project/filesystem scope, model and permissions, root-Turn admission, tools,
artifacts, recovery, lifecycle, and authoritative execution transcript.

**Work**: User-facing continuity around a goal. Whether Work is 1:1 with Session,
1:N over Sessions, or an independent durable entity is deliberately unresolved.

**WorkHub**: The unified conversational entry and coordination surface backed by
the active Runtime Host's Coordination Session. It may answer locally, clarify,
delegate to an existing ordinary Session, or create a new ordinary Session.

**projection**: A rebuildable, read-only view derived from Coordination Session and
ordinary Session facts. WorkHub cards, filters, status summaries, and navigation
aids are projections; they own no durable facts and can be discarded without losing
work.

**disposition**: The single proposed coordination outcome for one WorkHub input:
`answer_here` answers in the Coordination Session; `delegate_existing` targets one
bounded, valid ordinary Session; `create_new` creates an ordinary Session before
delegating and is visibly announced as new work; and `clarify` continues in the
Coordination Session without guessing or creating.

**Action Intent**: A bounded interpretation of what the user is trying to do,
such as discuss, delegate, inspect, continue, stop, or resume. It carries trusted
user-input evidence but no selected Session and no execution authority.

**Session Resolver**: The shared, replaceable capability that recalls and ranks
visible existing ordinary Sessions for a user reference. It may return ranked
candidates, no candidate, or ambiguity. It never returns `create_new`, chooses a
final coordination outcome, or grants execution authority. Exact-name matching is
only a temporary deterministic implementation; future ranked implementations use
the same contract.

**Action Policy**: Deterministic, action-specific rules that combine Action Intent,
Session resolution, and current product constraints to propose an existing-target
action, explicit creation, clarification, local discussion, or safe rejection.
Creation is a policy decision rather than a retrieval result.

**Action Proposal**: A closed typed request produced by an Action Policy. It uses
opaque stable target identities and expected-state preconditions, but remains
advisory until the Action Gate revalidates and admits it.

**delegation**: A bounded reference from a Coordination Turn to one target ordinary
Session and Turn, including only its identity, disposition, and coordination-owned
link status (`active`, `superseded`, `aborted`, or `stopped`). A link is `aborted` only when a
correction retired its source but the replacement target became unavailable or
started waiting before admission; it is not the target Turn's execution status.
Delegation links the separately authoritative transcripts; it does not copy the
target's complete execution transcript into WorkHub. Target acceptance, running,
waiting, completion, failure, abort, and recovery state remain ordinary Session
facts and appear in WorkHub only as read-only projections.

**Action Gate**: The deterministic Runtime boundary that validates a proposed
disposition and operation before any write, including target/Host validity,
archive and waiting state, self-routing, explicit creation, expected-Turn Stop
ownership, confirmation, tools, and permissions. All model and routing output is
advisory and cannot authorize a write. An initial `create_new` requires affirmative,
executable trusted user text; a corrective `create_new` additionally requires an
explicit new-Session clause. Negated or withdrawn creation intent is rejected in
both cases.

**Route correction**: A user's explicit decision that an input belongs to a
different existing or newly created Session. R2.4 retains only bounded inference
memory for target resolution; destructive confirmation must also be evidenced by
an affirmative target action in the trusted user text; negated or withdrawn target
actions fail closed and cannot come from routing output alone. The Coordination
Session durably claims one replacement intent per source delegation in transcript
order. It delegates exact pending-Message cancellation or owning-Turn Stop to the
target Session, then atomically records the replacement link and supersession.
Only a root Turn created by the delegated Message may be stopped; consuming the
Message as steering does not give WorkHub ownership of the surrounding user Turn.
When recovery folds multiple source Messages into one successor Turn, every source
shares that Turn and no individual delegation owns Stop authority over it.
Replacement replay is bound to the resolved stable target Session identity. If
that target becomes unavailable, waits for user input, or corrective creation
cannot be admitted after source retirement,
the Coordination transcript records an auditable replacement-aborted terminal
fact and removes the retired source from active linkage.
Correction never replaces either Session's transcript authority.

**Direct stop**: A user's explicit imperative to retire one active durable
delegation. A delegation link ends only by supersession or a resolved stop, so a
delegation whose work has finished is still linked; it is no longer a stop target,
because there is nothing left in it to stop. Only work that could still be stopped
makes a Session's stop target ambiguous, and execution state that cannot be read
is never treated as finished. The initial deterministic implementation accepts exact display-name
references behind the shared Session Resolver contract; exact-name syntax is not
the long-term product boundary. Pronouns, pause/wait language, questions, advice,
negation, unresolved or ambiguous targets, and model-supplied Session, Turn, Run,
or Message identities grant no Stop authority. A future ranked resolver may recall
a Session from other permitted evidence, but the Action Policy must still require a
sufficiently resolved active WorkHub delegation and the Action Gate must revalidate
its stable identity. The stop proposal therefore carries opaque identities and the
expected active-delegation state the policy resolved against, never a display name;
the Action Gate readmits it only while the assignment still belongs to that Session
and that Session's active delegations are still exactly the one being stopped.
A rename between resolution and admission is irrelevant, and a stale resolution
fails closed. WorkHub first records
`delegation_stop_requested`, resolves the source action to its durable
delegation, and lets the target Session's Message authority observe one of four
outcomes: `cancelled_pending`, `stop_delivered`, `already_terminal`, or `not_owned`.
It then records the neutral `delegation_stop_resolved` fact. `stop_delivered` means
the exact owning root accepted the Stop operation; the UI says that WorkHub asked
it to stop rather than inventing an execution result. `not_owned` means the
Message was consumed by a shared or user-owned Turn; WorkHub does not stop that
Turn, preserves the active link, and navigates the user to the owning Session.
A stop reference that recalls no existing WorkHub Session is ordinary work — `Stop
using the deprecated API` is a task, not a destructive command — and routes
normally. An ambiguous recall, a resolved Session that is not uniquely stoppable,
and an unsafe or anaphoric reference each fail closed with the reason they failed
rather than an unanswerable prompt. Whether a resolved Session is uniquely
stoppable is asked of the Host once a reference resolves, never answered from a
client's delegation projection: that projection is empty until the Coordination
stream fills it, so a fresh window or a reconnect would otherwise state
confidently that running work does not exist.
An unresolved direct-stop claim and a replacement claim are mutually exclusive;
the first durable destructive claim wins. A `not_owned` resolution releases that
exclusion so a later explicit route correction can proceed, and because it leaves
the delegation active, a later attempt under a fresh request identity converges on
that same immutable `not_owned` outcome instead of colliding with the first claim.
The pending-Message cancellation tombstone binds the durable stop action that
created it, so a crash after cancellation but before resolution still replays
`cancelled_pending` rather than degrading to `already_terminal`. Owning-root Stop
likewise writes the direct-stop action identity into the exact root Turn's
durable abort source. A retry recognizes only that matching proof; an earlier or
concurrent manual Stop remains `already_terminal`. Root registration is in-memory,
so between a Host restart and execution recovery a running root looks inactive.
`already_terminal` is an immutable observation, so only a durably terminal target
snapshot may claim it; an unrecovered target is still resolving instead. Stop admission holds the
Coordination Session and every currently active target Session lane
while it rechecks current target identities and active links; a concurrent new
delegation therefore cannot invalidate the one-target proof after the request
record commits. Removing the target Session destroys the Message proof a
committed claim still needs; the removal tombstone outlives that Session and
resolves the claim as `already_terminal`, while a target that is merely
unreadable, or one that never existed here, stays unresolved.

**R2.4**: The deterministic context-continuity routing baseline. It remains useful
as an experiment baseline or target resolver behind WorkHub's coordination layer;
it is not the final architecture or authority boundary of WorkHub.

_Avoid_: copied execution transcripts, self-routing, a second Session/WorkHub
storage substrate, or treating model/routing output as execution authority.
