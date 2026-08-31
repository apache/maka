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

# Phase 0 evidence snapshot

Recorded on 2026-08-31. Candidate addresses, SDP, credentials, and raw IP-bearing logs are excluded.

## Decision

**GO, bounded to an experimental second direct attempt in the existing Rust peer endpoint.**

The decision is based on a repeatable topology where TCP-coordinated DCUtR failed 10/10 while WebRTC
ICE succeeded 10/10, including double NAT. It is not a claim that WebRTC dominates DCUtR: when the
coordination relay used QUIC, DCUtR succeeded faster in the same topology. The product should race or
prefer existing direct mechanisms and retain approved member transit as fallback.

## Results

| Topology or check | DCUtR | WebRTC | Decision-relevant observation |
|---|---:|---:|---|
| macOS same process | not a NAT sample | success, 255 ms | Standard signaling and same-Swarm transport seam work |
| macOS arm64 to Linux x64 LAN | not a NAT sample | success, 591 ms | Same application protocol works after closing CRv2 |
| Two full-cone NATs | success, about 80 ms | success, about 976 ms | WebRTC must not replace a faster existing path |
| Two UDP-cone NATs, TCP coordination relay | 0/10 | 10/10, 989-995 ms | Decisive incremental topology |
| Double UDP-cone NAT, TCP coordination relay | failed | success, 995 ms | Increment survives an extra NAT layer |
| Same double NAT, QUIC coordination relay | success, 175 ms | success, 1,033 ms | QUIC observed address closes this particular DCUtR gap |
| Endpoint-dependent NAT pair | 1/10 | 0/1 | Neither direct method dominates |
| Symmetric NAT pair | failed | failed | Requires approved transit or honest failure |
| UDP blocked | failed | failed | No TURN coverage is claimed |
| STUN unavailable | not repeated | failed with host candidates only | STUN is necessary for the incremental path |

Two independent 60-second samples of Maka's dynamic public relay discovery, one on macOS and one on
Linux, each selected two active relay reservations. All four selected routes were TCP. This does not
estimate the public pool distribution; it only establishes that TCP-only coordination is a real
product topology rather than a Docker-only premise.

## Tail failure and dependency resolution

Using crates.io `webrtc 0.20.4`, the double-NAT WAN profile completed 12/13 attempts. The failed run
reached ICE and PeerConnection `Connected`, but the first application DataChannel never became
usable. The symptom matches `webrtc-rs/rtc#227`; merged fix `rtc#228` gates inbound DataChannel
delivery until SCTP reaches `Established`. The release candidate `webrtc v0.21.0-rc.1` predates that
fix and also predates `rtc#226`, which changes the SCTP initial RTO from three seconds to the RFC 9260
one-second value.

The exact dependency revision used here is:

- `webrtc`: `e132552fc67b84c30e63c5ce916a9a63e2484b6f`;
- included `rtc`: `7df0a825c53155850b4e76dda03815c9902a801f`;
- DataChannel fix commit: `e530b4cecb0f87eb26ba89a610529f2bca81ed8e`.

With that exact pin, the same double-NAT, TCP-relay, 60 +/- 15 ms and 1% loss profile completed 20/20
attempts. This is evidence for the pin, not proof that all tail failures are eliminated.

Primary upstream references:

- <https://github.com/webrtc-rs/rtc/issues/227>
- <https://github.com/webrtc-rs/rtc/pull/228>
- <https://github.com/webrtc-rs/rtc/issues/225>
- <https://github.com/webrtc-rs/rtc/pull/226>

## Protocol and implementation checks

- Standard `/webrtc-signaling/0.0.1`, bounded protobuf/unsigned-varint frames and trickle ICE.
- Expected PeerId is inherited only from the Noise-authenticated signaling connection; DTLS
  fingerprint continuity is checked before exposing the connection.
- The relayed connection is closed before the existing echo protocol is opened over WebRTC.
- Explicit cancellation closes the temporary RTCPeerConnection and leaves the existing CRv2 stream
  usable.
- Identity mismatch, deadline, signaling bounds and failure cleanup are covered by six focused Rust
  tests.
- Latest pinned js-libp2p fixture (`libp2p 3.3.10`, `@libp2p/webrtc 6.0.31`) interoperated in both
  directions with authenticated PeerId and intact application echo. Its Node-only install omits
  unrelated React Native peer packages and reports zero npm audit findings.
- `cargo fmt`, clippy with warnings denied, six tests, and ASF license policy passed.
- Native Linux x64 build/run passed; Linux arm64 and Windows x64 GNU release binaries linked; macOS
  arm64 ran the prototype and macOS x64 compiled. Native Windows load/stop remains a formal PR gate.

## Rejected alternatives

- **Production js-libp2p sidecar:** rejected because it creates a second Swarm, PeerId, connection
  manager, lifecycle and packaging authority. JavaScript remains an independent test oracle.
- **Private Maka signaling protocol:** rejected because the standard protocol interoperates.
- **Second Noise handshake above DataChannel:** rejected because standard private-to-private WebRTC
  already binds DTLS fingerprint continuity to the authenticated signaling connection.
- **TURN or central signaling:** rejected for this scope; CRv2 already provides authenticated
  coordination and approved member transit provides product fallback.
- **Replace QUIC/DCUtR:** rejected because QUIC is materially faster in the easy and QUIC-relay
  controls.
- **Persist ICE candidates or expose protocol toggles:** rejected because candidates are ephemeral
  route facts, not Mesh identity or user policy.

## Remaining evidence gates

- Native Windows x64 build/load/stop in the packaged helper shape.
- Real household, mobile/CGNAT, IPv6/mixed, sleep/wake, interface-change and UDP-blocked samples.
- Artifact/RSS/task-lifecycle measurements in the actual helper process.
- Confirmation that cancellation and losing-race cleanup remain bounded after integration.

These gates belong to the formal stacked PRs. They do not justify expanding the approved scope.
