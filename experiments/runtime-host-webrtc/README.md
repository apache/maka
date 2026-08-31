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

# Runtime Host WebRTC Phase 0

This bounded experiment answers one question: can standard libp2p private-to-private WebRTC add a
useful direct path when Maka's existing QUIC/DCUtR path cannot connect, without creating a second
peer network or identity authority?

The code is deliberately not wired into Desktop or Runtime Host. It uses the standard
`/webrtc-signaling/0.0.1` protocol over an existing Noise-authenticated Circuit Relay v2 connection,
injects the resulting WebRTC connection into the same rust-libp2p Swarm, closes the relayed path,
and verifies an existing libp2p echo protocol over the direct connection.

The frozen results and limitations are in [evidence/phase0-results.md](evidence/phase0-results.md).

## Dependency decision

The experiment pins `webrtc-rs/webrtc` to exact revision
`e132552fc67b84c30e63c5ce916a9a63e2484b6f`. The published `0.21.0-rc.1` tag points its `rtc`
submodule at `51558ffb550bb17a540343b338e2cd4a764f3690`, before the following fixes:

- `rtc#226`: use the RFC 9260 one-second SCTP initial retransmission timeout;
- `rtc#228`: do not deliver inbound DataChannels before SCTP reaches `Established`.

With the older implementation, the controlled WAN profile reproduced one post-connect first-stream
timeout in 13 runs. The exact revision includes `rtc` revision
`7df0a825c53155850b4e76dda03815c9902a801f` and completed 20/20 equivalent runs. A formal release
that contains these commits may replace the git pin without changing product behavior.

## Toolchain

The recorded environment was:

- Rust/Cargo 1.98.0;
- Docker Engine 29.1.3 on Ubuntu 26.04, Linux x86_64;
- Docker Engine 29.4.0 on macOS 26.6, Apple Silicon;
- Node 24.18.0 and npm 11.19.0 for the independent JavaScript interop peer;
- Zig 0.16.0 and cargo-zigbuild 0.23.3 for cross-link smoke tests.

Docker is only needed for the synthetic NAT matrix. The image contains the harness runtime,
`iptables`, `conntrack`, `tc`, and coturn in STUN-only mode. It does not provide TURN.

## Deterministic checks

From this directory:

```bash
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
cargo deny --config ../../deny.toml check licenses
```

Cross-link smoke tests:

```bash
cargo zigbuild --locked --release --bin webrtc-harness \
  --target aarch64-unknown-linux-gnu
cargo zigbuild --locked --release --bin webrtc-harness \
  --target x86_64-pc-windows-gnu
```

These prove compilation and linking, not native Windows load/stop behavior. Native Windows smoke
remains a formal implementation gate.

## Controlled NAT matrix

Build the harness on the Linux Docker host, then run one case:

```bash
cargo build --locked --bin webrtc-harness
./scripts/run-nat-case.sh webrtc udp-cone
./scripts/run-nat-case.sh dcutr udp-cone
```

The default topology has two endpoints behind independent NAT routers, a TCP Circuit Relay v2
coordination node, and a separate STUN node on an isolated public network. The script rejects routes
between the private networks so Docker host routing cannot turn the case into accidental LAN access.

Useful controls:

```bash
# Double NAT with a WAN-like 60 +/- 15 ms delay and 1% loss.
MAKA_WEBRTC_NAT_LAYERS=2 \
MAKA_WEBRTC_OUTER_NAT_KIND=udp-cone \
MAKA_WEBRTC_LINK_PROFILE=wan \
./scripts/run-nat-case.sh webrtc udp-cone

# The same topology with a QUIC coordination relay.
MAKA_WEBRTC_NAT_LAYERS=2 \
MAKA_WEBRTC_OUTER_NAT_KIND=udp-cone \
MAKA_WEBRTC_RELAY_TRANSPORT=quic \
./scripts/run-nat-case.sh dcutr udp-cone

# Failure controls.
./scripts/run-nat-case.sh webrtc symmetric
./scripts/run-nat-case.sh webrtc udp-blocked
```

Supported values:

- NAT kind: `full-cone`, `udp-cone`, `endpoint-dependent`, `symmetric`, `udp-blocked`;
- `MAKA_WEBRTC_NAT_LAYERS`: `1` or `2`;
- `MAKA_WEBRTC_RELAY_TRANSPORT`: `tcp` or `quic`;
- `MAKA_WEBRTC_LINK_PROFILE`: `clean`, `delay`, `loss`, or `wan`;
- `MAKA_WEBRTC_STUN_URL`: explicit STUN URL;
- `MAKA_KEEP_WEBRTC_TOPOLOGY=1`: preserve containers and networks for inspection.

The script cleans up its containers and networks on exit by default.

## Independent js-libp2p interop

The JavaScript fixture is a conformance oracle only. It is never part of the product runtime. It
prevents a matching bug in two Rust endpoints from being mistaken for protocol compatibility.

Install its exact lockfile:

```bash
npm --prefix interop ci --omit=peer
npm --prefix interop audit --omit=peer
```

`@libp2p/webrtc` declares React Native peer dependencies for other runtimes. They are not loaded by
this Node-only fixture, so omitting peer packages keeps the independent test surface smaller and
avoids installing an unrelated Metro/React Native toolchain.

Start a Rust relay and copy its emitted PeerId into `<relay>`:

```bash
cargo run --locked --bin webrtc-harness -- \
  relay /ip4/127.0.0.1/tcp/44001
```

For JavaScript dialer to Rust listener, start the Rust answer peer, then dial its standard relayed
WebRTC address and expected PeerId:

```bash
cargo run --locked --bin webrtc-harness -- answer webrtc \
  /ip4/127.0.0.1/tcp/44001/p2p/<relay> stun:stun.cloudflare.com:3478
npm --prefix interop run dial -- \
  /ip4/127.0.0.1/tcp/44001/p2p/<relay>/p2p-circuit/webrtc/p2p/<rust-peer> \
  <rust-peer>
```

For Rust dialer to JavaScript listener, start the JavaScript answer peer, then pass its emitted PeerId
to the Rust dialer:

```bash
npm --prefix interop run answer -- \
  /ip4/127.0.0.1/tcp/44001/p2p/<relay>
cargo run --locked --bin webrtc-harness -- dial webrtc \
  /ip4/127.0.0.1/tcp/44001/p2p/<relay> <js-peer> \
  stun:stun.cloudflare.com:3478
```

Both directions must report a WebRTC path, the expected authenticated PeerId, and an intact echo.

## What this experiment does not prove

- Synthetic Docker NAT is controlled evidence, not a population estimate for real networks.
- Public STUN or public Circuit Relay availability is not a Maka service guarantee.
- WebRTC without TURN does not cover symmetric NAT or UDP-blocked networks.
- The experiment does not implement path racing, Desktop UX, recovery, telemetry, or live migration.
- It does not justify a JavaScript sidecar, a second Swarm, a second PeerId, TURN, or a signaling
  service.

The product decision is therefore a bounded GO: add WebRTC as a second direct attempt inside the
existing native peer authority, keep QUIC/DCUtR and approved member transit, and fail back to the
existing path without replaying application mutations.
