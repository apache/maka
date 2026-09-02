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

# WorkHub action and Session resolution design

- Status: Proposed
- Date: 2026-09-02
- Scope: WorkHub routing, Session resolution, and action admission
- Architecture source: [Discussion #3286](https://github.com/apache/maka/discussions/3286)
- Delivery tracker: [Issue #3492](https://github.com/apache/maka/issues/3492)
- Review source: [PR #4439 architecture discussion](https://github.com/apache/maka/pull/4439#issuecomment-5496214312)

## Purpose

This document preserves the path from the first WorkHub experiment to the
current production slices, records why the original R2.4/R3 experiment needs a
sharper boundary, and defines the work required to reach that boundary.

The central change is:

> WorkHub first identifies the kind of action the user is requesting, then uses
> one shared Session Resolver to recall existing work, and finally lets an
> action-specific deterministic policy decide whether that resolution is
> sufficient to propose an action. The Action Gate remains the authority that
> revalidates and admits the proposal before any write or effect.

## History and original experiment branches

The first feasibility work intentionally explored the whole user experience
before the production authority boundaries were settled.

| Branch or PR | Purpose | Outcome |
| --- | --- | --- |
| `codex/unified-session-experiment` | End-to-end feasibility prototype for one conversational entry point, work cards, routing, clarification, creation, and coordination | Demonstrated the user model; not a production authority design |
| `codex/workhub-mainline` / #3426 | First integrated WorkHub implementation | Closed after the work was decomposed |
| `codex/workhub-session-router` / #3497 | Conservative R2.3 Session router | Merged |
| `codex/workhub-rebuildable-projection` / #3648 | Rebuild WorkHub from ordinary Session transcripts | Merged |
| `codex/workhub-context-continuity` / #3674 | R2.4 deterministic context continuity and correction behavior | Merged as the deterministic baseline |

Four later local branches implemented the original post-Slice-5 plan ahead of
review. They are useful prototypes, but they predate the shared Resolver design
and are not suitable for direct publication without rebasing and redesign:

| Branch | Original purpose |
| --- | --- |
| `feat/workhub-routing-strategies` | Versioned R2.4, R3-A, and R3-B strategy interface |
| `test/workhub-routing-evaluation` | Common routing evaluation harness |
| `feat/workhub-routing-rollout` | Feature-flagged strategy rollout and telemetry |
| `feat/workhub-anchor-rail` | Filtered, rebuildable WorkHub Anchor Rail |

## Original routing plan

The original plan compared three complete routing strategies behind the same
Action Gate:

| Strategy | Disposition decision | Target selection |
| --- | --- | --- |
| R2.4 baseline | Deterministic regex and heuristics | Deterministic exact-name, lexical/core-entity, focus, and recency rules |
| R3-A model-direct | Model | Model selects one opaque reference from bounded valid candidates |
| R3-B model-gated-R2.4 | Model | R2.4 selects the target only after `delegate_existing` |

The evaluation plan called for a fixed Session snapshot, common model and
reasoning settings, bounded candidate summaries, the same Coordination
transcript prefix and Runtime facts, repeated model-backed runs, separate
disposition and target accuracy, safety metrics, latency, tokens, and cost.

This was a valid experiment plan, but its strategy boundary was too coarse.
R2.4 combined action recognition, existing-Session retrieval, target selection,
creation, clarification, and final disposition in one policy. R3-A similarly
asked one model decision to select both behavior and target. Those shapes make
it difficult to improve Session recall without changing action semantics, or to
tell whether an error came from intent recognition, retrieval, or policy.

## Production work already delivered

The production implementation kept the important authority boundaries while
delivering the tracker in reviewable slices:

| Slice | Delivery | Implemented boundary |
| --- | --- | --- |
| 1 | #3742 | Per-Runtime-Host Coordination Session ADR and domain language |
| 2 | #3764 | Stable Coordination Session lifecycle, recovery, Host scope, and self-route exclusion |
| 3 | #3798 | Persistent WorkHub conversation and `answer_here` |
| 4 | #3818 | Typed non-destructive coordination protocol and deterministic Action Gate |
| 5A | #3935 | Durable delegation linkage and atomic target admission |
| 5B | #4115 | Rebuildable delegated execution-status projection |
| 5C | #4242 | Linked correction, exact Message ownership, replacement arbitration, and replay |
| 5D | #4439 | Direct stop claims, pending cancellation, owning-root Stop, and stop/replacement arbitration; under review |

Projection checkpoint stabilization in #4210 supports this path without adding
a second lifecycle authority.

These pieces remain valid under the new design. In particular, the Coordination
Session, target Session authority, durable delegation identities, and Action
Gate do not depend on one natural-language resolver.

## Problem exposed by direct stop

The first direct-stop path recognizes stop-specific text and performs exact
Session display-name matching before it enters the durable action protocol.
Although intentionally conservative, leaving that implementation embedded in
the stop path would establish a second target resolver by construction. Future
actions such as inspect, continue, pause, and resume would then tend to acquire
their own parsers and target rules.

Display names and raw messages are useful retrieval evidence. They are not
stable execution authority. A destructive action must ultimately refer to an
opaque Session/delegation identity and be revalidated against current Runtime
facts by the Action Gate.

## Target architecture

```text
user input
  -> Action Intent
  -> shared Session Resolver, when the action may refer to existing work
  -> per-action policy
  -> typed Action Proposal
  -> deterministic Action Gate
  -> durable persistence and owning-Host execution
```

### Action Intent

Action Intent identifies what the user is trying to do, for example discuss,
delegate, inspect, continue, stop, or resume. It carries trusted evidence from
the user input but does not select a Session and does not authorize an effect.

The first implementation may use deterministic parsing. A later classifier may
use a model, but its output remains advisory and bounded.

### Session Resolver

The shared Session Resolver answers only which visible existing Sessions are
relevant to the user's reference. Its result is one of:

```text
ranked existing Session candidates
none
ambiguous candidates
```

It does not return `create_new`, decide the final action, or grant authority.
Resolver inputs may include structured Session references, permitted Session
metadata, current and previous focus, recency, active/running state, active
delegation presence, and permitted raw-message evidence. Resolver output uses
opaque Runtime-issued candidate references rather than model-invented Session
identities.

The initial implementation can preserve exact-name behavior behind a shared
`SessionResolver` contract. A later deterministic ranked resolver can add
lexical retrieval such as BM25. Any index is a rebuildable projection: hidden,
archived, or logically deleted Sessions are included or excluded by explicit
visibility policy, and the index never becomes Session lifecycle authority.

Raw cross-Session messages may support retrieval, but are not injected into the
target execution context merely because they matched.

### Action Policy

An action-specific deterministic policy combines Action Intent, Session
resolution, and current product rules. It decides whether to:

- propose an action against an existing Session;
- explicitly create new work;
- ask the user to clarify;
- answer in the Coordination Session; or
- reject the request safely.

`create_new` belongs here, not in Session retrieval. A policy may skip existing
Session resolution when the trusted user request unambiguously requires a new
Work and existing work is irrelevant. Otherwise, it can resolve first and allow
creation only when explicit creation evidence and the absence of a suitable
existing Session satisfy that action's rules. When WorkHub creates a Work, the
result must say so explicitly to the user.

Different actions have different sufficiency rules. Stop may require one unique
active WorkHub delegation; inspect may allow several ranked read-only results;
delegate may clarify, reuse an existing Session, or create a new one; resume may
require a resumable lifecycle state.

### Typed Action Proposal

The policy produces a closed typed proposal containing stable target identities
and expected-state preconditions. It is not yet permission to execute. Natural
language, display names, relevance scores, and model explanations are evidence,
not durable identifiers.

### Action Gate and execution

The existing Action Gate remains the final deterministic admission boundary. It
revalidates current Host scope, target existence, visibility and lifecycle,
ownership, active delegation identity, idempotency, confirmation, tools, and
permissions immediately before persistence or execution.

The owning Host then persists the admitted action and executes it through the
authoritative target Session. Retrieval indexes and WorkHub projections remain
rebuildable and non-authoritative.

## Reframing the R-series experiment

The original R2.4/R3-A/R3-B work should be retained as experimental hypotheses,
but expressed as replaceable components rather than complete routers:

| Arm | Action Intent | Session Resolver | Action Policy and Gate |
| --- | --- | --- | --- |
| Deterministic baseline | Deterministic parser | Exact-name plus deterministic lexical/focus rules | Deterministic |
| Model-intent + deterministic resolution | Bounded model classifier | Deterministic ranked resolver | Deterministic |
| Model-intent + model-ranked resolution | Bounded model classifier | Model ranks opaque bounded candidates | Deterministic |

This preserves the safety comparison while exposing where each error occurs.
Evaluation must separately report intent classification, candidate recall,
ranking/target accuracy, policy outcome, gate rejection, and downstream target
execution.

## Required work

### 1. Establish the port in Slice 5D

- Introduce the shared `SessionResolver` contract.
- Put the current exact-name behavior behind a temporary deterministic
  implementation.
- Make direct stop consume the resolved opaque Session/delegation identity.
- Keep durable stop execution, replay, ownership, and arbitration unchanged.
- Avoid documenting exact-name stop grammar as the long-term product contract.
- Record follow-up removal criteria for the temporary resolver.

The temporary resolver can be removed when all target-bearing WorkHub actions use
the shared contract, the replacement resolver passes the common evaluation, and
the rollout retains a tested rollback path.

### 2. Build the deterministic shared Resolver baseline

- Define visibility and candidate-bounding policy.
- Combine structured references, exact names, focus, recency, lifecycle, active
  delegation, and deterministic lexical evidence.
- Return ranked candidates with typed evidence and explicit none/ambiguity.
- Route continue, inspect, stop, resume, and delegation through the same port.

### 3. Add rebuildable lexical retrieval

- Index permitted Session metadata and bounded raw-message chunks.
- Start with a deterministic BM25 shadow implementation.
- Aggregate message hits by Session identity, then rank Sessions using a small,
  observable feature set.
- Measure recall and ranking without granting actions or injecting matched text
  into execution context.

### 4. Rebuild the experiment harness

- Rebase useful code from `feat/workhub-routing-strategies` and
  `test/workhub-routing-evaluation` onto the component boundaries above.
- Hold the Session snapshot, transcript, Runtime facts, model configuration, and
  inputs constant across arms.
- Report each pipeline stage separately and repeat model-backed runs.
- Preserve adversarial tests for prompt injection, stale candidates, ambiguous
  references, implicit creation, and destructive actions.

### 5. Select and roll out a production composition

- Select intent and resolver implementations from evidence.
- Adapt the useful flag, telemetry, and rollback ideas from
  `feat/workhub-routing-rollout`.
- Shadow new resolution before it can propose effects.
- Keep the Action Gate and ordinary Session authority invariant across rollout.

### 6. Complete projection enhancements independently

- Rebase the useful filtered Anchor Rail work from `feat/workhub-anchor-rail`.
- Add Work filtering and generation-safe bounded refresh.
- Keep every projection non-authoritative and rebuildable.

## Acceptance criteria

- Stop, continue, inspect, resume, and delegation do not own separate natural-
  language target resolvers.
- `create_new` is never emitted by Session retrieval.
- Every executable proposal contains opaque stable identities and expected-state
  preconditions.
- The Action Gate revalidates all authority immediately before effects.
- Resolver replacement requires no change to durable stop/delegation protocols.
- Evaluation attributes failures to the correct pipeline stage.
- Creating a new Work is explicit in both trusted input evidence and user-visible
  acknowledgement.
- Resolver indexes and UI projections can be discarded and rebuilt without
  losing Session or coordination truth.

## Deferred decisions

- Whether Work remains 1:1 with Session, becomes 1:N, or gains an independent
  durable identity.
- Cross-Runtime-Host coordination.
- The final retrieval algorithm and ranking weights.
- Large-scale semantic/vector retrieval beyond the deterministic baseline.
- Removing R2.4 compatibility behavior before evaluation and rollback criteria
  are satisfied.
