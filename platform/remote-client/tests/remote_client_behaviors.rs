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

#![cfg(not(target_os = "ios"))]

use futures_util::{SinkExt, StreamExt};
use maka_event_log::{
    ROOT_MIGRATIONS,
    root::{RootNamespaces, RootOwner, private_directory},
    root_store::RootStore,
};
use maka_host_runtime::{
    application::{
        host::{
            Configuration, Host, LifecycleMode, Options, Pairing, websocket::WebSocketListener,
        },
        logs,
        transport::GATEWAY,
    },
    ipc::LocalListener,
};
use maka_packages::Package;
use maka_remote_client::{
    MAX_CONTROL_FRAME_BYTES, MAX_WS_MESSAGE_BYTES, PairingTicketV1, RemoteCallEvent,
    RemoteClientError, RemoteHostClient, SavedHostProfile, SavedHostStore, tcp_endpoint_opener,
};
use serde_json::{Value, json};
use std::{collections::BTreeMap, net::SocketAddr, sync::Arc, time::Duration};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::{Message, protocol::WebSocketConfig};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

struct LiveTestHost {
    _dir: tempfile::TempDir,
    ws_addr: SocketAddr,
    pairing: Pairing,
    epoch: Uuid,
    stop: CancellationToken,
    server: JoinHandle<Result<(), String>>,
}

impl LiveTestHost {
    async fn start() -> Self {
        let dir = tempfile::tempdir().unwrap();
        private_directory(dir.path()).unwrap();
        let root = Arc::new(
            RootOwner::create(
                &dir.path().join("root"),
                &RootNamespaces {
                    ownership: dir.path().join("ownership"),
                    control: dir.path().join("control"),
                },
            )
            .unwrap(),
        );
        let store = Arc::new(RootStore::open(root, ROOT_MIGRATIONS).await.unwrap());
        let contract = logs::contract();
        let pkg = |id: &str, host: Value| {
            Package::new(BTreeMap::from([(
                "maka.extension.json".into(),
                serde_json::to_vec(&json!({
                    "schemaVersion": 1,
                    "id": id,
                    "application": { "host": host }
                }))
                .unwrap(),
            )]))
            .unwrap()
        };
        let logs_pkg = pkg(
            "test.logs",
            json!({
                "implementation": { "kind": "native", "implementation": logs::HOST_LOGS },
                "configuration": { "type": "object" },
                "imports": {},
                "exports": { "HostLogs": { "contract": contract, "availability": "required" } }
            }),
        );
        let gateway_pkg = pkg(
            "test.gateway",
            json!({
                "implementation": { "kind": "native", "implementation": GATEWAY },
                "configuration": { "type": "object" },
                "exports": {},
                "imports": { "hostLogs": { "contract": contract, "cardinality": { "kind": "one" } } }
            }),
        );
        let consumer = Uuid::new_v4();
        let deployment = Uuid::new_v4();
        store
            .commit_application(
                deployment,
                0,
                serde_json::from_value(json!({
                    "instances": {
                        "logs": {
                            "key": Uuid::new_v4(),
                            "package": { "source": "pinned", "package": logs_pkg.application_ref() },
                            "usePackage": "host"
                        },
                        "gateway": {
                            "key": consumer,
                            "package": { "source": "pinned", "package": gateway_pkg.application_ref() },
                            "usePackage": "host",
                            "bindings": {
                                "hostLogs": [{ "kind": "instance", "path": ["logs"], "export": "HostLogs" }]
                            }
                        }
                    }
                }))
                .unwrap(),
                vec![],
                vec![logs_pkg, gateway_pkg],
            )
            .await
            .unwrap();
        let configuration = Configuration::PublicHost {
            endpoints: serde_json::from_value(json!({
                "hostLogs": {
                    "consumer": [consumer],
                    "import": "hostLogs",
                    "grant": { "methods": ["read"], "recovery": false }
                }
            }))
            .unwrap(),
            native: Default::default(),
            product_methods: Default::default(),
        };
        let host = Host::open_with_options(
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
        .unwrap();
        let pairing = host
            .prepare_access("ios-remote-client".into())
            .await
            .unwrap();
        let epoch = host.epoch();
        #[cfg(unix)]
        let socket = dir.path().join("host.sock");
        #[cfg(windows)]
        let socket = std::path::PathBuf::from(format!(r"\\.\pipe\maka-rc-test-{}", Uuid::new_v4()));
        let local = LocalListener::bind(&socket).unwrap();
        let websocket = WebSocketListener::bind("127.0.0.1:0".parse().unwrap(), vec![])
            .await
            .unwrap();
        let ws_addr = websocket.local_addr().unwrap();
        let stop = CancellationToken::new();
        let server = tokio::spawn({
            let stop = stop.clone();
            async move { host.serve(local, Some(websocket), stop).await }
        });
        Self {
            _dir: dir,
            ws_addr,
            pairing,
            epoch,
            stop,
            server,
        }
    }

    async fn shutdown(self) {
        self.stop.cancel();
        let _ = tokio::time::timeout(Duration::from_secs(5), self.server).await;
    }
}

#[tokio::test]
async fn pairing_ticket_finalize_connect_admit_and_call_real_host_over_websocket() {
    let live = LiveTestHost::start().await;
    let endpoint_url = format!("ws://{}", live.ws_addr);
    let now_ms = 1_795_300_000_000u64;

    // 1. Encode & decode PairingTicketV1 URI, verify symmetric 6-digit SAS.
    let ticket = PairingTicketV1::new(
        live.pairing.root_id.clone(),
        "Mac Studio Live",
        "peer_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        vec![endpoint_url.clone()],
        live.pairing.credential.clone(),
        "nonce-ios-live-01",
        now_ms + 300_000,
    )
    .unwrap();
    let uri = ticket.encode_uri().unwrap();
    let decoded = PairingTicketV1::decode_uri(&uri, now_ms + 1_000).unwrap();
    let ios_peer_id = "peer_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    let sas = decoded.short_auth_code(ios_peer_id).unwrap();
    assert_eq!(sas.len(), 6);
    assert!(sas.bytes().all(|b| b.is_ascii_digit()));

    // 2. Finalize one-time pairing credential on live Host and save profile.
    let opener = tcp_endpoint_opener(&decoded.endpoints()[0]).unwrap();
    let client_id: Arc<str> = format!("ios-{}", Uuid::new_v4()).into();
    RemoteHostClient::finalize_access(opener.clone(), decoded.pairing_token(), &client_id)
        .await
        .expect("finalize_access must succeed against real Host");

    let store_dir = tempfile::tempdir().unwrap();
    let mut store = SavedHostStore::load_or_create(store_dir.path().join("hosts.json")).unwrap();
    let profile = SavedHostProfile::new(
        decoded.root_id(),
        decoded.host_name(),
        decoded.peer_id(),
        decoded.endpoints().to_vec(),
        live.pairing.credential_id.clone(),
        Some(now_ms + 2_000),
        false,
    )
    .unwrap();
    store.upsert_paired_host(profile.clone()).unwrap();
    assert_eq!(
        store.get(profile.root_id()).unwrap().root_id(),
        live.pairing.root_id
    );

    // 3. Connect and admit real Host with matching root_id.
    let bearer: Arc<str> = decoded.pairing_token().to_owned().into();
    let conn = RemoteHostClient::connect(opener, bearer, profile.root_id(), client_id)
        .await
        .expect("connect must admit matching real Host");
    assert_eq!(conn.epoch(), live.epoch);
    assert_eq!(conn.root_id(), live.pairing.root_id);
    assert!(conn.endpoint_names().contains(&"hostLogs".to_owned()));

    // 4. Execute a real RPC call on the admitted Host endpoint.
    let events = conn
        .call(
            "hostLogs",
            "read",
            json!({ "position": { "kind": "tail" } }),
        )
        .await
        .expect("real hostLogs.read call must succeed over WebSocket");
    assert!(
        matches!(events.last(), Some(RemoteCallEvent::Finished(_))),
        "expected terminal Finished event, got: {events:?}"
    );

    // 5. Detach cleanly without stopping the Host.
    conn.close()
        .await
        .expect("remote close must succeed cleanly");
    live.shutdown().await;
}

#[tokio::test]
async fn connect_rejects_mismatched_root_id_fail_closed() {
    let live = LiveTestHost::start().await;
    let opener = tcp_endpoint_opener(&format!("ws://{}", live.ws_addr)).unwrap();
    let client_id: Arc<str> = format!("ios-{}", Uuid::new_v4()).into();

    RemoteHostClient::finalize_access(opener.clone(), &live.pairing.credential, &client_id)
        .await
        .unwrap();

    let wrong_root = "0000000000000000000000000000000000000000000000000000000000000000";
    let err = RemoteHostClient::connect(
        opener,
        live.pairing.credential.clone().into(),
        wrong_root,
        client_id,
    )
    .await
    .err()
    .expect("mismatched root_id must fail closed");

    match err {
        RemoteClientError::RootIdMismatch { expected, actual } => {
            assert_eq!(expected, wrong_root);
            assert_eq!(actual, live.pairing.root_id);
        }
        other => panic!("expected RootIdMismatch, got {other:?}"),
    }

    live.shutdown().await;
}

#[tokio::test]
async fn connect_rejects_invalid_bearer_and_unsupported_endpoint_scheme() {
    let live = LiveTestHost::start().await;
    let opener = tcp_endpoint_opener(&format!("ws://{}", live.ws_addr)).unwrap();
    let err = RemoteHostClient::connect(
        opener,
        "definitely-not-a-valid-bearer".into(),
        &live.pairing.root_id,
        "ios-bad-auth".into(),
    )
    .await
    .err()
    .expect("invalid bearer must be rejected");
    assert!(
        matches!(err, RemoteClientError::AuthRejected(_)),
        "expected AuthRejected, got {err:?}"
    );

    let scheme_err = tcp_endpoint_opener("http://127.0.0.1:9000")
        .err()
        .expect("non-ws scheme must be rejected");
    assert!(matches!(
        scheme_err,
        RemoteClientError::InvalidEndpoint { .. }
    ));

    live.shutdown().await;
}

async fn spawn_raw_ws_responder(payloads: Vec<Vec<u8>>) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        let Ok((tcp, _)) = listener.accept().await else {
            return;
        };
        let mut cfg = WebSocketConfig::default();
        cfg.max_message_size = None;
        cfg.max_frame_size = None;
        let Ok(mut ws) = tokio_tungstenite::accept_async_with_config(tcp, Some(cfg)).await else {
            return;
        };
        // Consume the client's Opening binary frame first.
        let _ = ws.next().await;
        for chunk in payloads {
            if ws.send(Message::Binary(chunk.into())).await.is_err() {
                return;
            }
        }
        let _ = ws.close(None).await;
    });
    addr
}

#[tokio::test]
async fn rejects_oversized_websocket_message_before_unbounded_buffering() {
    let oversized = vec![0x41u8; MAX_WS_MESSAGE_BYTES + 1];
    let addr = spawn_raw_ws_responder(vec![oversized]).await;
    let opener = tcp_endpoint_opener(&format!("ws://{addr}")).unwrap();
    let err = RemoteHostClient::connect(
        opener,
        "dummy-token".into(),
        "root-any",
        "ios-oversized-test".into(),
    )
    .await
    .err()
    .expect("oversized WebSocket message must be rejected");
    assert!(
        matches!(err, RemoteClientError::Io(_)),
        "expected tungstenite capacity Io error, got {err:?}"
    );
}

#[tokio::test]
async fn rejects_invalid_frame_lengths_and_truncated_frames() {
    // 1. Zero-length frame prefix
    let addr_zero = spawn_raw_ws_responder(vec![0u32.to_be_bytes().to_vec()]).await;
    let err_zero = RemoteHostClient::connect(
        tcp_endpoint_opener(&format!("ws://{addr_zero}")).unwrap(),
        "dummy-token".into(),
        "root-any",
        "ios-zero-len".into(),
    )
    .await
    .err()
    .expect("zero-length frame must fail");
    assert!(
        matches!(err_zero, RemoteClientError::Protocol(_)),
        "expected Protocol error for zero-length frame, got {err_zero:?}"
    );

    // 2. Declared length exceeding MAX_CONTROL_FRAME_BYTES
    let too_big = ((MAX_CONTROL_FRAME_BYTES as u32) + 1)
        .to_be_bytes()
        .to_vec();
    let addr_big = spawn_raw_ws_responder(vec![too_big]).await;
    let err_big = RemoteHostClient::connect(
        tcp_endpoint_opener(&format!("ws://{addr_big}")).unwrap(),
        "dummy-token".into(),
        "root-any",
        "ios-big-len".into(),
    )
    .await
    .err()
    .expect("oversized declared frame length must fail");
    assert!(
        matches!(err_big, RemoteClientError::Protocol(_)),
        "expected Protocol error for oversized frame length, got {err_big:?}"
    );

    // 3. Truncated frame (header declares 100 bytes, peer sends 10 bytes and closes)
    let mut truncated = 100u32.to_be_bytes().to_vec();
    truncated.extend_from_slice(b"0123456789");
    let addr_trunc = spawn_raw_ws_responder(vec![truncated]).await;
    let err_trunc = RemoteHostClient::connect(
        tcp_endpoint_opener(&format!("ws://{addr_trunc}")).unwrap(),
        "dummy-token".into(),
        "root-any",
        "ios-trunc".into(),
    )
    .await
    .err()
    .expect("truncated frame must fail with UnexpectedEof");
    match err_trunc {
        RemoteClientError::Io(io_err) => {
            assert_eq!(io_err.kind(), std::io::ErrorKind::UnexpectedEof);
        }
        other => panic!("expected UnexpectedEof Io error, got {other:?}"),
    }
}
