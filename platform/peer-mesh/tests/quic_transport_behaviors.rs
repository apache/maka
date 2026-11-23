/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use maka_event_log::{
    ROOT_MIGRATIONS,
    root::{RootNamespaces, RootOwner, private_directory},
    root_store::RootStore,
};
use maka_host_runtime::application::{
    host::{
        Channel, Client as HostClient, Configuration, Host, LifecycleMode, OpenChannel, Options,
        websocket::{self, WebSocketListener},
    },
    logs,
    transport::{GATEWAY, Reply},
};
use maka_packages::Package;
use maka_peer::{
    DEFAULT_LEASE_TTL_MS, DirectRoute, DirectTransport, NodeIdentity, PeerId,
    PeerReachabilityLeaseV1, ResumablePeerStream, SignedPeerReachabilityLeaseV1,
};
use maka_peer_mesh::{
    DEFAULT_HEDGE_DELAY, MeshId, MeshMemberEntry, MeshRole, MeshStateStore, MeshTransportNode,
    PeerMeshMemberAdvertisementV1, PeerMeshRosterV1, SignedPeerMeshMemberAdvertisementV1,
    SignedPeerMeshRosterV1, TransportError, WinningPath,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io,
    net::{SocketAddr, UdpSocket},
    num::NonZeroUsize,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

fn loopback_ephemeral() -> SocketAddr {
    "127.0.0.1:0".parse().unwrap()
}

fn package(id: &str, host: Value) -> Package {
    Package::new(BTreeMap::from([(
        "maka.extension.json".into(),
        serde_json::to_vec(&json!({"schemaVersion":1,"id":id,"application":{"host":host}}))
            .unwrap(),
    )]))
    .unwrap()
}

async fn open_real_host(dir: &Path) -> Arc<Host> {
    private_directory(dir).unwrap();
    let root = Arc::new(
        RootOwner::create(
            &dir.join("root"),
            &RootNamespaces {
                ownership: dir.join("ownership"),
                control: dir.join("control"),
            },
        )
        .unwrap(),
    );
    let store = Arc::new(RootStore::open(root, ROOT_MIGRATIONS).await.unwrap());
    let contract = logs::contract();
    let logs_pkg = package(
        "test.logs",
        json!({
            "implementation":{"kind":"native","implementation":logs::HOST_LOGS},
            "configuration":{"type":"object"},"imports":{},
            "exports":{"HostLogs":{"contract":contract,"availability":"required"}}
        }),
    );
    let gateway_pkg = package(
        "test.gateway",
        json!({
            "implementation":{"kind":"native","implementation":GATEWAY},
            "configuration":{"type":"object"},"exports":{},
            "imports":{"hostLogs":{"contract":contract,"cardinality":{"kind":"one"}}}
        }),
    );
    let consumer = Uuid::new_v4();
    let deployment = Uuid::new_v4();
    store
        .commit_application(
            deployment,
            0,
            serde_json::from_value(json!({"instances":{
                "logs":{"key":Uuid::new_v4(),"package":{"source":"pinned","package":logs_pkg.application_ref()},"usePackage":"host"},
                "gateway":{"key":consumer,"package":{"source":"pinned","package":gateway_pkg.application_ref()},"usePackage":"host",
                    "bindings":{"hostLogs":[{"kind":"instance","path":["logs"],"export":"HostLogs"}]}}
            }}))
            .unwrap(),
            vec![],
            vec![logs_pkg, gateway_pkg],
        )
        .await
        .unwrap();
    let configuration = Configuration::PublicHost {
        endpoints: serde_json::from_value(json!({
            "hostLogs":{"consumer":[consumer],"import":"hostLogs","grant":{"methods":["read"],"recovery":false}}
        }))
        .unwrap(),
        native: Default::default(),
        product_methods: Default::default(),
    };
    Host::open_with_options(
        store,
        deployment,
        Default::default(),
        None,
        configuration,
        Options {
            lifecycle_mode: LifecycleMode::Ephemeral,
            ..Default::default()
        },
    )
    .await
    .unwrap()
}

async fn call_host_logs_read(client: &HostClient) {
    let mut call = client
        .call(
            "hostLogs",
            "read".into(),
            json!({"position":{"kind":"tail"}}),
            Default::default(),
        )
        .await
        .unwrap();
    call.start().await.unwrap();
    match call.receive().await.unwrap() {
        Reply::Finished { result, cleanup } => {
            cleanup.unwrap();
            let page: maka_host_runtime::logs::HostLogPage =
                serde_json::from_value(result.unwrap()).unwrap();
            assert_eq!(page, maka_host_runtime::logs::HostLogPage::Missing);
        }
        other => panic!("unexpected HostLogs reply: {other:?}"),
    }
    call.close().await.unwrap();
}

fn signed_ad(
    mesh_id: &MeshId,
    member: &NodeIdentity,
    root_id: &str,
    endpoint: &str,
    accepts_transit: bool,
    peer_rtt_ms: BTreeMap<PeerId, u32>,
    revision: u64,
    now_ms: u64,
) -> SignedPeerMeshMemberAdvertisementV1 {
    let lease = PeerReachabilityLeaseV1::new(
        root_id,
        member.peer_id().clone(),
        Uuid::from_u128(revision as u128),
        revision,
        now_ms,
        now_ms + DEFAULT_LEASE_TTL_MS,
        vec![DirectRoute::new(DirectTransport::Quic, endpoint, 10).unwrap()],
        vec![],
    )
    .unwrap();
    let signed_lease = SignedPeerReachabilityLeaseV1::sign(lease, member, now_ms).unwrap();
    let ad = PeerMeshMemberAdvertisementV1::new(
        mesh_id.clone(),
        member.peer_id().clone(),
        revision,
        now_ms,
        accepts_transit,
        signed_lease,
        peer_rtt_ms,
    )
    .unwrap();
    SignedPeerMeshMemberAdvertisementV1::sign(ad, member).unwrap()
}

/// Real UDP QUIC direct transport: verifies mutual Ed25519 RFC 7250 RPK
/// authentication, rejects mismatched pinned PeerIds (MITM defense), measures
/// live QUIC RTT, finalizes real Bearer access, and serves HostLogs::read RPC.
#[tokio::test]
async fn quic_direct_mutual_ed25519_carries_real_host_rpc_and_rejects_wrong_peer_id() {
    let dir = TempDir::new().unwrap();
    let host_b = open_real_host(dir.path()).await;
    let pairing = host_b.prepare_access("quic-direct-a".into()).await.unwrap();
    let epoch = host_b.epoch();

    let id_a = NodeIdentity::generate().unwrap();
    let id_b = NodeIdentity::generate().unwrap();
    let wrong_id = NodeIdentity::generate().unwrap();

    let (node_a, _rx_a) = MeshTransportNode::bind(loopback_ephemeral(), id_a.clone(), None).unwrap();
    let (node_b, mut rx_b) = MeshTransportNode::bind(loopback_ephemeral(), id_b.clone(), None).unwrap();
    let node_a = Arc::new(node_a);
    let b_addr = node_b.local_addr();
    let b_peer = id_b.peer_id().clone();

    let mitm_attempt = node_a.dial_direct(wrong_id.peer_id(), b_addr).await;
    assert!(
        mitm_attempt.is_err(),
        "QUIC RPK client must reject a peer presenting a different Ed25519 public key"
    );

    let rtt = node_a.measure_rtt(&b_peer, b_addr).await.unwrap();
    assert!(rtt < Duration::from_secs(1), "loopback QUIC RTT unexpectedly high: {rtt:?}");

    let (ws_tx, ws_rx) = tokio::sync::mpsc::channel::<Channel>(16);
    let cancel = CancellationToken::new();
    let host_task = tokio::spawn({
        let host_b = host_b.clone();
        let cancel = cancel.clone();
        async move {
            let listener = WebSocketListener::from_streams(ws_rx, Vec::new()).unwrap();
            host_b.serve_remote(listener, cancel).await.unwrap();
        }
    });

    let observed = Arc::new(Mutex::new(Vec::<(PeerId, Option<PeerId>)>::new()));
    let forward_task = tokio::spawn({
        let observed = observed.clone();
        let cancel = cancel.clone();
        async move {
            loop {
                let incoming = tokio::select! {
                    biased;
                    () = cancel.cancelled() => break,
                    next = rx_b.recv() => match next {
                        Some(incoming) => incoming,
                        None => break,
                    },
                };
                observed
                    .lock()
                    .unwrap()
                    .push((incoming.remote_peer_id, incoming.via_relay));
                if ws_tx.send(Box::new(incoming.stream)).await.is_err() {
                    break;
                }
            }
        }
    });

    let transport: OpenChannel = Arc::new({
        let node_a = node_a.clone();
        let b_peer = b_peer.clone();
        move || {
            let node_a = node_a.clone();
            let b_peer = b_peer.clone();
            Box::pin(async move {
                let stream = node_a
                    .dial_direct(&b_peer, b_addr)
                    .await
                    .map_err(|err| io::Error::other(err.to_string()))?;
                Ok(Box::new(stream) as Channel)
            })
        }
    });

    let bearer: Arc<str> = pairing.credential.into();
    let client_id: Arc<str> = Uuid::new_v4().to_string().into();
    let opener = websocket::channel_opener(transport.clone(), bearer.clone());
    HostClient::finalize_access(opener, client_id.clone(), Some(epoch))
        .await
        .unwrap();

    let mut client = HostClient::connect_websocket(transport, bearer, client_id, Some(epoch))
        .await
        .unwrap();
    call_host_logs_read(&client).await;

    let seen = observed.lock().unwrap().clone();
    assert!(!seen.is_empty());
    assert!(seen.iter().all(|(peer, relay)| peer == id_a.peer_id() && relay.is_none()));

    client.close().await.unwrap();
    cancel.cancel();
    node_a.shutdown();
    node_b.shutdown();
    forward_task.await.unwrap();
    host_task.await.unwrap();
}

/// Real 3-node UDP QUIC `A -> C -> B` mesh transit + 250ms hedged failover:
/// - Fail-closed before roster installation
/// - Rejects unapproved peer D authenticated by QUIC RPK identity
/// - Rejects relay misrouting to rogue host E via cryptographic pinning
/// - Fails over past a live UDP blackhole in ~250ms to E2E-encrypted `A -> C -> B`
///   and completes real Bearer finalization + HostLogs::read RPC on Host B.
#[tokio::test]
async fn quic_hedged_dial_fails_over_via_e2e_encrypted_a_c_b_mesh_transit_and_enforces_policy() {
    let dir = TempDir::new().unwrap();
    let host_b = open_real_host(dir.path()).await;
    let pairing = host_b.prepare_access("quic-transit-a".into()).await.unwrap();
    let epoch = host_b.epoch();

    let owner = NodeIdentity::generate().unwrap();
    let id_a = NodeIdentity::generate().unwrap();
    let id_b = NodeIdentity::generate().unwrap();
    let id_c = NodeIdentity::generate().unwrap();
    let id_intruder = NodeIdentity::generate().unwrap();
    let id_rogue_e = NodeIdentity::generate().unwrap();

    let (node_a, _rx_a) = MeshTransportNode::bind(loopback_ephemeral(), id_a.clone(), None).unwrap();
    let (node_b, mut rx_b) = MeshTransportNode::bind(loopback_ephemeral(), id_b.clone(), None).unwrap();
    let (node_c, _rx_c) =
        MeshTransportNode::bind(loopback_ephemeral(), id_c.clone(), NonZeroUsize::new(4)).unwrap();
    let (node_intruder, _rx_d) =
        MeshTransportNode::bind(loopback_ephemeral(), id_intruder.clone(), None).unwrap();
    let (node_rogue_e, _rx_e) =
        MeshTransportNode::bind(loopback_ephemeral(), id_rogue_e.clone(), None).unwrap();
    let node_a = Arc::new(node_a);

    let denied_before_roster = node_a
        .dial_via_relay(node_c.peer_id(), node_c.local_addr(), node_b.peer_id())
        .await;
    assert!(
        matches!(denied_before_roster, Err(TransportError::RelayRejected(_))),
        "relay must reject transit before owner-signed roster is installed"
    );

    let mesh_id = MeshId::parse(format!("mesh_{}", "b".repeat(32))).unwrap();
    let now_ms = 1_700_000_000_000u64;
    let t0 = Instant::now();
    let roster = SignedPeerMeshRosterV1::sign(
        PeerMeshRosterV1::new(
            mesh_id.clone(),
            owner.peer_id().clone(),
            1,
            now_ms,
            vec![
                MeshMemberEntry::new(owner.peer_id().clone(), "Owner", MeshRole::Owner, true, false).unwrap(),
                MeshMemberEntry::new(id_a.peer_id().clone(), "Mac A", MeshRole::Member, false, false).unwrap(),
                MeshMemberEntry::new(id_b.peer_id().clone(), "Ubuntu B", MeshRole::Member, false, false).unwrap(),
                MeshMemberEntry::new(id_c.peer_id().clone(), "Relay C", MeshRole::RelayCapable, true, false).unwrap(),
            ],
        )
        .unwrap(),
        &owner,
    )
    .unwrap();
    node_c.set_transit_roster(roster.clone());
    node_c.set_peer_address(id_b.peer_id().clone(), node_b.local_addr());

    let denied_intruder = node_intruder
        .dial_via_relay(node_c.peer_id(), node_c.local_addr(), node_b.peer_id())
        .await;
    assert!(
        matches!(denied_intruder, Err(TransportError::RelayRejected(_))),
        "relay must reject unapproved source peer"
    );

    node_c.set_peer_address(id_b.peer_id().clone(), node_rogue_e.local_addr());
    let misrouted = node_a
        .dial_via_relay(node_c.peer_id(), node_c.local_addr(), node_b.peer_id())
        .await;
    assert!(
        misrouted.is_err(),
        "relay misrouting B to rogue E must fail peer identity pinning"
    );
    node_c.set_peer_address(id_b.peer_id().clone(), node_b.local_addr());

    let blackhole_udp = UdpSocket::bind(loopback_ephemeral()).unwrap();
    let blackhole_addr = blackhole_udp.local_addr().unwrap();

    let mut store = MeshStateStore::new(roster);
    store
        .apply_advertisement(
            signed_ad(
                &mesh_id,
                &id_b,
                host_b.root_id(),
                &blackhole_addr.to_string(),
                false,
                BTreeMap::new(),
                1,
                now_ms,
            ),
            now_ms,
            t0,
        )
        .unwrap();
    store
        .apply_advertisement(
            signed_ad(
                &mesh_id,
                &id_c,
                "relay-c-root",
                &node_c.local_addr().to_string(),
                true,
                BTreeMap::from([(id_b.peer_id().clone(), 8)]),
                1,
                now_ms,
            ),
            now_ms,
            t0,
        )
        .unwrap();

    let resolution = store.resolve_routes(
        id_a.peer_id(),
        id_b.peer_id(),
        &BTreeMap::from([(id_c.peer_id().clone(), 5)]),
        DEFAULT_HEDGE_DELAY,
        now_ms,
        t0,
    );

    let (ws_tx, ws_rx) = tokio::sync::mpsc::channel::<Channel>(16);
    let cancel = CancellationToken::new();
    let host_task = tokio::spawn({
        let host_b = host_b.clone();
        let cancel = cancel.clone();
        async move {
            let listener = WebSocketListener::from_streams(ws_rx, Vec::new()).unwrap();
            host_b.serve_remote(listener, cancel).await.unwrap();
        }
    });

    let observed = Arc::new(Mutex::new(Vec::<(PeerId, Option<PeerId>)>::new()));
    let forward_task = tokio::spawn({
        let observed = observed.clone();
        let cancel = cancel.clone();
        async move {
            loop {
                let incoming = tokio::select! {
                    biased;
                    () = cancel.cancelled() => break,
                    next = rx_b.recv() => match next {
                        Some(incoming) => incoming,
                        None => break,
                    },
                };
                observed
                    .lock()
                    .unwrap()
                    .push((incoming.remote_peer_id, incoming.via_relay));
                if ws_tx.send(Box::new(incoming.stream)).await.is_err() {
                    break;
                }
            }
        }
    });

    let winning_paths = Arc::new(Mutex::new(Vec::<(WinningPath, Duration)>::new()));
    let transport: OpenChannel = Arc::new({
        let node_a = node_a.clone();
        let resolution = resolution.clone();
        let winning_paths = winning_paths.clone();
        move || {
            let node_a = node_a.clone();
            let resolution = resolution.clone();
            let winning_paths = winning_paths.clone();
            Box::pin(async move {
                let started = Instant::now();
                let winner = node_a
                    .dial_resolved(&resolution)
                    .await
                    .map_err(|err| io::Error::other(err.to_string()))?;
                winning_paths
                    .lock()
                    .unwrap()
                    .push((winner.path, started.elapsed()));
                Ok(Box::new(winner.stream) as Channel)
            })
        }
    });

    let bearer: Arc<str> = pairing.credential.into();
    let client_id: Arc<str> = Uuid::new_v4().to_string().into();
    let opener = websocket::channel_opener(transport.clone(), bearer.clone());
    HostClient::finalize_access(opener, client_id.clone(), Some(epoch))
        .await
        .unwrap();

    let mut client = HostClient::connect_websocket(transport, bearer, client_id, Some(epoch))
        .await
        .unwrap();
    call_host_logs_read(&client).await;

    let wins = winning_paths.lock().unwrap().clone();
    assert!(!wins.is_empty());
    for (path, elapsed) in &wins {
        assert_eq!(
            path,
            &WinningPath::MeshTransit {
                relay_peer_id: id_c.peer_id().clone(),
                relay_endpoint: node_c.local_addr().to_string(),
            }
        );
        assert!(
            *elapsed >= Duration::from_millis(200) && *elapsed < Duration::from_secs(3),
            "expected 250ms hedged failover past UDP blackhole, took {elapsed:?}"
        );
    }
    let seen = observed.lock().unwrap().clone();
    assert!(!seen.is_empty());
    assert!(seen
        .iter()
        .all(|(origin, relay)| origin == id_a.peer_id() && relay.as_ref() == Some(id_c.peer_id())));

    client.close().await.unwrap();
    drop(blackhole_udp);
    cancel.cancel();
    node_a.shutdown();
    node_b.shutdown();
    node_c.shutdown();
    node_intruder.shutdown();
    node_rogue_e.shutdown();
    forward_task.await.unwrap();
    host_task.await.unwrap();

    tokio::time::timeout(Duration::from_secs(2), async {
        while node_c.active_transit_circuits() != 0 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

/// Real mid-session carrier upgrade over live UDP QUIC: starts a Host RPC
/// session over direct QUIC `A -> B`, then hot-swaps the live ResumablePeerStream
/// onto an E2E-encrypted QUIC `A -> C -> B` transit circuit and completes a
/// second HostLogs::read RPC on the exact same Host WebSocket session.
#[tokio::test]
async fn quic_resumable_session_upgrades_live_from_direct_to_e2e_a_c_b_transit() {
    let dir = TempDir::new().unwrap();
    let host_b = open_real_host(dir.path()).await;
    let pairing = host_b.prepare_access("quic-upgrade-a".into()).await.unwrap();
    let epoch = host_b.epoch();

    let owner = NodeIdentity::generate().unwrap();
    let id_a = NodeIdentity::generate().unwrap();
    let id_b = NodeIdentity::generate().unwrap();
    let id_c = NodeIdentity::generate().unwrap();

    let (node_a, _rx_a) = MeshTransportNode::bind(loopback_ephemeral(), id_a.clone(), None).unwrap();
    let (node_b, rx_b) = MeshTransportNode::bind(loopback_ephemeral(), id_b.clone(), None).unwrap();
    let (node_c, _rx_c) = MeshTransportNode::bind(loopback_ephemeral(), id_c.clone(), None).unwrap();
    let node_a = Arc::new(node_a);
    let b_addr = node_b.local_addr();
    let b_peer = id_b.peer_id().clone();

    let mesh_id = MeshId::parse(format!("mesh_{}", "c".repeat(32))).unwrap();
    let roster = SignedPeerMeshRosterV1::sign(
        PeerMeshRosterV1::new(
            mesh_id,
            owner.peer_id().clone(),
            1,
            1_700_000_000_000,
            vec![
                MeshMemberEntry::new(owner.peer_id().clone(), "Owner", MeshRole::Owner, true, false).unwrap(),
                MeshMemberEntry::new(id_a.peer_id().clone(), "Mac A", MeshRole::Member, false, false).unwrap(),
                MeshMemberEntry::new(id_b.peer_id().clone(), "Ubuntu B", MeshRole::Member, false, false).unwrap(),
                MeshMemberEntry::new(id_c.peer_id().clone(), "Relay C", MeshRole::RelayCapable, true, false).unwrap(),
            ],
        )
        .unwrap(),
        &owner,
    )
    .unwrap();
    node_c.set_transit_roster(roster);
    node_c.set_peer_address(b_peer.clone(), b_addr);

    let (ws_tx, ws_rx) = tokio::sync::mpsc::channel::<Channel>(16);
    let cancel = CancellationToken::new();
    let host_task = tokio::spawn({
        let host_b = host_b.clone();
        let cancel = cancel.clone();
        async move {
            let listener = WebSocketListener::from_streams(ws_rx, Vec::new()).unwrap();
            host_b.serve_remote(listener, cancel).await.unwrap();
        }
    });

    let rx_b = Arc::new(tokio::sync::Mutex::new(rx_b));
    let use_transit = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let controls = Arc::new(Mutex::new(Vec::<(
        maka_peer::ResumableStreamControl,
        maka_peer::ResumableStreamControl,
    )>::new()));
    let c_peer = id_c.peer_id().clone();
    let c_addr = node_c.local_addr();

    let session_transport: OpenChannel = Arc::new({
        let node_a = node_a.clone();
        let b_peer = b_peer.clone();
        let c_peer = c_peer.clone();
        let rx_b = rx_b.clone();
        let ws_tx = ws_tx.clone();
        let use_transit = use_transit.clone();
        let controls = controls.clone();
        let id_a_peer = id_a.peer_id().clone();
        move || {
            let node_a = node_a.clone();
            let b_peer = b_peer.clone();
            let c_peer = c_peer.clone();
            let rx_b = rx_b.clone();
            let ws_tx = ws_tx.clone();
            let use_transit = use_transit.clone();
            let controls = controls.clone();
            let id_a_peer = id_a_peer.clone();
            Box::pin(async move {
                let transit_mode = use_transit.load(std::sync::atomic::Ordering::Acquire);
                let carrier_a = if transit_mode {
                    node_a
                        .dial_via_relay(&c_peer, c_addr, &b_peer)
                        .await
                        .map_err(|err| io::Error::other(err.to_string()))?
                } else {
                    node_a
                        .dial_direct(&b_peer, b_addr)
                        .await
                        .map_err(|err| io::Error::other(err.to_string()))?
                };
                let incoming_b = rx_b
                    .lock()
                    .await
                    .recv()
                    .await
                    .ok_or_else(|| io::Error::other("node B receiver closed"))?;
                assert_eq!(incoming_b.remote_peer_id, id_a_peer);
                if transit_mode {
                    assert_eq!(incoming_b.via_relay.as_ref(), Some(&c_peer));
                } else {
                    assert_eq!(incoming_b.via_relay, None);
                }
                let stream_id = Uuid::new_v4();
                let (resumable_a, ctrl_a) = ResumablePeerStream::new(stream_id, Box::new(carrier_a));
                let (resumable_b, ctrl_b) =
                    ResumablePeerStream::new(stream_id, Box::new(incoming_b.stream));
                controls.lock().unwrap().push((ctrl_a, ctrl_b));
                ws_tx
                    .send(Box::new(resumable_b))
                    .await
                    .map_err(|_| io::Error::other("Host B ingress closed"))?;
                Ok(Box::new(resumable_a) as Channel)
            })
        }
    });

    let bearer: Arc<str> = pairing.credential.into();
    let client_id: Arc<str> = Uuid::new_v4().to_string().into();
    let opener = websocket::channel_opener(session_transport.clone(), bearer.clone());
    HostClient::finalize_access(opener, client_id.clone(), Some(epoch))
        .await
        .unwrap();

    // Phase 1: Establish live HostClient session and execute RPC #1 over direct QUIC A -> B.
    let mut client = HostClient::connect_websocket(session_transport, bearer, client_id, Some(epoch))
        .await
        .unwrap();
    call_host_logs_read(&client).await;

    // Phase 2: Hot-swap the live persistent ResumablePeerStream control carrier
    // mid-session onto E2E-encrypted QUIC A -> C -> B, asserting both endpoints
    // accept the replacement and that RPC #2 traverses Relay C actively.
    use_transit.store(true, std::sync::atomic::Ordering::Release);
    let active_controls = controls.lock().unwrap().clone();
    assert!(!active_controls.is_empty());
    let mut upgraded_count = 0usize;
    for (ctrl_a, ctrl_b) in active_controls {
        let transit_a = node_a
            .dial_via_relay(&c_peer, c_addr, &b_peer)
            .await
            .unwrap();
        let transit_b = rx_b.lock().await.recv().await.unwrap();
        assert_eq!(&transit_b.remote_peer_id, id_a.peer_id());
        assert_eq!(transit_b.via_relay.as_ref(), Some(&c_peer));
        match (
            ctrl_a.replace_carrier(Box::new(transit_a)).await,
            ctrl_b.replace_carrier(Box::new(transit_b.stream)).await,
        ) {
            (Ok(()), Ok(())) => upgraded_count += 1,
            (Err(_), Err(_)) => {
                // Short-lived finalize/call stream already closed before upgrade.
            }
            (res_a, res_b) => panic!(
                "asymmetric carrier replacement on live stream: a={res_a:?}, b={res_b:?}"
            ),
        }
    }
    assert!(
        upgraded_count >= 1,
        "at least one live persistent session channel must successfully hot-swap onto A -> C -> B"
    );
    assert!(
        node_c.active_transit_circuits() >= 1,
        "Relay C must hold an active transit circuit for the upgraded live session"
    );

    // RPC #2 succeeds on the exact same HostClient session after upgrading to A -> C -> B!
    call_host_logs_read(&client).await;

    client.close().await.unwrap();
    cancel.cancel();
    node_a.shutdown();
    node_b.shutdown();
    node_c.shutdown();
    host_task.await.unwrap();
}

/// Adversarial relay MITM test: a malicious relay M returns RELAY_STATUS_OK to
/// client A (bypassing honest relay outer QUIC pinning) and pipes raw bytes
/// straight to rogue host E running accept_e2e_tls with E's Ed25519 key.
/// Client A's inner RFC 7250 E2E TLS 1.3 handshake MUST reject rogue E with
/// TransportError::Tls(_) so zero application bytes leak.
#[tokio::test]
async fn malicious_relay_piping_to_rogue_host_is_defeated_by_inner_e2e_tls_pinning() {
    use maka_peer::tls::{accept_e2e_tls, build_peer_server_config};
    use quinn::{Endpoint, ServerConfig as QuinnServerConfig, crypto::rustls::QuicServerConfig};
    use tokio::io::AsyncWriteExt;

    let id_a = NodeIdentity::generate().unwrap();
    let id_expected_b = NodeIdentity::generate().unwrap();
    let id_malicious_relay = NodeIdentity::generate().unwrap();
    let id_rogue_e = NodeIdentity::generate().unwrap();

    let tls_m = build_peer_server_config(
        &id_malicious_relay,
        None,
        vec![maka_peer_mesh::MESH_QUIC_ALPN.to_vec()],
    )
    .unwrap();
    let server_m = QuinnServerConfig::with_crypto(Arc::new(
        QuicServerConfig::try_from(tls_m).unwrap(),
    ));
    let endpoint_m = Endpoint::server(server_m, loopback_ephemeral()).unwrap();
    let addr_m = endpoint_m.local_addr().unwrap();

    let rogue_task = tokio::spawn({
        let id_rogue_e = id_rogue_e.clone();
        async move {
            let conn = endpoint_m.accept().await.unwrap().await.unwrap();
            let (mut send, mut recv) = conn.accept_bi().await.unwrap();
            let mut prefix = [0u8; 7];
            recv.read_exact(&mut prefix).await.unwrap();
            assert_eq!(&prefix[..4], b"MKM1");
            assert_eq!(prefix[4], 0x02); // INTENT_TRANSIT_REQUEST
            let target_len = usize::from(u16::from_be_bytes([prefix[5], prefix[6]]));
            let mut target_buf = vec![0u8; target_len];
            recv.read_exact(&mut target_buf).await.unwrap();

            // Malicious relay sends RELAY_STATUS_OK and impersonates target B with rogue E's key!
            send.write_all(&[0x01]).await.unwrap();
            send.flush().await.unwrap();

            struct RawBi(quinn::SendStream, quinn::RecvStream);
            impl tokio::io::AsyncRead for RawBi {
                fn poll_read(
                    mut self: std::pin::Pin<&mut Self>,
                    cx: &mut std::task::Context<'_>,
                    buf: &mut tokio::io::ReadBuf<'_>,
                ) -> std::task::Poll<io::Result<()>> {
                    std::pin::Pin::new(&mut self.1).poll_read(cx, buf)
                }
            }
            impl tokio::io::AsyncWrite for RawBi {
                fn poll_write(
                    mut self: std::pin::Pin<&mut Self>,
                    cx: &mut std::task::Context<'_>,
                    buf: &[u8],
                ) -> std::task::Poll<io::Result<usize>> {
                    tokio::io::AsyncWrite::poll_write(std::pin::Pin::new(&mut self.0), cx, buf)
                }
                fn poll_flush(
                    mut self: std::pin::Pin<&mut Self>,
                    cx: &mut std::task::Context<'_>,
                ) -> std::task::Poll<io::Result<()>> {
                    std::pin::Pin::new(&mut self.0).poll_flush(cx)
                }
                fn poll_shutdown(
                    mut self: std::pin::Pin<&mut Self>,
                    cx: &mut std::task::Context<'_>,
                ) -> std::task::Poll<io::Result<()>> {
                    std::pin::Pin::new(&mut self.0).poll_shutdown(cx)
                }
            }
            let rogue_accept = accept_e2e_tls(RawBi(send, recv), &id_rogue_e).await;
            endpoint_m.close(0u32.into(), b"done");
            rogue_accept
        }
    });

    let (node_a, _rx_a) = MeshTransportNode::bind(loopback_ephemeral(), id_a, None).unwrap();
    let result = node_a
        .dial_via_relay(
            id_malicious_relay.peer_id(),
            addr_m,
            id_expected_b.peer_id(),
        )
        .await;
    let err = match result {
        Ok(_) => panic!("malicious relay piping to rogue host E must fail E2E TLS pinning"),
        Err(err) => err,
    };
    assert!(
        matches!(err, TransportError::Tls(_)),
        "inner E2E TLS 1.3 RPK verification must reject rogue host E behind malicious relay, got: {err:?}"
    );
    let rogue_result = rogue_task.await.unwrap();
    assert!(
        rogue_result.is_err(),
        "rogue host E must not complete an E2E TLS session with client A"
    );
    node_a.shutdown();
}
