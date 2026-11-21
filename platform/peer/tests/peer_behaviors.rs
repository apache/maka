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
    DEFAULT_LEASE_TTL_MS, DirectRoute, DirectTransport, IdentityError, LeaseAcceptOutcome,
    LeaseError, LeaseReceiptStore, MAX_CLOCK_SKEW_MS, MAX_LEASE_LIFETIME_MS,
    MAX_RECOVERY_HORIZON_MS, NodeIdentity, PeerReachabilityLeaseV1, RelayRoute,
    ResumablePeerStream, ResumableStreamControl, SignedPeerReachabilityLeaseV1, UsableLease,
    verify_signature,
};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io,
    path::Path,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tempfile::TempDir;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
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

#[tokio::test]
async fn node_identity_converges_under_concurrency_and_blocks_key_substitution() {
    let temp = TempDir::new().unwrap();
    let key_path = temp.path().join("node-identity.json");

    let mut handles = Vec::new();
    for _ in 0..8 {
        let path = key_path.clone();
        handles.push(tokio::spawn(async move {
            NodeIdentity::load_or_create_async(path).await.unwrap()
        }));
    }
    let mut identities = Vec::new();
    for handle in handles {
        identities.push(handle.await.unwrap());
    }
    let created = &identities[0];
    for other in &identities[1..] {
        assert_eq!(created.peer_id(), other.peer_id());
    }

    let payload = b"reachability-binding-payload";
    let signature = created.sign_base64(payload);
    verify_signature(
        created.peer_id(),
        created.public_key_base64(),
        payload,
        &signature,
    )
    .unwrap();

    let attacker = NodeIdentity::generate().unwrap();
    let attacker_sig = attacker.sign_base64(payload);
    assert!(matches!(
        verify_signature(
            created.peer_id(),
            attacker.public_key_base64(),
            payload,
            &attacker_sig,
        ),
        Err(IdentityError::PeerIdMismatch { .. })
    ));
}

#[test]
fn reachability_lease_rotates_ip_enforces_monotonic_clock_and_rejects_tampering() {
    let node_b = NodeIdentity::generate().unwrap();
    let relay_c = NodeIdentity::generate().unwrap();
    let root_id = "a".repeat(64);
    let epoch = Uuid::from_u128(0xABCD);
    let now_ms = 1_700_000_000_000u64;
    let t0 = Instant::now();

    let lease_v1 = PeerReachabilityLeaseV1::new(
        root_id.clone(),
        node_b.peer_id().clone(),
        epoch,
        1,
        now_ms,
        now_ms + DEFAULT_LEASE_TTL_MS,
        vec![DirectRoute::new(DirectTransport::Quic, "192.168.1.10:9443", 10).unwrap()],
        vec![RelayRoute::new(
            relay_c.peer_id().clone(),
            vec!["wss://relay-c.example.com/mesh".into()],
            100,
        )
        .unwrap()],
    )
    .unwrap();
    let signed_v1 = SignedPeerReachabilityLeaseV1::sign(lease_v1, &node_b, now_ms).unwrap();

    // Tampered payload fails signature verification on deserialization.
    let mut tampered: Value = serde_json::to_value(&signed_v1).unwrap();
    tampered["lease"]["directRoutes"][0]["endpoint"] = json!("9.9.9.9:9443");
    assert!(serde_json::from_value::<SignedPeerReachabilityLeaseV1>(tampered).is_err());

    let mut store = LeaseReceiptStore::new();
    assert_eq!(
        store.accept_at(signed_v1.clone(), now_ms, t0).unwrap(),
        LeaseAcceptOutcome::Inserted
    );

    // Node B moves to a new network IP and publishes revision 2.
    let lease_v2 = PeerReachabilityLeaseV1::new(
        root_id.clone(),
        node_b.peer_id().clone(),
        epoch,
        2,
        now_ms + 5_000,
        now_ms + 5_000 + DEFAULT_LEASE_TTL_MS,
        vec![DirectRoute::new(DirectTransport::Quic, "10.0.0.42:9443", 10).unwrap()],
        vec![],
    )
    .unwrap();
    let signed_v2 = SignedPeerReachabilityLeaseV1::sign(lease_v2, &node_b, now_ms + 5_000).unwrap();
    let t_v2 = t0 + Duration::from_secs(5);
    assert_eq!(
        store.accept_at(signed_v2.clone(), now_ms + 5_000, t_v2).unwrap(),
        LeaseAcceptOutcome::Updated
    );

    // Replay of revision 1 is rejected.
    assert!(matches!(
        store.accept_at(signed_v1, now_ms + 5_000, t_v2),
        Err(LeaseError::RevisionRollback { current: 2, incoming: 1 })
    ));

    // Wall-clock rollback cannot extend an expired lease past its monotonic deadline.
    let monotonic_past_ttl = t_v2 + Duration::from_millis(DEFAULT_LEASE_TTL_MS + 1);
    assert!(matches!(
        store.resolve_usable_at(&root_id, node_b.peer_id(), now_ms, monotonic_past_ttl),
        Some(UsableLease::StaleRecovery(_))
    ));
    let monotonic_past_horizon =
        t_v2 + Duration::from_millis(DEFAULT_LEASE_TTL_MS + MAX_RECOVERY_HORIZON_MS + 1);
    assert!(
        store
            .resolve_usable_at(&root_id, node_b.peer_id(), now_ms, monotonic_past_horizon)
            .is_none()
    );

    // Self-relay, excessive lifetime, and future skew remain rejected.
    assert!(matches!(
        PeerReachabilityLeaseV1::new(
            root_id.clone(),
            node_b.peer_id().clone(),
            epoch,
            3,
            now_ms,
            now_ms + DEFAULT_LEASE_TTL_MS,
            vec![],
            vec![RelayRoute::new(node_b.peer_id().clone(), vec!["wss://self".into()], 1).unwrap()],
        ),
        Err(LeaseError::SelfRelay(_))
    ));
    assert!(matches!(
        PeerReachabilityLeaseV1::new(
            root_id.clone(),
            node_b.peer_id().clone(),
            epoch,
            3,
            now_ms,
            now_ms + MAX_LEASE_LIFETIME_MS + 1,
            vec![DirectRoute::new(DirectTransport::Quic, "10.0.0.1:9443", 1).unwrap()],
            vec![],
        ),
        Err(LeaseError::LifetimeTooLong { .. })
    ));
    let future = PeerReachabilityLeaseV1::new(
        root_id,
        node_b.peer_id().clone(),
        epoch,
        3,
        now_ms + MAX_CLOCK_SKEW_MS + 1,
        now_ms + MAX_CLOCK_SKEW_MS + 1 + DEFAULT_LEASE_TTL_MS,
        vec![DirectRoute::new(DirectTransport::Quic, "10.0.0.1:9443", 1).unwrap()],
        vec![],
    )
    .unwrap();
    assert!(matches!(
        SignedPeerReachabilityLeaseV1::sign(future, &node_b, now_ms),
        Err(LeaseError::IssuedInFuture { .. })
    ));
}

#[tokio::test]
async fn resumable_peer_stream_survives_full_duplex_fragmented_carrier_and_switchover() {
    let stream_id = Uuid::from_u128(0x9999_8888);
    let (proxy_a, intercept_a) = tokio::io::duplex(32 * 1024);
    let (intercept_b, proxy_b) = tokio::io::duplex(32 * 1024);

    let frag_task = tokio::spawn(async move {
        let (mut ra, mut wa) = tokio::io::split(intercept_a);
        let (mut rb, mut wb) = tokio::io::split(intercept_b);
        let a_to_b = async {
            let mut total = 0usize;
            let mut buf = [0u8; 5];
            while total < 8192 {
                let Ok(n) = ra.read(&mut buf).await else { break };
                if n == 0 { break; }
                if wb.write_all(&buf[..n]).await.is_err() { break; }
                total += n;
            }
            let mut sink = [0u8; 4096];
            let _ = ra.read(&mut sink).await;
        };
        let b_to_a = async {
            let mut total = 0usize;
            let mut buf = [0u8; 7];
            while total < 8192 {
                let Ok(n) = rb.read(&mut buf).await else { break };
                if n == 0 { break; }
                if wa.write_all(&buf[..n]).await.is_err() { break; }
                total += n;
            }
            let mut sink = [0u8; 4096];
            let _ = rb.read(&mut sink).await;
        };
        tokio::join!(a_to_b, b_to_a);
    });

    let (stream_a, control_a) = ResumablePeerStream::with_recovery_timeout(
        stream_id,
        Box::new(proxy_a),
        Duration::from_secs(5),
    );
    let (stream_b, control_b) = ResumablePeerStream::with_recovery_timeout(
        stream_id,
        Box::new(proxy_b),
        Duration::from_secs(5),
    );

    let payload_a: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let payload_b: Vec<u8> = (0..200_000u32).map(|i| ((i * 7 + 3) % 251) as u8).collect();
    let (mut ra, mut wa) = tokio::io::split(stream_a);
    let (mut rb, mut wb) = tokio::io::split(stream_b);

    let pa = payload_a.clone();
    let pb = payload_b.clone();
    let write_a = tokio::spawn(async move {
        wa.write_all(&pa).await.unwrap();
        wa.shutdown().await.unwrap();
    });
    let write_b = tokio::spawn(async move {
        wb.write_all(&pb).await.unwrap();
        wb.shutdown().await.unwrap();
    });
    let read_a = tokio::spawn(async move {
        let mut out = Vec::new();
        ra.read_to_end(&mut out).await.unwrap();
        out
    });
    let read_b = tokio::spawn(async move {
        let mut out = Vec::new();
        rb.read_to_end(&mut out).await.unwrap();
        out
    });

    frag_task.await.unwrap();
    let (c2_a, c2_b) = tokio::io::duplex(32 * 1024);
    control_a.replace_carrier(Box::new(c2_a)).await.unwrap();
    control_b.replace_carrier(Box::new(c2_b)).await.unwrap();

    let (got_a, got_b) = tokio::time::timeout(Duration::from_secs(5), async {
        write_a.await.unwrap();
        write_b.await.unwrap();
        (read_a.await.unwrap(), read_b.await.unwrap())
    })
    .await
    .expect("full-duplex switchover must finish without deadlock");
    assert_eq!(got_a, payload_b);
    assert_eq!(got_b, payload_a);
}

#[tokio::test]
async fn resumable_peer_stream_surfaces_timeout_and_protocol_errors_instead_of_eof() {
    let (c_a, c_b) = tokio::io::duplex(4096);
    drop(c_b);
    let (mut stream_a, _control_a) = ResumablePeerStream::with_recovery_timeout(
        Uuid::from_u128(0xAA01),
        Box::new(c_a),
        Duration::from_millis(80),
    );
    let mut buf = [0u8; 16];
    let err = tokio::time::timeout(Duration::from_secs(2), stream_a.read(&mut buf))
        .await
        .expect("recovery timeout must fire promptly")
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::TimedOut);

    let (m_a, m_b) = tokio::io::duplex(4096);
    let (mut stream_x, _ctrl_x) = ResumablePeerStream::with_recovery_timeout(
        Uuid::from_u128(0xBB01),
        Box::new(m_a),
        Duration::from_secs(30),
    );
    let (_stream_y, _ctrl_y) = ResumablePeerStream::with_recovery_timeout(
        Uuid::from_u128(0xBB02),
        Box::new(m_b),
        Duration::from_secs(30),
    );
    let err = tokio::time::timeout(Duration::from_secs(2), stream_x.read(&mut buf))
        .await
        .expect("stream_id mismatch must abort immediately")
        .unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::InvalidData);
}

/// End-to-end integration test: a real Maka Host (`Host::serve_remote` +
/// `WebSocketListener::from_streams`) serving a real authenticated
/// `Client::connect_websocket` session over `ResumablePeerStream`, switching
/// physical carriers mid-session between two real `HostLogs::read` RPCs.
#[tokio::test]
async fn real_host_websocket_session_survives_resumable_carrier_switchover() {
    let dir = TempDir::new().unwrap();
    let host = open_real_host(dir.path()).await;
    let pairing = host.prepare_access("peer-test-client".into()).await.unwrap();
    let epoch = host.epoch();

    let (stream_tx, stream_rx) = tokio::sync::mpsc::channel::<Channel>(16);
    let websocket = WebSocketListener::from_streams(stream_rx, vec![]).unwrap();
    let stop = CancellationToken::new();
    let server = tokio::spawn({
        let stop = stop.clone();
        async move { host.serve_remote(websocket, stop).await }
    });

    let controls: Arc<Mutex<Vec<(ResumableStreamControl, ResumableStreamControl)>>> =
        Arc::new(Mutex::new(Vec::new()));
    let controls_for_opener = controls.clone();
    let tx_for_opener = stream_tx.clone();
    let transport: OpenChannel = Arc::new(move || {
        let tx = tx_for_opener.clone();
        let controls = controls_for_opener.clone();
        Box::pin(async move {
            let stream_id = Uuid::new_v4();
            let (c1_client, c1_server) = tokio::io::duplex(64 * 1024);
            let (client_stream, client_ctrl) = ResumablePeerStream::new(stream_id, Box::new(c1_client));
            let (server_stream, server_ctrl) = ResumablePeerStream::new(stream_id, Box::new(c1_server));
            controls.lock().unwrap().push((client_ctrl, server_ctrl));
            tx.send(Box::new(server_stream) as Channel)
                .await
                .map_err(|_| io::Error::other("host remote ingress closed"))?;
            Ok(Box::new(client_stream) as Channel)
        })
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

    // 1. Execute a real HostLogs::read RPC on carrier 1.
    call_host_logs_read(&client).await;

    // 2. Switch the live anchor WebSocket stream from carrier 1 to carrier 2.
    let active_controls = controls.lock().unwrap().clone();
    for (client_ctrl, server_ctrl) in active_controls {
        let (c2_client, c2_server) = tokio::io::duplex(64 * 1024);
        let _ = client_ctrl.replace_carrier(Box::new(c2_client)).await;
        let _ = server_ctrl.replace_carrier(Box::new(c2_server)).await;
    }

    // 3. Execute a second real HostLogs::read RPC on the same Client after carrier switchover.
    call_host_logs_read(&client).await;

    // 4. Close the Client cleanly over the switched anchor stream and verify Host drains.
    client.close().await.unwrap();
    drop(client);
    drop(stream_tx);
    stop.cancel();
    tokio::time::timeout(Duration::from_secs(5), server)
        .await
        .expect("real Host must drain cleanly after remote streams close")
        .unwrap()
        .unwrap();
}
