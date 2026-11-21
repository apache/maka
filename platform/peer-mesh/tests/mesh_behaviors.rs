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
    PeerReachabilityLeaseV1, ResumablePeerStream, ResumableStreamControl,
    SignedPeerReachabilityLeaseV1,
};
use maka_peer_mesh::{
    DialStrategy, MeshError, MeshId, MeshMemberEntry, MeshRole, MeshStateStore,
    PeerMeshMemberAdvertisementV1, PeerMeshRosterV1, SignedPeerMeshMemberAdvertisementV1,
    SignedPeerMeshRosterV1, TransitError, TransitPolicy, WinningPath, bridge_transit_streams,
    hedged_dial,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io,
    num::NonZeroUsize,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

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

/// Real Host-to-Host failover: when direct `A -> B` stalls (NAT blackhole),
/// `hedged_dial` races approved Mesh Relay C (`A -> C -> B`), Relay C enforces
/// `TransitPolicy::admit_circuit` + `bridge_transit_streams`, and Node A runs
/// real Bearer auth + real `HostLogs::read` RPC on Host B through Relay C.
#[tokio::test]
async fn real_host_a_to_b_fails_over_via_hedged_dial_through_approved_mesh_relay_c() {
    let dir = TempDir::new().unwrap();
    let host_b = open_real_host(dir.path()).await;
    let pairing = host_b.prepare_access("mesh-node-a".into()).await.unwrap();
    let epoch = host_b.epoch();

    let node_a = NodeIdentity::generate().unwrap();
    let node_b = NodeIdentity::generate().unwrap();
    let relay_c = NodeIdentity::generate().unwrap();
    let intruder = NodeIdentity::generate().unwrap();
    let mesh_id = MeshId::parse(format!("mesh_{}", "a".repeat(32))).unwrap();
    let now_ms = 1_700_000_000_000u64;
    let t0 = Instant::now();

    let roster = SignedPeerMeshRosterV1::sign(
        PeerMeshRosterV1::new(
            mesh_id.clone(),
            node_a.peer_id().clone(),
            1,
            now_ms,
            vec![
                MeshMemberEntry::new(node_a.peer_id().clone(), "MacBook A", MeshRole::Owner, false, false).unwrap(),
                MeshMemberEntry::new(node_b.peer_id().clone(), "Ubuntu B", MeshRole::Member, false, false).unwrap(),
                MeshMemberEntry::new(relay_c.peer_id().clone(), "Relay C", MeshRole::RelayCapable, true, false).unwrap(),
            ],
        )
        .unwrap(),
        &node_a,
    )
    .unwrap();
    let mut store = MeshStateStore::new(roster.clone());
    store
        .apply_advertisement(
            signed_ad(&mesh_id, &node_b, &pairing.root_id, "203.0.113.20:9443", false, BTreeMap::new(), 1, now_ms),
            now_ms,
            t0,
        )
        .unwrap();
    store
        .apply_advertisement(
            signed_ad(&mesh_id, &relay_c, &"c".repeat(64), "198.51.100.10:9443", true, BTreeMap::new(), 1, now_ms),
            now_ms,
            t0,
        )
        .unwrap();

    let relay_policy = TransitPolicy::new(relay_c.peer_id().clone(), NonZeroUsize::new(8));
    // Intruder source is rejected fail-closed at Relay C.
    assert!(matches!(
        relay_policy.admit_circuit(&roster, intruder.peer_id(), node_b.peer_id()),
        Err(TransitError::SourceNotAuthorized(_))
    ));

    let (b_ingress_tx, b_ingress_rx) = tokio::sync::mpsc::channel::<Channel>(16);
    let websocket = WebSocketListener::from_streams(b_ingress_rx, vec![]).unwrap();
    let stop = CancellationToken::new();
    let server_b = tokio::spawn({
        let stop = stop.clone();
        async move { host_b.serve_remote(websocket, stop).await }
    });

    let resolution = store.resolve_routes(
        node_a.peer_id(),
        node_b.peer_id(),
        &BTreeMap::new(),
        Duration::from_millis(50),
        now_ms,
        t0,
    );
    assert!(matches!(
        resolution.strategy,
        DialStrategy::HedgedDirectThenTransit { .. }
    ));

    let transit_wins = Arc::new(Mutex::new(Vec::<WinningPath>::new()));
    let transport: OpenChannel = Arc::new({
        let resolution = resolution.clone();
        let roster = roster.clone();
        let relay_policy = relay_policy.clone();
        let a_id = node_a.peer_id().clone();
        let b_id = node_b.peer_id().clone();
        let b_tx = b_ingress_tx.clone();
        let transit_wins = transit_wins.clone();
        move || {
            let resolution = resolution.clone();
            let roster = roster.clone();
            let relay_policy = relay_policy.clone();
            let a_id = a_id.clone();
            let b_id = b_id.clone();
            let b_tx = b_tx.clone();
            let transit_wins = transit_wins.clone();
            Box::pin(async move {
                let winner = hedged_dial(
                    &resolution,
                    |_direct| async {
                        // Direct A -> B stalls (NAT blackhole).
                        std::future::pending::<Result<Channel, String>>().await
                    },
                    move |_transit, _ep| {
                        let roster = roster.clone();
                        let relay_policy = relay_policy.clone();
                        let a_id = a_id.clone();
                        let b_id = b_id.clone();
                        let b_tx = b_tx.clone();
                        async move {
                            let guard = relay_policy
                                .admit_circuit(&roster, &a_id, &b_id)
                                .map_err(|e| e.to_string())?;
                            let (a_io, c_from_a) = tokio::io::duplex(64 * 1024);
                            let (c_to_b, b_io) = tokio::io::duplex(64 * 1024);
                            b_tx.send(Box::new(b_io) as Channel)
                                .await
                                .map_err(|_| "Host B ingress closed".to_owned())?;
                            tokio::spawn(async move {
                                let _ = bridge_transit_streams(c_from_a, c_to_b, guard).await;
                            });
                            Ok(Box::new(a_io) as Channel)
                        }
                    },
                )
                .await
                .map_err(|e| io::Error::other(e.to_string()))?;
                transit_wins.lock().unwrap().push(winner.path);
                Ok(winner.stream)
            })
        }
    });

    let bearer: Arc<str> = pairing.credential.into();
    let client_id: Arc<str> = Uuid::new_v4().to_string().into();
    let opener = websocket::channel_opener(transport.clone(), bearer.clone());
    HostClient::finalize_access(opener, client_id.clone(), None)
        .await
        .unwrap();

    let mut client = HostClient::connect_websocket(transport, bearer, client_id, None)
        .await
        .unwrap();
    assert_eq!(client.epoch(), epoch);
    assert_eq!(client.source().state_domain, pairing.root_id);
    assert!(relay_policy.active_circuits() >= 1);

    // Real HostLogs::read RPC traverses A -> Relay C -> Host B.
    call_host_logs_read(&client).await;

    let wins = transit_wins.lock().unwrap().clone();
    assert!(!wins.is_empty());
    assert!(wins.iter().all(|path| matches!(
        path,
        WinningPath::MeshTransit { relay_peer_id, .. } if relay_peer_id == relay_c.peer_id()
    )));

    client.close().await.unwrap();
    drop(client);
    drop(b_ingress_tx);
    stop.cancel();
    tokio::time::timeout(Duration::from_secs(5), server_b)
        .await
        .expect("Host B must drain cleanly after relayed channels close")
        .unwrap()
        .unwrap();
    // All TransitCircuitGuards released once bridged streams terminate.
    tokio::time::timeout(Duration::from_secs(2), async {
        while relay_policy.active_circuits() > 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("all transit circuits must release on disconnect");
}

/// Live path quality upgrade: Node A starts connected to real Host B directly
/// over `ResumablePeerStream`, detects degraded direct RTT (420ms) vs faster
/// `A -> C_fast -> B` (40ms), switches carrier mid-session to relayed `C_fast`
/// without dropping the live `HostClient`, and verifies revocation evicts `C_fast`.
#[tokio::test]
async fn real_host_resumable_session_upgrades_from_degraded_direct_to_faster_a_c_b_transit() {
    let dir = TempDir::new().unwrap();
    let host_b = open_real_host(dir.path()).await;
    let pairing = host_b.prepare_access("mesh-upgrade-a".into()).await.unwrap();

    let node_a = NodeIdentity::generate().unwrap();
    let node_b = NodeIdentity::generate().unwrap();
    let relay_c_fast = NodeIdentity::generate().unwrap();
    let relay_c_slow = NodeIdentity::generate().unwrap();
    let mesh_id = MeshId::parse(format!("mesh_{}", "b".repeat(32))).unwrap();
    let now_ms = 1_700_000_000_000u64;
    let t0 = Instant::now();

    let roster_v1 = SignedPeerMeshRosterV1::sign(
        PeerMeshRosterV1::new(
            mesh_id.clone(),
            node_a.peer_id().clone(),
            1,
            now_ms,
            vec![
                MeshMemberEntry::new(node_a.peer_id().clone(), "MacBook A", MeshRole::Owner, false, false).unwrap(),
                MeshMemberEntry::new(node_b.peer_id().clone(), "Ubuntu B", MeshRole::Member, false, false).unwrap(),
                MeshMemberEntry::new(relay_c_fast.peer_id().clone(), "Relay C-Fast", MeshRole::RelayCapable, true, false).unwrap(),
                MeshMemberEntry::new(relay_c_slow.peer_id().clone(), "Relay C-Slow", MeshRole::RelayCapable, true, false).unwrap(),
            ],
        )
        .unwrap(),
        &node_a,
    )
    .unwrap();
    let mut store = MeshStateStore::new(roster_v1.clone());
    store
        .apply_advertisement(
            signed_ad(&mesh_id, &node_b, &pairing.root_id, "203.0.113.20:9443", false, BTreeMap::new(), 1, now_ms),
            now_ms,
            t0,
        )
        .unwrap();
    store
        .apply_advertisement(
            signed_ad(
                &mesh_id,
                &relay_c_fast,
                &"c".repeat(64),
                "198.51.100.10:9443",
                true,
                BTreeMap::from([(node_b.peer_id().clone(), 18)]),
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
                &relay_c_slow,
                &"d".repeat(64),
                "198.51.100.20:9443",
                true,
                BTreeMap::from([(node_b.peer_id().clone(), 90)]),
                1,
                now_ms,
            ),
            now_ms,
            t0,
        )
        .unwrap();

    let (b_ingress_tx, b_ingress_rx) = tokio::sync::mpsc::channel::<Channel>(16);
    let websocket = WebSocketListener::from_streams(b_ingress_rx, vec![]).unwrap();
    let stop = CancellationToken::new();
    let server_b = tokio::spawn({
        let stop = stop.clone();
        async move { host_b.serve_remote(websocket, stop).await }
    });

    // Start connected directly A -> B over ResumablePeerStream.
    let controls: Arc<Mutex<Vec<(ResumableStreamControl, ResumableStreamControl)>>> =
        Arc::new(Mutex::new(Vec::new()));
    let transport: OpenChannel = Arc::new({
        let b_tx = b_ingress_tx.clone();
        let controls = controls.clone();
        move || {
            let b_tx = b_tx.clone();
            let controls = controls.clone();
            Box::pin(async move {
                let stream_id = Uuid::new_v4();
                let (direct_a, direct_b) = tokio::io::duplex(64 * 1024);
                let (stream_a, ctrl_a) = ResumablePeerStream::new(stream_id, Box::new(direct_a));
                let (stream_b, ctrl_b) = ResumablePeerStream::new(stream_id, Box::new(direct_b));
                controls.lock().unwrap().push((ctrl_a, ctrl_b));
                b_tx.send(Box::new(stream_b) as Channel)
                    .await
                    .map_err(|_| io::Error::other("Host B ingress closed"))?;
                Ok(Box::new(stream_a) as Channel)
            })
        }
    });

    let bearer: Arc<str> = pairing.credential.into();
    let client_id: Arc<str> = Uuid::new_v4().to_string().into();
    let opener = websocket::channel_opener(transport.clone(), bearer.clone());
    HostClient::finalize_access(opener, client_id.clone(), None)
        .await
        .unwrap();
    let mut client = HostClient::connect_websocket(transport, bearer, client_id, None)
        .await
        .unwrap();
    call_host_logs_read(&client).await;

    // Direct RTT degrades (420ms) while A->C_fast->B is 22+18 = 40ms.
    let rtt = BTreeMap::from([
        (node_b.peer_id().clone(), 420),
        (relay_c_fast.peer_id().clone(), 22),
        (relay_c_slow.peer_id().clone(), 40),
    ]);
    let resolution = store.resolve_routes(
        node_a.peer_id(),
        node_b.peer_id(),
        &rtt,
        Duration::from_millis(250),
        now_ms,
        t0,
    );
    assert!(matches!(
        resolution.strategy,
        DialStrategy::PreferTransitWithDirectFallback { .. }
    ));
    assert_eq!(resolution.transit_candidates[0].relay_peer_id, *relay_c_fast.peer_id());
    assert_eq!(resolution.transit_candidates[0].estimated_rtt_ms, Some(40));

    // Dial A -> C_fast -> B through Relay C_fast's TransitPolicy and switch live carrier mid-session.
    let policy_fast = TransitPolicy::new(relay_c_fast.peer_id().clone(), None);
    let active_controls = controls.lock().unwrap().clone();
    for (ctrl_a, ctrl_b) in active_controls {
        let winner = hedged_dial(
            &resolution,
            |_direct| async { Err::<(tokio::io::DuplexStream, tokio::io::DuplexStream), _>("degraded".into()) },
            |transit, _ep| {
                let policy_fast = policy_fast.clone();
                let roster_v1 = roster_v1.clone();
                let a_id = node_a.peer_id().clone();
                let b_id = node_b.peer_id().clone();
                let c_fast_id = relay_c_fast.peer_id().clone();
                async move {
                    assert_eq!(transit.relay_peer_id, c_fast_id);
                    let guard = policy_fast
                        .admit_circuit(&roster_v1, &a_id, &b_id)
                        .map_err(|e| e.to_string())?;
                    let (a_carrier, c_from_a) = tokio::io::duplex(64 * 1024);
                    let (c_to_b, b_carrier) = tokio::io::duplex(64 * 1024);
                    tokio::spawn(async move {
                        let _ = bridge_transit_streams(c_from_a, c_to_b, guard).await;
                    });
                    Ok((a_carrier, b_carrier))
                }
            },
        )
        .await
        .unwrap();
        assert!(matches!(
            winner.path,
            WinningPath::MeshTransit { relay_peer_id, .. } if relay_peer_id == *relay_c_fast.peer_id()
        ));
        let (a_carrier, b_carrier) = winner.stream;
        let _ = ctrl_a.replace_carrier(Box::new(a_carrier)).await;
        let _ = ctrl_b.replace_carrier(Box::new(b_carrier)).await;
    }

    // Second real HostLogs::read RPC succeeds on the upgraded A -> C_fast -> B carrier.
    call_host_logs_read(&client).await;

    // Owner revokes C_fast -> immediately evicted from MeshStateStore and blocked by TransitPolicy.
    let roster_v2 = SignedPeerMeshRosterV1::sign(
        PeerMeshRosterV1::new(
            mesh_id.clone(),
            node_a.peer_id().clone(),
            2,
            now_ms + 1_000,
            vec![
                MeshMemberEntry::new(node_a.peer_id().clone(), "MacBook A", MeshRole::Owner, false, false).unwrap(),
                MeshMemberEntry::new(node_b.peer_id().clone(), "Ubuntu B", MeshRole::Member, false, false).unwrap(),
                MeshMemberEntry::new(relay_c_fast.peer_id().clone(), "Relay C-Fast", MeshRole::RelayCapable, true, true).unwrap(),
                MeshMemberEntry::new(relay_c_slow.peer_id().clone(), "Relay C-Slow", MeshRole::RelayCapable, true, false).unwrap(),
            ],
        )
        .unwrap(),
        &node_a,
    )
    .unwrap();
    store.apply_roster(roster_v2.clone(), now_ms + 1_000).unwrap();
    assert!(matches!(
        policy_fast.admit_circuit(&roster_v2, node_a.peer_id(), node_b.peer_id()),
        Err(TransitError::RelayNotAuthorized(_))
    ));
    assert!(matches!(
        store.apply_advertisement(
            signed_ad(&mesh_id, &relay_c_fast, &"c".repeat(64), "198.51.100.10:9443", true, BTreeMap::new(), 2, now_ms + 1_000),
            now_ms + 1_000,
            t0,
        ),
        Err(MeshError::UnauthorizedMember(_, _))
    ));
    let after_revoke = store.resolve_routes(
        node_a.peer_id(),
        node_b.peer_id(),
        &rtt,
        Duration::from_millis(250),
        now_ms + 1_000,
        t0,
    );
    assert_eq!(after_revoke.transit_candidates.len(), 1);
    assert_eq!(after_revoke.transit_candidates[0].relay_peer_id, *relay_c_slow.peer_id());

    client.close().await.unwrap();
    drop(client);
    drop(b_ingress_tx);
    stop.cancel();
    tokio::time::timeout(Duration::from_secs(5), server_b)
        .await
        .expect("Host B must drain cleanly")
        .unwrap()
        .unwrap();
}
