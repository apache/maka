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

# Convergent peer reachability and recovery implementation plan

- Status: implementation plan
- Tracking issue: [#4554](https://github.com/apache/maka/issues/4554)
- Baseline: `main` at `72eb982d5081f610e047f18d96e2188f0fe17073`
- Delivery: four stacked pull requests

## Review charter

### Purpose

Deliver one bounded reachability and connection-recovery foundation for Peer Mesh,
direct Runtime Host profiles, and Session collaboration. When a usable locator or
recovery source remains, peers must converge without a new invitation. When no first
packet path can be recovered, the system must report `needs_repair` instead of hiding
the condition behind stale presence or unbounded retry.

### Supported paths

- A known current route is dialed immediately.
- A remembered Circuit Relay v2 anchor is reacquired after restart and then published.
- A current Mesh member supplies a newer signed locator through bounded anti-entropy.
- A new verified route wakes an in-flight connection or reconnect attempt.
- A Session guest reuses the recovered peer connection while opening the required
  post-finalization Runtime Host stream.
- A fresh invitation repairs an existing identity and membership when automatic
  recovery is objectively impossible.

### Non-goals

- Universal recovery after all shared locators disappear.
- A production rendezvous service, TURN service, Gossipsub overlay, js-libp2p sidecar,
  or public-DHT publication of Maka peer presence.
- Merging Desktop Client and Runtime Host identities.
- Replaying mutations whose outcome is unknown.
- Treating an external coordination relay as an application transit authority.
- Compatibility code for the unshipped peer-reachability representation.

### Merge bar

The stack is not acceptable if it introduces a second dialing/reconnect authority,
lets unsigned or cross-identity routes affect an attempt, conflates Mesh membership
with route freshness, publishes an unaccepted relay reservation, permits unbounded
candidate or history growth, replays an uncertain mutation, or presents a guest as
ready before authenticated catch-up reaches its canonical watermark.

### Scope expansion

The charter changes only if implementation evidence proves that the native endpoint
cannot accept live candidate updates without a second authority, or if a supported
consumer requires a stronger availability contract than issue #4554. A hypothetical
future consumer is not enough.

## Risk map

| Boundary | Risk | Required invariant |
| --- | --- | --- |
| Identity and signatures | A route is applied to the wrong peer | The expected PeerId is immutable and verifies every lease and transport winner |
| Authorization | Reachability becomes application authority | Mesh roster, Host Root/credential, and Session grant checks remain independent |
| Persistence | A restart reuses a revision or pretends a reservation survived | Lease revision is reserved durably before publication; only successful anchor history is persisted |
| Concurrency | New evidence creates competing attempts or accepts stale results | Native owns one fenced attempt per target and receives monotonic candidate updates |
| Recovery | Backoff sleeps through a restored path, or retries forever without a locator | New evidence wakes recovery; exhausted locator sources become `needs_repair` |
| Resource limits | Public discovery, history, or dialing grows without bound | Route, anchor, history, reconciliation, and attempt budgets remain explicit |
| Privacy | Public infrastructure or removed members receive sensitive metadata | Routes travel only in explicit invitations or authenticated current-roster control |
| Collaboration | Two authentication phases look like two network acquisitions | One peer connection is reused; readiness follows authenticated projection catch-up |

## Ownership model

`native/runtime-host-peer` remains the sole production connection authority. It owns
transports, relay reservations, candidate racing, attempt deadlines, cancellation,
winners, and stale-result fencing.

The TypeScript Runtime Host layer owns the Maka protocol facts around that endpoint:
self-signed reachability leases, restart-safe revisions, validation, authorized
distribution, and aggregation of evidence from caller bootstrap data and Mesh state.
It may wake or add evidence to a native attempt; it may not dial independently.

Peer Mesh owns its roster, presentation metadata, per-Mesh transit policy, and
authenticated anti-entropy. A Host profile or Session mount owns only its authorized
bootstrap copy for one expected peer. There is no authorization-blind global peer
directory.

```text
signed invitation / profile lease ───────┐
authenticated Mesh lease update ────────┤
remembered accepted relay reacquired ───┼──> native fenced attempt
direct observation / path upgrade ──────┘       ├── QUIC/TCP
                                                 ├── DCUtR
                                                 ├── WebRTC ICE
                                                 └── approved Mesh transit
```

## Core contracts

### PeerReachabilityLease

The peer self-signs one generic locator fact under a dedicated signature domain. It
contains only:

- schema version;
- issuer PeerId;
- restart-safe monotonic revision;
- issued-at and expiry timestamps;
- bounded direct routes;
- bounded coordination-only routes accepted by the running endpoint;
- signature.

Direct and coordination routes have distinct runtime-validated fields. The lease has
no Mesh ID, alias, endpoint kind, transit policy, Host Root ID, credential, Session ID,
or grant.

The publisher atomically persists the exact next signed lease before exposing it.
Skipped revisions are valid; publishing different facts at one revision is not. A
receiver validates signature, expected peer, bounds, signed lifetime, and revision.
Runtime freshness uses a local monotonic receipt deadline capped by the signed lifetime
so modest clock skew cannot turn an old lease into current truth. Restarted processes
conservatively revalidate persisted records against wall time.

### MeshMemberAdvertisement

A separate peer-signed record is scoped to one Mesh and contains only information
currently consumed by Mesh UX or policy:

- Mesh ID and member PeerId;
- monotonic advertisement revision;
- bounded alias;
- endpoint kind;
- whether this member currently offers transit in that Mesh;
- signature.

No speculative capability bag is introduced. The authority-signed roster remains the
only membership authority.

### Reachability resolver

The resolver provides an immediate verified snapshot, a non-blocking refresh request,
and an evidence subscription for one expected PeerId. Evidence is drawn only from the
caller's authorized bootstrap lease and current Mesh memberships. Current leases rank
above bounded historical hints; Mesh transit remains a separate candidate class.

`needs_repair` means the resolver completed a bounded sweep and has no current locator,
historical hint, remembered/reacquirable anchor path, or reachable current member. A
failed dial while recovery sources still exist remains `reconnecting`.

## Stacked delivery

### PR 1 — Reachability domain split

Branch: `refactor/peer-reachability-domain`

- Introduce the signed lease, validation, and explicit bounds.
- Create a generic peer endpoint owner/publisher that remains available even if Mesh
  startup fails; compose Mesh on top of it.
- Carry the signed lease through Host status. Existing connection code projects the
  authenticated lease into its current native input so behavior stays equivalent;
  stored consumers move with their owning layers in PR 3 and PR 4 rather than
  introducing a temporary compatibility reader.
- Persist the publisher revision independently from Mesh state.
- Advance the internal protocol compatibility boundary instead of accepting both Host
  status representations.

High-value verification:

1. A tampered, wrong-peer, oversized, or wrongly classified lease is rejected.
2. Publishing across a process restart never reuses a revision with different facts.

### PR 2 — Stable relay-anchor recovery

Branch: `feat/peer-relay-anchor-recovery`

- Persist a bounded set of relay addresses that previously accepted a reservation for
  this persistent PeerId. Never persist a live-reservation claim.
- Apply sources in the order manual, remembered, then public discovery.
- Reacquire remembered anchors before using discovery to replenish the existing
  candidate budget.
- Keep selection sticky, back off rejected anchors, and acquire a replacement before a
  planned release.
- Publish a coordination route only after native reservation acceptance.
- Expose an event-driven native reachability snapshot/generation so the TypeScript
  publisher renews leases without high-frequency polling.

High-value verification:

1. A locally controlled relay accepts once; after endpoint restart and without public
   discovery, the same PeerId reacquires it and publishes a higher lease revision.

### PR 3 — Convergent Mesh control

Branch: `feat/peer-mesh-reachability-convergence`

- Introduce the Mesh member advertisement and replace the mixed Mesh route record with
  independent leases and advertisements. Advance the unshipped storage/wire boundary
  without a dual-read or dual-write path.
- Carry signed leases through Mesh invitations and authenticated reconciliation.
- Make reconciliation symmetric: authority and replicas both initiate bounded sync.
- Replicas prefer the authority and rotate one current peer; the authority rotates
  current members.
- Reconcile leases and advertisements independently.
- Trigger a bounded pass for local lease changes, roster changes, restored network, and
  successful repair; retain a low-frequency periodic fallback.
- Keep only the latest small bounded historical hint per member within a fixed recovery
  horizon. Rate-limit it and never project it as online.
- Reuse the existing invitation redemption path to repair an active membership without
  creating a duplicate Mesh or member.
- Project `connecting`, `reachable`, `reconnecting`, and `needs_repair` from the common
  model rather than route TTL alone.

High-value verification:

1. A third current member transfers a newer lease without gaining authority.
2. A zero-locator member reaches `needs_repair`, then a fresh invitation repairs the
   existing membership and identity.

### PR 4 — Unified live recovery and collaboration

Branch: `feat/peer-live-route-recovery`

- Replace serial route preparation with immediate snapshot dialing plus concurrent
  refresh and subscription.
- Extend the existing native pending attempt with a request/attempt-fenced candidate
  update command. An initially empty attempt may wait for evidence until its deadline.
- Feed only newer verified lease and transit generations into the same attempt; do not
  cancel and recreate the connection state machine.
- Wake reconnect delay on newer route evidence, restored underlying peer connection,
  and supported network-resume signals without resetting authorization or replaying a
  mutation.
- Make direct Host profiles and Session collaboration use the same resolver.
- Store the target-bound signed lease in connection codes, direct Host profiles, and
  guest mounts; remove their unsigned route copies.
- Retain the peer connection across guest credential finalization, open only the
  required fresh Runtime Host stream, and derive Owner/Guest readiness from canonical
  authenticated catch-up.

High-value verification:

1. A newer route wakes one pending/reconnect attempt and succeeds without a second
   attempt or mutation replay.
2. Guest join has one visible network-acquisition lifecycle and becomes ready only
   after the canonical catch-up watermark.

## Validation and release gate

Each PR runs formatting, affected package type-check/build, and its focused tests before
submission. The completed stack then runs the repository CI-equivalent commands that
are practical locally. Public-network success is not a merge gate.

Topology-dependent acceptance uses the existing controlled NAT harness rather than
flaky normal CI. The final manual matrix is limited to remembered-anchor restart,
third-member recovery, honest zero-locator repair, and event-driven Session recovery.

## Review process and finding ledger

After all four PRs exist, one correctness/security reviewer and one bounded
simplification reviewer independently inspect the full stack against this frozen
charter. Their evidence is adjudicated into this ledger:

| ID | Source | Decision | Evidence or resolution |
| --- | --- | --- | --- |
| — | — | open | No findings recorded yet |

Only findings that affect the merge bar and have a proportionate root fix enter the
stack. Narrow constructed paths and low-value polish do not. A local fix triggers a
targeted re-review unless it changes authority, persistence, protocol, concurrency, or
lifecycle; those changes trigger one fresh full parallel review. The loop stops when
high-risk boundaries and external PR comments are adjudicated and no confirmed finding
remains.
