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
delegating; and `clarify` continues in the Coordination Session without guessing or
creating.

**delegation**: A bounded reference from a Coordination Turn to one target ordinary
Session and Turn, including only its identity, disposition, and coordination-owned
link status (`active` or `superseded`). Delegation links the separately authoritative
transcripts; it does not copy the target's complete execution transcript into
WorkHub. Target acceptance, running, waiting, completion, failure, abort, and
recovery state remain ordinary Session facts and appear in WorkHub only as read-only
projections.

**Action Gate**: The deterministic Runtime boundary that validates a proposed
disposition and operation before any write, including target/Host validity,
archive and waiting state, self-routing, explicit creation, expected-Turn Stop
ownership, confirmation, tools, and permissions. All model and routing output is
advisory and cannot authorize a write.

**Route correction**: A user's decision that an input belongs to a different
existing Session. R2.4 retains only bounded inference memory for later target
resolution. Correction precedence follows user submission order, not asynchronous
completion order, and it never replaces either Session's transcript authority.

**R2.4**: The deterministic context-continuity routing baseline. It remains useful
as an experiment baseline or target resolver behind WorkHub's coordination layer;
it is not the final architecture or authority boundary of WorkHub.

_Avoid_: copied execution transcripts, self-routing, a second Session/WorkHub
storage substrate, or treating model/routing output as execution authority.
